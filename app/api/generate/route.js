import { NextResponse } from "next/server";
import { GoogleGenAI, Type } from "@google/genai";
import pdfParse from "pdf-parse";
import mammoth from "mammoth";
import JSZip from "jszip";

export const maxDuration = 60;

const MAX_FILE_SIZE_MB = 100;
const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;
const MAX_CHARS = 90000;
const MAX_DOCX_IMAGES = 12;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MIN_QUESTIONS = 1;
const MAX_QUESTIONS = 100;
const ALLOWED_LANGUAGES = ["same", "somali", "english"];
const ALLOWED_LEVELS = ["beginner", "intermediate", "advanced"];

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
    // Ignore zip image extraction errors
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

const ENGLISH_LEARN_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    level: { type: Type.STRING },
    source_english: { type: Type.STRING },
    somali_translation: { type: Type.STRING },
    grammar_and_usage: { type: Type.STRING },
    vocabulary: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          word: { type: Type.STRING },
          somali_meaning: { type: Type.STRING },
          example_en: { type: Type.STRING },
          example_so: { type: Type.STRING },
        },
        required: ["word", "somali_meaning", "example_en", "example_so"],
      },
    },
    practice_examples: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          english: { type: Type.STRING },
          somali: { type: Type.STRING },
        },
        required: ["english", "somali"],
      },
    },
  },
  required: [
    "level",
    "source_english",
    "somali_translation",
    "grammar_and_usage",
    "vocabulary",
    "practice_examples",
  ],
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

function buildEnglishLearnPrompt({ englishInput, level, sourceBlock }) {
  const levelGuide = {
    beginner:
      "Heerka ardayga waa Bilow (Beginner / A1-A2): adeegso sharraxaad Af-Soomaali ah oo aad u fudud, ereyo aasaasi ah, iyo tusaalooyin gaagaaban oo maalinle ah.",
    intermediate:
      "Heerka ardayga waa Dhexdhexaad (Intermediate / B1-B2): bixi sharraxaad Af-Soomaali ah oo dhexdhexaad ah, sharrax qaab-dhismeedka jumladaha/tenses-ka, iyo tusaalooyin faa'iido leh.",
    advanced:
      "Heerka ardayga waa Sare (Advanced / C1-C2): bixi sharraxaad Af-Soomaali ah oo qotodheer, sharrax nuances/idioms/collocations/register, iyo tusaalooyin horumarsan.",
  };

  return `
Waxaad tahay macallin Ingiriisi iyo Af-Soomaali oo ardayga ka caawinaya barashada luqadda Ingiriisiga.
${levelGuide[level] || levelGuide.intermediate}

Haddii ardaygu soo qoray qoraal/jumlad/erey Ingiriisi ah, ku salayn taas; haddii uu soo geliyay fayl oo uusan qoraal gaar ah qorin, kasoo saar qoraal Ingiriisi ah oo waxbarasho ah faylka.
U turjun qoraalka Ingiriisiga ah Af-Soomaali sax ah oo macno leh (ha noqon turjumaad eray-erey ah oo qallafsan).
Sharrax naxwaha iyo isticmaalka (grammar_and_usage) Af-Soomaali.
Soo saar ereyo muhiim ah (vocabulary: 3 ilaa 8 erey) oo leh macnahooda Af-Soomaali iyo tusaale Ingiriisi ah + turjumaaddiisa Af-Soomaali.
Soo saar tusaalooyin dheeraad ah (practice_examples: 2 ilaa 4 jumladood) oo ku habboon heerka ardayga.

Qoraalka/su'aasha ardayga:
"""
${englishInput}
"""
${sourceBlock}
`;
}

function buildExplainPrompt({ studentQuestion, langInstruction, sourceBlock }) {
  return `
Ardayga wuxuu weydiiyay su'aashan hoose. Ha samayn su'aalo doorasho ah (multiple choice) ama A/B/C/D.
Si toos ah uga jawaab su'aasha ardayga adigoo siinaya sharraxaad faahfaahsan, faham fudud, iyo xisaab tallaabo-tallaabo ah haddii su'aashu xisaab leedahay.
Qor xisaabta adigoo adeegsanaya calaamado caadi ah (sida +, -, *, /, ^, =, x^2) oo aan lahayn backslash (\\) aan loo baahnayn.

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
Qor xisaabta adigoo adeegsanaya calaamado caadi ah (sida +, -, *, /, ^, =, x^2) oo aan lahayn backslash (\\) aan loo baahnayn.

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
    const englishInput = String(formData.get("englishInput") || "").trim();
    const rawLevel = String(formData.get("level") || "intermediate").toLowerCase();
    const level = ALLOWED_LEVELS.includes(rawLevel) ? rawLevel : "intermediate";
    const file = formData.get("file");

    const parsedCount = Number.parseInt(String(formData.get("questionCount") || "10"), 10);
    const questionCount = Number.isFinite(parsedCount)
      ? Math.min(MAX_QUESTIONS, Math.max(MIN_QUESTIONS, parsedCount))
      : 10;

    const rawLang = String(formData.get("language") || "same").toLowerCase();
    const language = ALLOWED_LANGUAGES.includes(rawLang) ? rawLang : "same";
    const langInstruction = getLanguageInstruction(language);

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
      } else if (mode !== "english_learn") {
        return NextResponse.json(
          { error: "Kaliya waxaa la aqbalayaa faylasha .pdf iyo .docx." },
          { status: 400 }
        );
      }
    }

    if (mode === "english_learn") {
      if (!englishInput && !sourceBlock && mediaParts.length === 0) {
        return NextResponse.json(
          { error: "Fadlan qor qoraal/jumlad Ingiriisi ah ama soo geli fayl." },
          { status: 400 }
        );
      }

      const promptText = buildEnglishLearnPrompt({
        englishInput: englishInput || "Extract and teach English from the attached file.",
        level,
        sourceBlock,
      });
      const contents = mediaParts.length > 0 ? [...mediaParts, promptText] : promptText;
      const response = await generateWithFallback(ai, contents, ENGLISH_LEARN_SCHEMA);
      const result = parseJsonSafe(response.text);
      return NextResponse.json(result);
    }

    if (mode === "explain") {
      if (!studentQuestion) {
        return NextResponse.json(
          { error: "Fadlan qor su'aasha aad rabto in laguu sharraxo." },
          { status: 400 }
        );
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

    if (!file || file.size === 0) {
      return NextResponse.json(
        { error: "Fadlan dooro fayl PDF (.pdf) ama Word (.docx) ah." },
        { status: 400 }
      );
    }

    const promptText = buildQuizPrompt({ questionCount, langInstruction, sourceBlock });
    const contents = mediaParts.length > 0 ? [...mediaParts, promptText] : promptText;
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
