export const maxDuration = 60;

import { NextResponse } from "next/server";
import { GoogleGenAI, Type } from "@google/genai";
import pdfParse from "pdf-parse";
import mammoth from "mammoth";
import JSZip from "jszip";

const MAX_FILE_SIZE_MB = 100;
const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;
const MAX_CHARS = 90000;
const MAX_DOCX_IMAGES = 12;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024; // 4 MB per image
const MIN_QUESTIONS = 1;
const MAX_QUESTIONS = 100;
const ALLOWED_LANGUAGES = ["same", "somali", "english"];

const MODEL_CANDIDATES = [
  "gemini-3.5-flash-lite",
  "gemini-3.8-flash",
  "gemini-3.5-flash",
  "gemini-3.0-flash",
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableError(err) {
  const msg = String(err?.message || "");
  return (
    msg.includes("503") ||
    msg.includes("UNAVAILABLE") ||
    msg.includes("429") ||
    msg.includes("high demand") ||
    msg.includes("overloaded")
  );
}

function isNotFoundError(err) {
  const msg = String(err?.message || "");
  return msg.includes("404") || msg.includes("NOT_FOUND");
}

function repairInvalidJsonEscapes(str) {
  let out = "";
  let inString = false;
  let i = 0;

  while (i < str.length) {
    const ch = str[i];

    if (ch === '"' && (i === 0 || str[i - 1] !== "\\")) {
      inString = !inString;
      out += ch;
      i++;
      continue;
    }

    if (inString && ch === "\\") {
      const next = str[i + 1];
      if (next === undefined) {
        out += "\\\\";
        i++;
        continue;
      }
      if (next === "u") {
        const hex = str.slice(i + 2, i + 6);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          out += "\\u" + hex;
          i += 6;
          continue;
        }
        out += "\\\\u";
        i += 2;
        continue;
      }
      if (['"', "\\", "/", "b", "f", "n", "r", "t"].includes(next)) {
        out += ch + next;
        i += 2;
        continue;
      }
      // Escape invalid JSON backslash such as \frac or \times
      out += "\\\\" + next;
      i += 2;
      continue;
    }

    out += ch;
    i++;
  }

  return out;
}

function parseJsonSafe(rawText) {
  const cleaned = String(rawText || "")
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    const repaired = repairInvalidJsonEscapes(cleaned);
    return JSON.parse(repaired);
  }
}

function detectImageMimeType(entryName) {
  const lower = entryName.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  return null;
}

async function extractDocxImages(buffer) {
  const images = [];
  try {
    const zip = await JSZip.loadAsync(buffer);
    const mediaEntries = Object.values(zip.files)
      .filter((entry) => !entry.dir && entry.name.toLowerCase().startsWith("word/media/"))
      .sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of mediaEntries) {
      if (images.length >= MAX_DOCX_IMAGES) break;
      const mimeType = detectImageMimeType(entry.name);
      if (!mimeType) continue;

      const imgBuffer = await entry.async("nodebuffer");
      if (!imgBuffer || imgBuffer.length === 0 || imgBuffer.length > MAX_IMAGE_BYTES) {
        continue;
      }

      images.push({
        inlineData: {
          mimeType,
          data: imgBuffer.toString("base64"),
        },
      });
    }
  } catch {
    // Ignore zip image extraction errors and continue with text if available
  }
  return images;
}

const EXPLAIN_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    question: { type: Type.STRING },
    direct_answer: { type: Type.STRING },
    detailed_explanation: { type: Type.STRING },
    key_takeaways: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
    },
    math_steps: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
    },
  },
  required: ["question", "direct_answer", "detailed_explanation", "key_takeaways", "math_steps"],
};

const QUIZ_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    summary: { type: Type.STRING },
    math_summary: { type: Type.STRING },
    questions: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          id: { type: Type.INTEGER },
          question: { type: Type.STRING },
          options: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
          },
          correct_answer: { type: Type.STRING },
          explanation: { type: Type.STRING },
          math_steps: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
          },
        },
        required: ["id", "question", "options", "correct_answer", "explanation", "math_steps"],
      },
    },
  },
  required: ["summary", "math_summary", "questions"],
};

async function generateWithFallback(ai, contents, responseSchema) {
  let lastError = null;

  for (const model of MODEL_CANDIDATES) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        return await ai.models.generateContent({
          model,
          contents,
          config: {
            responseMimeType: "application/json",
            responseSchema,
          },
        });
      } catch (err) {
        lastError = err;
        if (isNotFoundError(err)) {
          break;
        }
        if (isRetryableError(err) && attempt < 2) {
          await sleep(attempt * 1500);
          continue;
        }
        if (isRetryableError(err)) {
          break;
        }
        throw err;
      }
    }
  }

  throw lastError || new Error("Dhammaan model-yadu hadda way mashquulsan yihiin.");
}

