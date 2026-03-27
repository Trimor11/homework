/* ═══════════════════════════════════════════════════════════════
   AI Homework Solver Pro — script.js
   Features: solve, simplify, history, dark mode, share, copy
═══════════════════════════════════════════════════════════════ */

// ── Config ─────────────────────────────────────────────────────
// Replace with your Render backend URL after deployment
const API_BASE = "https://your-backend.onrender.com";
// const API_BASE = "http://localhost:5000"; // for local dev

// ── DOM refs ───────────────────────────────────────────────────
const questionInput  = document.getElementById("questionInput");
const charCount      = document.getElementById("charCount");
const solveBtn       = document.getElementById("solveBtn");
const clearBtn       = document.getElementById("clearBtn");
const loadingState   = document.getElementById("loadingState");
const answerSection  = document.getElementById("answerSection");
const answerBody     = document.getElementById("answerBody");
const copyBtn        = document.getElementById("copyBtn");
const shareBtn       = document.getElementById("shareBtn");
const simplifyBtn    = document.getElementById("simplifyBtn");
const historySection = document.getElementById("historySection");
const historyList    = document.getElementById("historyList");
const clearHistoryBtn= document.getElementById("clearHistoryBtn");
const themeToggle    = document.getElementById("themeToggle");
const subjectBadge   = document.getElementById("subjectBadge");

// ── State ──────────────────────────────────────────────────────
let lastQuestion    = "";
let lastRawAnswer   = "";
let currentSubject  = "";
let isLoading       = false;

// ── Theme ──────────────────────────────────────────────────────
const savedTheme = localStorage.getItem("theme") || "dark";
document.body.dataset.theme = savedTheme;

themeToggle?.addEventListener("click", () => {
  const next = document.body.dataset.theme === "dark" ? "light" : "dark";
  document.body.dataset.theme = next;
  localStorage.setItem("theme", next);
});

// ── Char counter ───────────────────────────────────────────────
questionInput?.addEventListener("input", () => {
  const len = questionInput.value.length;
  charCount.textContent = len;
  charCount.style.color = len > 1400 ? "var(--error)" : "var(--text-secondary)";
  detectSubjectLive(questionInput.value);
});

// ── Client-side subject detection (mirrors backend) ────────────
const SUBJECT_KW = {
  math:      ["equation","solve","calculate","integral","derivative","algebra","geometry","polynomial","prime","factor","matrix","percent","ratio","probability","statistics","calculus"],
  science:   ["atom","molecule","cell","force","energy","velocity","acceleration","newton","einstein","dna","photosynthesis","gravity","electron","chemical","reaction","biology","physics","chemistry","element"],
  history:   ["war","century","civilization","empire","revolution","president","treaty","ancient","medieval","colonial","independence","democracy"],
  english:   ["grammar","sentence","paragraph","essay","poem","metaphor","simile","vocabulary","spelling","punctuation","author","novel","theme","plot"],
  geography: ["country","continent","capital","ocean","river","mountain","climate","population","latitude","longitude","region","territory"],
};
const SUBJECT_ICONS = { math:"📐", science:"⚗️", history:"📜", english:"📚", geography:"🌍", general:"✦" };

function detectSubjectLive(q) {
  const ql = q.toLowerCase();
  let best = "general", bestScore = 0;
  for (const [subj, kws] of Object.entries(SUBJECT_KW)) {
    const score = kws.filter(k => ql.includes(k)).length;
    if (score > bestScore) { bestScore = score; best = subj; }
  }
  currentSubject = bestScore > 0 ? best : "general";
  if (subjectBadge) subjectBadge.textContent = currentSubject;
  return currentSubject;
}

// ── Subject pill fill ──────────────────────────────────────────
document.querySelectorAll(".pill").forEach(pill => {
  pill.addEventListener("click", () => {
    questionInput.value = pill.dataset.example;
    questionInput.dispatchEvent(new Event("input"));
    questionInput.focus();
  });
});

// ── Clear ──────────────────────────────────────────────────────
clearBtn?.addEventListener("click", () => {
  questionInput.value = "";
  charCount.textContent = "0";
  subjectBadge.textContent = "—";
  answerSection.hidden = true;
  loadingState.hidden  = true;
  questionInput.focus();
});

