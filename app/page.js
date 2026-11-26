"use client";

import { useState } from "react";

const QUICK_COUNTS = [5, 10, 25, 50, 100];

const LANGUAGE_LABELS = {
  same: "Sida luqadda faylka",
  somali: "Af-Soomaali",
  english: "English",
};

export default function HomePage() {
  const [activeTab, setActiveTab] = useState("explain");
  const [studentQuestion, setStudentQuestion] = useState("");
  const [file, setFile] = useState(null);
  const [inputKey, setInputKey] = useState(0);
  const [questionCount, setQuestionCount] = useState(10);
  const [language, setLanguage] = useState("same");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [data, setData] = useState(null);
  const [explanationResult, setExplanationResult] = useState(null);
  const [selectedAnswers, setSelectedAnswers] = useState({});
  const [revealedQuestions, setRevealedQuestions] = useState({});

  function handleCountChange(val) {
    const num = Number.parseInt(String(val), 10);
    if (Number.isNaN(num)) {
      setQuestionCount(1);
      return;
    }
    setQuestionCount(Math.min(100, Math.max(1, num)));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    setData(null);
    setExplanationResult(null);
    setSelectedAnswers({});
    setRevealedQuestions({});

    if (activeTab === "explain") {
      if (!studentQuestion.trim()) {
        setError("Fadlan qor su'aasha aad rabto in laguu sharraxo oo laguu fahamsiiyo.");
        return;
      }
    } else if (!file) {
      setError("Fadlan marka hore soo xulo fayl (.pdf ama .docx).");
      return;
    }

    const finalCount = Math.min(100, Math.max(1, Number(questionCount) || 5));

    setLoading(true);
    try {
      const formData = new FormData();
      formData.append("mode", activeTab);
      formData.append("language", language);
      if (file) {
        formData.append("file", file);
      }
      if (activeTab === "explain") {
        formData.append("studentQuestion", studentQuestion.trim());
      } else {
        formData.append("questionCount", String(finalCount));
      }

      const res = await fetch("/api/generate", {
        method: "POST",
        body: formData,
      });

      const json = await res.json();
      if (!res.ok) {
        setError(json.error || "Waxba lagama soo saari waayay.");
      } else if (activeTab === "explain") {
        setExplanationResult(json);
      } else {
        setData(json);
      }
    } catch {
      setError("Xiriirka server-ka ayaa go'ay.");
    } finally {
      setLoading(false);
    }
  }

  function handleSelectOption(qId, optionText) {
    const letter = optionText.trim().charAt(0).toUpperCase();
    setSelectedAnswers((prev) => ({ ...prev, [qId]: letter }));
    setRevealedQuestions((prev) => ({ ...prev, [qId]: true }));
  }

  function handleRevealAnswer(qId) {
    setRevealedQuestions((prev) => ({ ...prev, [qId]: true }));
  }

  function handleReset() {
    setFile(null);
    setStudentQuestion("");
    setInputKey((k) => k + 1);
    setError("");
    setData(null);
    setExplanationResult(null);
    setSelectedAnswers({});
    setRevealedQuestions({});
  }

  const fileExtension = file?.name?.toLowerCase().endsWith(".pdf")
    ? "PDF (.pdf)"
    : file?.name?.toLowerCase().endsWith(".docx")
    ? "Word (.docx)"
    : "—";

  const fileSizeMb = file ? `${(file.size / (1024 * 1024)).toFixed(2)} MB` : "—";

  const questions = Array.isArray(data?.questions) ? data.questions : [];
  const correctCount = questions.reduce((acc, q, index) => {
    const qKey = q.id ?? index + 1;
    return selectedAnswers[qKey] === q.correct_answer ? acc + 1 : acc;
  }, 0);
  const answeredCount = Object.keys(selectedAnswers).length;
  const scorePercent =
    questions.length > 0 ? Math.round((correctCount / questions.length) * 100) : 0;

  const explainMathSteps = Array.isArray(explanationResult?.math_steps)
    ? explanationResult.math_steps
    : [];
  const takeaways = Array.isArray(explanationResult?.key_takeaways)
    ? explanationResult.key_takeaways
    : [];

  return (
    <main className="app-container">
      <header className="card hero-header">
        <div>
          <span className="badge">AI Study Studio • Direct Explanation &amp; Quiz</span>
          <h1 className="hero-title">AI Study Summary &amp; Quiz</h1>
          <p className="hero-subtitle">
            Weydii su&apos;aal toos ah si aad u hesho <strong>faahfaahin buuxda iyo faham cad</strong>{" "}
            (iyadoo aan lahayn doorashooyin), ama soo geli fayl <strong>.pdf</strong> /{" "}
            <strong>.docx</strong> si aad u hesho koobid iyo su&apos;aalo.
          </p>
        </div>

        {(data || explanationResult || file || studentQuestion || error) && (
          <button type="button" onClick={handleReset} className="btn-secondary">
            Dib u bilow
          </button>
        )}
      </header>

      <form onSubmit={handleSubmit} className="card form-card">
        <div className="mode-tabs">
          <button
            type="button"
            onClick={() => {
              setActiveTab("explain");
              setError("");
            }}
            className={`mode-tab-btn ${activeTab === "explain" ? "active" : ""}`}
          >
            Su&apos;aal &amp; Sharraxaad Toos Ah (Aan Doorasho Lahayn)
          </button>
          <button
            type="button"
            onClick={() => {
              setActiveTab("quiz");
              setError("");
            }}
            className={`mode-tab-btn ${activeTab === "quiz" ? "active" : ""}`}
          >
            Summary &amp; Su&apos;aalo Doorasho Ah
          </button>
        </div>

        {activeTab === "explain" && (
          <div className="option-box">
            <label htmlFor="student-question-input" className="option-label">
              Qor Su&apos;aasha Ardayga (Xisaab, Faham, ama Mawduuc Kasta)
            </label>
            <textarea
              id="student-question-input"
              value={studentQuestion}
              onChange={(e) => setStudentQuestion(e.target.value)}
              placeholder="Tusaale: Sidee loo xalliyaa 3x + 2y = 24 marka y = 3, ama sharrax sida uu u shaqeeyo Active Recall..."
              className="question-textarea"
            />
            <p className="option-hint">
              Wuxuu soo saarayaa jawaab toos ah, faahfaahin buuxda, qodobbo faham, iyo tallaabooyin xisaabeed — doorasho ma lahan.
            </p>
          </div>
        )}

        <div className="drop-zone">
          <div>
            <p className="drop-zone-title">
              {activeTab === "explain"
                ? "Fayl Tixraac Ah (.pdf ama .docx — Ikhtiyaari)"
                : "Dooro Faylka Waxbarashada (.pdf ama .docx)"}
            </p>
            <p className="drop-zone-meta">
              {file
                ? `La doortay: ${file.name} (${fileSizeMb})`
                : activeTab === "explain"
                ? "Waxaad ku xiri kartaa fayl haddii su'aashu ka timaaddo dukumiinti gaar ah"
                : "Ugu badnaan 100 MB • Qoraal, xisaab, ama sawirro ha lahaado"}
            </p>
          </div>
          <input
            key={inputKey}
            type="file"
            accept=".pdf,.docx"
            onChange={(e) => setFile(e.target.files?.[0] || null)}
          />
        </div>

        {file && (
          <div className="file-meta-card">
            <div className="file-meta-item">
              <span className="file-meta-label">Magaca Faylka</span>
              <span className="file-meta-value">{file.name}</span>
            </div>
            <div className="file-meta-item">
              <span className="file-meta-label">Nooca Faylka</span>
              <span className="file-meta-value">{fileExtension}</span>
            </div>
            <div className="file-meta-item">
              <span className="file-meta-label">Cabbirka</span>
              <span className="file-meta-value">{fileSizeMb}</span>
            </div>
            <div className="file-meta-item">
              <span className="file-meta-label">Xulashada</span>
              <span className="file-meta-value">
                {activeTab === "explain"
                  ? `Sharraxaad Toos Ah • ${LANGUAGE_LABELS[language] || language}`
                  : `${questionCount} Su'aal • ${LANGUAGE_LABELS[language] || language}`}
              </span>
            </div>
          </div>
        )}

        <div className="options-grid">
          {activeTab === "quiz" && (
            <div className="option-box">
              <div className="option-top">
                <label htmlFor="question-count-input" className="option-label">
                  Tirada Su&apos;aalaha (1 – 100)
                </label>
                <input
                  id="question-count-input"
                  type="number"
                  min={1}
                  max={100}
                  value={questionCount}
                  onChange={(e) => handleCountChange(e.target.value)}
                  className="number-input"
                />
              </div>

              <div className="quick-pills">
                {QUICK_COUNTS.map((cnt) => (
                  <button
                    key={cnt}
                    type="button"
                    onClick={() => setQuestionCount(cnt)}
                    className={`pill-btn ${questionCount === cnt ? "active" : ""}`}
                  >
                    {cnt}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="option-box">
            <label htmlFor="language-select" className="option-label">
              Luqadda Jawaabta &amp; Fahanka
            </label>
            <select
              id="language-select"
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
              className="select-input"
            >
              <option value="same">Sida luqadda faylka / su&apos;aasha (Auto)</option>
              <option value="somali">Af-Soomaali</option>
              <option value="english">English</option>
            </select>
            <p className="option-hint">
              Dooro luqadda aad rabto in sharraxaadda lagu qoro.
            </p>
          </div>
        </div>

        <div className="form-actions">
          <button type="submit" disabled={loading} className="btn-primary">
            {loading
              ? activeTab === "explain"
                ? "Waa la sharraxayaa..."
                : `Waa la farsamaynayaa (${questionCount} su'aal)...`
              : activeTab === "explain"
              ? "Soo Saar Faahfaahin & Faham"
              : `Samee Summary & ${questionCount} Su'aalood`}
          </button>
        </div>
      </form>

      {error && <div className="error-banner">{error}</div>}

      {explanationResult && (
        <section className="card explain-result-card">
          <h2 className="section-heading">Faahfaahinta &amp; Fahanka Su&apos;aasha</h2>
          <p className="q-title" style={{ marginBottom: "14px" }}>
            {explanationResult.question || studentQuestion}
          </p>

          {explanationResult.direct_answer && (
            <div className="direct-answer-box">
              <p className="direct-answer-label">Jawaabta Tooska Ah</p>
              <p className="direct-answer-text">{explanationResult.direct_answer}</p>
            </div>
          )}

          {explanationResult.detailed_explanation && (
            <div>
              <h3 className="math-card-title">Sharraxaad Faahfaahsan</h3>
              <p className="summary-text">{explanationResult.detailed_explanation}</p>
            </div>
          )}

          {takeaways.length > 0 && (
            <div className="math-card">
              <h3 className="math-card-title">Qodobbada Muhiimka Ah Ee Fahanka</h3>
              <ul className="takeaways-list">
                {takeaways.map((item, idx) => (
                  <li key={idx}>{item}</li>
                ))}
              </ul>
            </div>
          )}

          {explainMathSteps.length > 0 && (
            <div className="math-steps-box" style={{ marginTop: "16px" }}>
              <p className="math-steps-heading">Tallaabooyinka Xisaabta</p>
              <ol className="math-steps-list">
                {explainMathSteps.map((step, sIdx) => (
                  <li key={sIdx}>{step}</li>
                ))}
              </ol>
            </div>
          )}
        </section>
      )}

      {data?.summary && (
        <section className="card">
          <h2 className="section-heading">Koobidda Faylka (Summary)</h2>
          <p className="summary-text">{data.summary}</p>

          {data?.math_summary && (
            <div className="math-card">
              <h3 className="math-card-title">Xisaabta &amp; Natiijooyinka Faahfaahsan</h3>
              <p className="summary-text">{data.math_summary}</p>
            </div>
          )}
        </section>
      )}

      {questions.length > 0 && (
        <section className="quiz-wrapper">
          <div className="score-card">
            <div className="score-header">
              <div>
                <h2 className="section-heading" style={{ margin: 0 }}>
                  Su&apos;aalaha Hubinta Fahamka ({questions.length})
                </h2>
                <p className="score-sub">
                  {answeredCount} ka mid ah {questions.length} su&apos;aalood ayaad ka jawaabtay
                </p>
              </div>
              <div>
                <div className="score-value">
                  {correctCount} / {questions.length} Sax
                </div>
                <div className="score-percent">Natiijada: {scorePercent}%</div>
              </div>
            </div>

            <div className="progress-track">
              <div
                className="progress-fill"
                style={{ width: `${scorePercent}%` }}
              />
            </div>
          </div>

          <div className="questions-stack">
            {questions.map((q, index) => {
              const qKey = q.id ?? index + 1;
              const userChoice = selectedAnswers[qKey];
              const isRevealed = Boolean(revealedQuestions[qKey]);
              const isCorrect = userChoice === q.correct_answer;
              const mathSteps = Array.isArray(q.math_steps) ? q.math_steps : [];

              return (
                <article key={qKey} className="card">
                  <p className="q-title">
                    <span className="q-number">{index + 1}</span>
                    {q.question}
                  </p>

                  <div className="options-stack">
                    {(q.options || []).map((opt, idx) => {
                      const letter = String(opt).trim().charAt(0).toUpperCase();
                      const isSelected = userChoice === letter;
                      const isRightOption = q.correct_answer === letter;

                      let extraClass = "";
                      if (isRevealed) {
                        if (isRightOption) extraClass = "correct";
                        else if (isSelected) extraClass = "wrong";
                        else extraClass = "dimmed";
                      }

                      return (
                        <button
                          key={idx}
                          type="button"
                          onClick={() => handleSelectOption(qKey, opt)}
                          className={`option-btn ${extraClass}`}
                        >
                          {opt}
                        </button>
                      );
                    })}
                  </div>

                  {!isRevealed && (
                    <button
                      type="button"
                      onClick={() => handleRevealAnswer(qKey)}
                      className="reveal-btn"
                    >
                      Ma garanayo / I tus jawaabta
                    </button>
                  )}

                  {isRevealed && (
                    <div
                      className={`explanation-box ${isCorrect ? "correct" : "wrong"}`}
                    >
                      <p
                        className={`explanation-status ${isCorrect ? "correct" : "wrong"}`}
                      >
                        {userChoice
                          ? isCorrect
                            ? "Waad saxday!"
                            : `Waa khalad. Jawaabta saxda ah waa ${q.correct_answer}.`
                          : `Jawaabta saxda ah waa ${q.correct_answer}.`}
                      </p>
                      {q.explanation && (
                        <p className="explanation-body">{q.explanation}</p>
                      )}

                      {mathSteps.length > 0 && (
                        <div className="math-steps-box">
                          <p className="math-steps-heading">Tallaabooyinka Xisaabta</p>
                          <ol className="math-steps-list">
                            {mathSteps.map((step, sIdx) => (
                              <li key={sIdx}>{step}</li>
                            ))}
                          </ol>
                        </div>
                      )}
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        </section>
      )}
    </main>
  );
}