function getLanguageInstruction(language) {
  if (language === "somali") {
    return "Qor jawaabta, faahfaahinta, qodobbada fahanka, koobidda, iyo tallaabooyinka xisaabta dhammaantood Af-Soomaali cad oo sax ah.";
  }
  if (language === "english") {
    return "Write the answer, detailed explanation, key takeaways, summary, and math steps clearly in English.";
  }
  return "Aqoonso luqadda uu qoraalka faylku ama su'aashu ku qoran tahay (tusaale Af-Soomaali, English, ama Carabi), kadibna jawaabta, faahfaahinta, qodobbada fahanka, koobidda, iyo tallaabooyinka xisaabta ku qor isla luqaddaas.";
}

function buildSourceBlock({ trimmedText = "", hasImages = false, isPdfDirect = false }) {
  if (isPdfDirect) {
    return "\nFadlan u fiirso faylka PDF-ka ee lifaaqan (oo ay ku jiri karaan bogag sawir ah, qoraal, ama xisaab) si aad jawaabta iyo fahanka uga dhisto.";
  }
  if (trimmedText && hasImages) {
    return `\nQoraalka faylka:\n"""\n${trimmedText}\n"""\nSidoo kale waxaa lifaaqan sawirrada ku jira faylka—isticmaal qoraalka iyo sawirrada labadaba si aad u hesho faham sax ah.`;
  }
  if (trimmedText) {
    return `\nQoraalka faylka:\n"""\n${trimmedText}\n"""`;
  }
  if (hasImages) {
    return "\nFadlan akhri sawirrada lifaaqan ee laga soo saaray faylka kana soo saar xogta, qoraallada, iyo xisaabta ku jirta.";
  }
  return "";
}

function buildExplainPrompt({ studentQuestion, langInstruction, sourceBlock }) {
  return `
Ardayga wuxuu weydiiyay su'aashan hoose. Ha samayn su'aalo doorasho ah (multiple choice) ama A/B/C/D.
Si toos ah uga jawaab su'aasha ardayga adigoo siinaya sharraxaad faahfaahsan, faham fudud, iyo xisaab tallaabo-tallaabo ah haddii su'aashu xisaab leedahay.
Qor xisaabta adigoo adeegsanaya calaamado caadi ah (sida +, -, *, /, ^, =, x^2) oo aan lahayn backslash (\) aan loo baahnayn.

Su'aasha ardayga:
"""
${studentQuestion}
"""

Tilmaanta luqadda:
${langInstruction}
${sourceBlock}
`;
}

function buildQuizPrompt({ questionCount, langInstruction, sourceBlock }) {
  return `
Akhri xogtan hoose, kadibna samee koobid iyo ${questionCount} su'aalood oo doorasho ah (multiple choice) oo ku salaysan faylkan.
Qor xisaabta adigoo adeegsanaya calaamado caadi ah (sida +, -, *, /, ^, =, x^2) oo aan lahayn backslash (\) aan loo baahnayn.

Tilmaanta luqadda:
${langInstruction}
${sourceBlock}
`;
}