// ── Solve ──────────────────────────────────────────────────────
async function solveQuestion(simplify = false) {
  const question = questionInput.value.trim();
  if (!question) { showToast("Please enter a question first."); return; }
  if (question.length > 1500) { showToast("Question too long (max 1500 chars)."); return; }
  if (isLoading) return;

  isLoading = true;
  lastQuestion = question;
  solveBtn.disabled = true;
  loadingState.hidden  = false;
  answerSection.hidden = true;

  try {
    const res = await fetch(`${API_BASE}/solve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question, simplify }),
    });
    const data = await res.json();

    if (!res.ok || data.error) {
      throw new Error(data.error || "Unknown error.");
    }

    lastRawAnswer = data.answer;
    const subj = data.subject || "general";
    if (subjectBadge) subjectBadge.textContent = subj;
    const icon = SUBJECT_ICONS[subj] || "✦";
    document.getElementById("answerSubjectIcon").textContent = icon;

    renderAnswer(data.answer);
    answerSection.hidden = false;

    if (!simplify) addToHistory(question, subj);

  } catch (err) {
    showToast(err.message || "Something went wrong. Please try again.");
  } finally {
    isLoading = false;
    solveBtn.disabled = false;
    loadingState.hidden = true;
  }
}

solveBtn?.addEventListener("click", () => solveQuestion(false));
simplifyBtn?.addEventListener("click", () => solveQuestion(true));

questionInput?.addEventListener("keydown", e => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) solveQuestion(false);
});

// ── Render answer ──────────────────────────────────────────────
function renderAnswer(raw) {
  answerBody.innerHTML = "";

  const lines  = raw.split("\n").filter(l => l.trim());
  let stepDelay = 0;

  for (const line of lines) {
    const trimmed = line.trim();

    // Summary line
    if (/^summary:/i.test(trimmed)) {
      const div = document.createElement("div");
      div.className = "summary-block";
      div.innerHTML = `<strong>Summary:</strong> ${esc(trimmed.replace(/^summary:\s*/i, ""))}`;
      answerBody.appendChild(div);
      continue;
    }

    // Step line
    const stepMatch = trimmed.match(/^(step\s*\d+[:.]?\s*)/i);
    if (stepMatch) {
      const stepLabel = stepMatch[1].trim();
      const content   = trimmed.slice(stepLabel.length).trim();
      const div = document.createElement("div");
      div.className = "step";
      div.style.animationDelay = `${stepDelay}ms`;
      div.innerHTML = `
        <span class="step-number">${esc(stepLabel)}</span>
        <span class="step-content">${esc(content)}</span>
      `;
      answerBody.appendChild(div);
      stepDelay += 80;
      continue;
    }

    // Plain paragraph
    const p = document.createElement("p");
    p.textContent = trimmed;
    p.style.marginBottom = "0.75rem";
    answerBody.appendChild(p);
  }
}

function esc(str) {
  return str.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

// ── Copy ───────────────────────────────────────────────────────
copyBtn?.addEventListener("click", async () => {
  if (!lastRawAnswer) return;
  try {
    await navigator.clipboard.writeText(lastRawAnswer);
    copyBtn.textContent = "✓ Copied!";
    copyBtn.classList.add("copied");
    showToast("Answer copied!", "success");
    setTimeout(() => { copyBtn.textContent = "📋 Copy"; copyBtn.classList.remove("copied"); }, 2000);
  } catch {
    showToast("Copy failed — please select text manually.");
  }
});

// ── Share ──────────────────────────────────────────────────────
shareBtn?.addEventListener("click", async () => {
  const text = `Q: ${lastQuestion}\n\nA: ${lastRawAnswer}`;
  if (navigator.share) {
    try { await navigator.share({ title: "Homework Answer", text }); }
    catch {}
  } else {
    await navigator.clipboard.writeText(window.location.href);
    showToast("Link copied to clipboard!", "success");
  }
});

// ── History ────────────────────────────────────────────────────
const HISTORY_KEY = "solver_history";
const MAX_HISTORY = 10;

function loadHistory() {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY)) || []; }
  catch { return []; }
}
function saveHistory(h) {
  localStorage.setItem(HISTORY_KEY, JSON.stringify(h));
}
function addToHistory(question, subject) {
  const h = loadHistory();
  const entry = { question, subject, ts: Date.now() };
  const filtered = h.filter(e => e.question !== question);
  filtered.unshift(entry);
  const trimmed = filtered.slice(0, MAX_HISTORY);
  saveHistory(trimmed);
  renderHistory();
}
function renderHistory() {
  const h = loadHistory();
  if (!historySection || !historyList) return;
  if (h.length === 0) { historySection.hidden = true; return; }

  historySection.hidden = false;
  historyList.innerHTML = "";

  h.forEach(entry => {
    const li = document.createElement("li");
    li.className = "history-item";
    li.innerHTML = `
      <span class="history-q">${esc(entry.question.slice(0, 80))}${entry.question.length > 80 ? "…" : ""}</span>
      <span class="history-subj">${esc(entry.subject)}</span>
    `;
    li.addEventListener("click", () => {
      questionInput.value = entry.question;
      questionInput.dispatchEvent(new Event("input"));
      questionInput.scrollIntoView({ behavior: "smooth" });
    });
    historyList.appendChild(li);
  });
}

clearHistoryBtn?.addEventListener("click", () => {
  localStorage.removeItem(HISTORY_KEY);
  renderHistory();
});

// ── Toast ──────────────────────────────────────────────────────
function showToast(msg, type = "error") {
  const existing = document.querySelector(".toast");
  if (existing) existing.remove();
  const t = document.createElement("div");
  t.className = `toast${type === "success" ? " success" : ""}`;
  t.textContent = msg;
  document.body.appendChild(t);
  requestAnimationFrame(() => { requestAnimationFrame(() => t.classList.add("show")); });
  setTimeout(() => { t.classList.remove("show"); setTimeout(() => t.remove(), 400); }, 3000);
}

// ── Init ───────────────────────────────────────────────────────
renderHistory();