export async function POST(req) {
  try {
    if (!process.env.GEMINI_API_KEY) {
      return NextResponse.json(
        { error: "GEMINI_API_KEY kuma jiro faylka .env.local." },
        { status: 400 }
      );
    }

    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const formData = await req.formData();

    const mode = String(formData.get("mode") || "quiz").toLowerCase();
    const studentQuestion = String(formData.get("studentQuestion") || "").trim();
    const file = formData.get("file");

    const parsedCount = Number.parseInt(String(formData.get("questionCount") || "10"), 10);
    const questionCount = Number.isFinite(parsedCount)
      ? Math.min(MAX_QUESTIONS, Math.max(MIN_QUESTIONS, parsedCount))
      : 10;

    const rawLang = String(formData.get("language") || "same").toLowerCase();
    const language = ALLOWED_LANGUAGES.includes(rawLang) ? rawLang : "same";
    const langInstruction = getLanguageInstruction(language);

    if (mode === "explain") {
      if (!studentQuestion) {
        return NextResponse.json(
          { error: "Fadlan qor su'aasha aad rabto in laguu sharraxo." },
          { status: 400 }
        );
      }

      let sourceBlock = "";
      let mediaParts = [];

      if (file && file.size > 0) {
        if (file.size > MAX_FILE_SIZE_BYTES) {
          return NextResponse.json(
            { error: `Faylku wuxuu ka weyn yahay ${MAX_FILE_SIZE_MB} MB.` },
            { status: 400 }
          );
        }

        const arrayBuffer = await file.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        const fileName = file.name.toLowerCase();

        if (fileName.endsWith(".pdf")) {
          let extractedText = "";
          try {
            const pdfData = await pdfParse(buffer);
            extractedText = (pdfData.text || "").replace(/\s+/g, " ").trim();
          } catch {
            extractedText = "";
          }

          if (extractedText.length >= 120) {
            sourceBlock = buildSourceBlock({ trimmedText: extractedText.slice(0, MAX_CHARS) });
          } else {
            mediaParts = [
              {
                inlineData: {
                  mimeType: "application/pdf",
                  data: buffer.toString("base64"),
                },
              },
            ];
            sourceBlock = buildSourceBlock({ isPdfDirect: true });
          }
        } else if (fileName.endsWith(".docx")) {
          const docData = await mammoth.extractRawText({ buffer });
          const extractedText = (docData.value || "").replace(/\s+/g, " ").trim();
          const images = await extractDocxImages(buffer);
          mediaParts = images;
          sourceBlock = buildSourceBlock({
            trimmedText: extractedText.slice(0, MAX_CHARS),
            hasImages: images.length > 0,
          });
        }
      }

      const promptText = buildExplainPrompt({
        studentQuestion,
        langInstruction,
        sourceBlock,
      });
      const contents = mediaParts.length > 0 ? [...mediaParts, promptText] : promptText;
      const response = await generateWithFallback(ai, contents, EXPLAIN_SCHEMA);
      const result = parseJsonSafe(response.text);
      return NextResponse.json(result);
    }

    if (!file) {
      return NextResponse.json(
        { error: "Fadlan dooro fayl PDF (.pdf) ama Word (.docx) ah." },
        { status: 400 }
      );
    }

    if (file.size > MAX_FILE_SIZE_BYTES) {
      return NextResponse.json(
        { error: `Faylku wuxuu ka weyn yahay ${MAX_FILE_SIZE_MB} MB.` },
        { status: 400 }
      );
    }

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const fileName = file.name.toLowerCase();

    let contents;

    if (fileName.endsWith(".pdf")) {
      let extractedText = "";
      try {
        const pdfData = await pdfParse(buffer);
        extractedText = (pdfData.text || "").replace(/\s+/g, " ").trim();
      } catch {
        extractedText = "";
      }

      if (extractedText.length >= 120) {
        const sourceBlock = buildSourceBlock({ trimmedText: extractedText.slice(0, MAX_CHARS) });
        contents = buildQuizPrompt({ questionCount, langInstruction, sourceBlock });
      } else {
        const base64Pdf = buffer.toString("base64");
        const sourceBlock = buildSourceBlock({ isPdfDirect: true });
        contents = [
          {
            inlineData: {
              mimeType: "application/pdf",
              data: base64Pdf,
            },
          },
          buildQuizPrompt({ questionCount, langInstruction, sourceBlock }),
        ];
      }
    } else if (fileName.endsWith(".docx")) {
      const docData = await mammoth.extractRawText({ buffer });
      const extractedText = (docData.value || "").replace(/\s+/g, " ").trim();
      const images = await extractDocxImages(buffer);

      if (extractedText.length < 50 && images.length === 0) {
        return NextResponse.json(
          {
            error:
              "Qoraal ama sawirro la akhriyi karo lagama helin faylkan Word-ka ah.",
          },
          { status: 400 }
        );
      }

      const sourceBlock = buildSourceBlock({
        trimmedText: extractedText.slice(0, MAX_CHARS),
        hasImages: images.length > 0,
      });
      const promptText = buildQuizPrompt({ questionCount, langInstruction, sourceBlock });
      contents = images.length > 0 ? [...images, promptText] : promptText;
    } else {
      return NextResponse.json(
        { error: "Kaliya waxaa la aqbalayaa faylasha .pdf iyo .docx." },
        { status: 400 }
      );
    }

    const response = await generateWithFallback(ai, contents, QUIZ_SCHEMA);
    const result = parseJsonSafe(response.text);
    if (Array.isArray(result.questions) && result.questions.length > questionCount) {
      result.questions = result.questions.slice(0, questionCount);
    }
    return NextResponse.json(result);
  } catch (err) {
    console.error("Generate error:", err);
    const message = err?.message || "Khalad aan la garanayn ayaa dhacay.";
    return NextResponse.json(
      { error: `Khalad ayaa dhacay: ${message}` },
      { status: 500 }
    );
  }
}

