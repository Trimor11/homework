// ═══════════════════════════════════════════════════════════════
//  AI Homework Solver Pro — script.js
// ═══════════════════════════════════════════════════════════════

// ── Backend URL ─────────────────────────────────────────────────
const API_BASE = "https://homework-799a.onrender.com";

// ── Firebase config — PASTE YOUR VALUES HERE ────────────────────
const FIREBASE_CONFIG = {
  apiKey:            "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",
  authDomain:        "homeworkai-949ce.firebaseapp.com",
  projectId:         "homeworkai-949ce",
  storageBucket:     "https://homework-two-beta.vercel.app/.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId:             "1:655341039369:android:693336a35089a8130aadd8D"
};

// ── Owner emails — these accounts have unlimited questions ───────
const OWNER_EMAILS = [
  "osmanitrimor11@gmail.com"   // ← replace with your Google email
];

// ── Guest question limit per day ─────────────────────────────────
const GUEST_DAILY_LIMIT = 5;

// ── Init Firebase ────────────────────────────────────────────────
let auth = null;
let currentUser = null;

try {
  firebase.initializeApp(FIREBASE_CONFIG);
  auth = firebase.auth();
  auth.onAuthStateChanged(handleAuthChange);
} catch (e) {
  console.warn("Firebase not configured yet:", e.message);
}

// ── DOM refs ──────────────────────────────────────────────────────
const questionInput   = document.getElementById("questionInput");
const charCount       = document.getElementById("charCount");
const solveBtn        = document.getElementById("solveBtn");
const clearBtn        = document.getElementById("clearBtn");
const loadingState    = document.getElementById("loadingState");
const answerSection   = document.getElementById("answerSection");
const answerBody      = document.getElementById("answerBody");
const copyBtn         = document.getElementById("copyBtn");
const shareBtn        = document.getElementById("shareBtn");
const simplifyBtn     = document.getElementById("simplifyBtn");
const pdfBtn          = document.getElementById("pdfBtn");
const historySection  = document.getElementById("historySection");
const historyList     = document.getElementById("historyList");
const clearHistoryBtn = document.getElementById("clearHistoryBtn");
const themeToggle     = document.getElementById("themeToggle");
const subjectBadge    = document.getElementById("subjectBadge");
const loginBtn        = document.getElementById("loginBtn");
const signOutBtn      = document.getElementById("signOutBtn");
const userMenu        = document.getElementById("userMenu");
const userAvatar      = document.getElementById("userAvatar");
const userName        = document.getElementById("userName");
const limitBar        = document.getElementById("limitBar");
const limitRemaining  = document.getElementById("limitRemaining");

// ── State ─────────────────────────────────────────────────────────
let lastQuestion  = "";
let lastRawAnswer = "";
let isLoading     = false;

// ── Show/hide helpers ─────────────────────────────────────────────
function showLoading() {
  loadingState.style.display = "flex";
  answerSection.style.display = "none";
}
function hideLoading() {
  loadingState.style.display = "none";
}
function showAnswer() {
  answerSection.style.display = "block";
}

// ── Theme ─────────────────────────────────────────────────────────
const savedTheme = localStorage.getItem("theme") || "dark";
document.body.dataset.theme = savedTheme;
themeToggle?.addEventListener("click", () => {
  const next = document.body.dataset.theme === "dark" ? "light" : "dark";
  document.body.dataset.theme = next;
  localStorage.setItem("theme", next);
});

// ── Google Auth ───────────────────────────────────────────────────
loginBtn?.addEventListener("click", async () => {
  if (!auth) { showToast("Firebase not configured yet."); return; }
  const provider = new firebase.auth.GoogleAuthProvider();
  try {
    await auth.signInWithPopup(provider);
  } catch (e) {
    showToast("Sign in failed. Please try again.");
    console.error(e);
  }
});

signOutBtn?.addEventListener("click", () => auth?.signOut());

function handleAuthChange(user) {
  currentUser = user;
  if (user) {
    loginBtn.hidden      = true;
    userMenu.hidden      = false;
    userAvatar.src       = user.photoURL || "";
    userName.textContent = user.displayName?.split(" ")[0] || "User";
    limitBar.hidden      = true;

    // welcome owner
    if (OWNER_EMAILS.includes(user.email)) {
      showToast("Welcome back, owner! Unlimited access active.", "success");
    }
  } else {
    loginBtn.hidden = false;
    userMenu.hidden = true;
    updateLimitBar();
  }
}

// ── Owner + guest limit checks ────────────────────────────────────
function isOwner() {
  return currentUser && OWNER_EMAILS.includes(currentUser.email);
}

function getGuestUsage() {
  const today = new Date().toDateString();
  try {
    const stored = JSON.parse(localStorage.getItem("guest_usage") || "{}");
    if (stored.date !== today) return { date: today, count: 0 };
    return stored;
  } catch { return { date: new Date().toDateString(), count: 0 }; }
}

function incrementGuestUsage() {
  const usage = getGuestUsage();
  usage.count += 1;
  localStorage.setItem("guest_usage", JSON.stringify(usage));
  updateLimitBar();
}

function getRemainingQuestions() {
  if (isOwner()) return Infinity;   // owner = unlimited
  if (currentUser) return Infinity; // any logged in user = unlimited
  const usage = getGuestUsage();
  return Math.max(0, GUEST_DAILY_LIMIT - usage.count);
}

function updateLimitBar() {
  if (currentUser) { limitBar.hidden = true; return; }
  const remaining = getRemainingQuestions();
  limitBar.hidden = false;
  if (limitRemaining) limitRemaining.textContent = remaining;
}

// ── Char counter ──────────────────────────────────────────────────
questionInput?.addEventListener("input", () => {
  const len = questionInput.value.length;
  charCount.textContent = len;
  charCount.style.color = len > 1400 ? "var(--error)" : "var(--text-secondary)";
  detectSubjectLive(questionInput.value);
});

// ── Subject detection ─────────────────────────────────────────────
const SUBJECT_KW = {
  math:      ["equation","solve","calculate","integral","derivative","algebra","geometry","polynomial","prime","factor","matrix","percent","ratio","probability","statistics","calculus","divide","multiply","subtract","add"],
  science:   ["atom","molecule","cell","force","energy","velocity","acceleration","newton","einstein","dna","photosynthesis","gravity","electron","chemical","reaction","biology","physics","chemistry"],
  history:   ["war","century","civilization","empire","revolution","president","treaty","ancient","medieval","colonial","independence","democracy"],
  english:   ["grammar","sentence","paragraph","essay","poem","metaphor","simile","vocabulary","spelling","punctuation","author","novel","theme","plot"],
  geography: ["country","continent","capital","ocean","river","mountain","climate","population","latitude","longitude","region"],
};
const SUBJECT_ICONS = { math:"📐", science:"⚗️", history:"📜", english:"📚", geography:"🌍", general:"✦" };

function detectSubjectLive(q) {
  const ql = q.toLowerCase();
  let best = "general", bestScore = 0;
  for (const [subj, kws] of Object.entries(SUBJECT_KW)) {
    const score = kws.filter(k => ql.includes(k)).length;
    if (score > bestScore) { bestScore = score; best = subj; }
  }
  if (subjectBadge) subjectBadge.textContent = bestScore > 0 ? best : "—";
  return best;
}

// ── Subject pills ─────────────────────────────────────────────────
document.querySelectorAll(".pill").forEach(pill => {
  pill.addEventListener("click", () => {
    questionInput.value = pill.dataset.example;
    questionInput.dispatchEvent(new Event("input"));
    questionInput.focus();
  });
});

// ── Clear ─────────────────────────────────────────────────────────
clearBtn?.addEventListener("click", () => {
  questionInput.value = "";
  charCount.textContent = "0";
  if (subjectBadge) subjectBadge.textContent = "—";
  hideLoading();
  answerSection.style.display = "none";
  questionInput.focus();
});

// ── Solve ─────────────────────────────────────────────────────────
async function solveQuestion(simplify = false) {
  const question = questionInput.value.trim();
  if (!question)              { showToast("Please enter a question first."); return; }
  if (question.length > 1500) { showToast("Question too long (max 1500 chars)."); return; }
  if (isLoading)              return;

  // block guests who hit limit (logged in users + owner always pass)
  if (!currentUser && getRemainingQuestions() <= 0) {
    showToast("Daily limit reached! Sign in for unlimited questions.");
    updateLimitBar();
    return;
  }

  isLoading = true;
  lastQuestion = question;
  solveBtn.disabled = true;
  showLoading();

  try {
    const res  = await fetch(`${API_BASE}/solve`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ question, simplify }),
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || "Unknown error.");

    lastRawAnswer = data.answer;
    const subj = data.subject || "general";
    if (subjectBadge) subjectBadge.textContent = subj;
    const iconEl = document.getElementById("answerSubjectIcon");
    if (iconEl) iconEl.textContent = SUBJECT_ICONS[subj] || "✦";

    renderAnswer(data.answer);
    showAnswer();
    renderMath();

    if (!simplify) {
      if (!currentUser) incrementGuestUsage();
      addToHistory(question, subj);
    }

  } catch (err) {
    showToast(err.message || "Something went wrong. Please try again.");
  } finally {
    isLoading = false;
    solveBtn.disabled = false;
    hideLoading();
  }
}

solveBtn?.addEventListener("click",    () => solveQuestion(false));
simplifyBtn?.addEventListener("click", () => solveQuestion(true));
questionInput?.addEventListener("keydown", e => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) solveQuestion(false);
});

// ── Render answer ─────────────────────────────────────────────────
function renderAnswer(raw) {
  answerBody.innerHTML = "";
  const lines = raw.split("\n").filter(l => l.trim());
  let delay = 0;

  for (const line of lines) {
    const trimmed = line.trim();

    if (/^summary:/i.test(trimmed)) {
      const div = document.createElement("div");
      div.className = "summary-block";
      div.innerHTML = `<strong>Summary:</strong> ${renderInline(trimmed.replace(/^summary:\s*/i, ""))}`;
      answerBody.appendChild(div);
      continue;
    }

    const stepMatch = trimmed.match(/^(step\s*\d+[:.]?\s*)/i);
    if (stepMatch) {
      const label   = stepMatch[1].trim();
      const content = trimmed.slice(label.length).trim();
      const div = document.createElement("div");
      div.className = "step";
      div.style.animationDelay = `${delay}ms`;
      div.innerHTML = `<span class="step-number">${esc(label)}</span><span class="step-content">${renderInline(content)}</span>`;
      answerBody.appendChild(div);
      delay += 100;
      continue;
    }

    if (trimmed) {
      const p = document.createElement("p");
      p.innerHTML = renderInline(trimmed);
      answerBody.appendChild(p);
    }
  }
}

function renderInline(text) {
  return esc(text)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/`(.+?)`/g, `<code style="font-family:var(--font-mono);background:var(--bg-surface);padding:0.1rem 0.35rem;border-radius:4px;font-size:0.88em;">$1</code>`);
}

function esc(str) {
  return String(str).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

// ── KaTeX math rendering ──────────────────────────────────────────
function renderMath() {
  if (typeof renderMathInElement === "undefined") return;
  try {
    renderMathInElement(answerBody, {
      delimiters: [
        { left: "$$", right: "$$", display: true  },
        { left: "$",  right: "$",  display: false },
        { left: "\\(", right: "\\)", display: false },
        { left: "\\[", right: "\\]", display: true  },
      ],
      throwOnError: false,
    });
  } catch (e) {
    console.warn("KaTeX error:", e);
  }
}

// ── Copy ──────────────────────────────────────────────────────────
copyBtn?.addEventListener("click", async () => {
  if (!lastRawAnswer) return;
  try {
    await navigator.clipboard.writeText(lastRawAnswer);
    copyBtn.textContent = "✓ Copied!";
    copyBtn.classList.add("copied");
    showToast("Copied!", "success");
    setTimeout(() => { copyBtn.textContent = "📋 Copy"; copyBtn.classList.remove("copied"); }, 2000);
  } catch {
    showToast("Copy failed — select text manually.");
  }
});

// ── PDF export ────────────────────────────────────────────────────
pdfBtn?.addEventListener("click", () => {
  if (!lastRawAnswer) return;
  const { jsPDF } = window.jspdf;
  const doc    = new jsPDF({ unit: "mm", format: "a4" });
  const pageW  = doc.internal.pageSize.getWidth();
  const margin = 20;
  const maxW   = pageW - margin * 2;
  let   y      = 25;

  // Header bar
  doc.setFillColor(232, 160, 74);
  doc.rect(0, 0, pageW, 15, "F");
  doc.setTextColor(13, 12, 11);
  doc.setFontSize(10);
  doc.setFont("helvetica", "bold");
  doc.text("SolverPro — AI Homework Solver", margin, 10);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  doc.setTextColor(80);
  doc.text(new Date().toLocaleDateString("en-US", { year:"numeric", month:"long", day:"numeric" }), pageW - margin, 10, { align: "right" });

  y = 28;

  // Question
  doc.setFontSize(11); doc.setFont("helvetica","bold"); doc.setTextColor(13,12,11);
  doc.text("Question:", margin, y); y += 6;
  doc.setFont("helvetica","normal"); doc.setFontSize(10); doc.setTextColor(60,60,60);
  const qLines = doc.splitTextToSize(lastQuestion, maxW);
  doc.text(qLines, margin, y); y += qLines.length * 5.5 + 6;

  // Divider
  doc.setDrawColor(232,160,74); doc.setLineWidth(0.5);
  doc.line(margin, y, pageW - margin, y); y += 7;

  // Answer
  doc.setFontSize(11); doc.setFont("helvetica","bold"); doc.setTextColor(13,12,11);
  doc.text("Answer:", margin, y); y += 7;

  for (const line of lastRawAnswer.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (y > 270) { doc.addPage(); y = 20; }

    const isStep    = /^step\s*\d+/i.test(trimmed);
    const isSummary = /^summary:/i.test(trimmed);

    if (isStep) {
      doc.setFont("helvetica","bold"); doc.setTextColor(180,100,20);
      doc.setFillColor(252,242,228);
      const wrapped = doc.splitTextToSize(trimmed, maxW - 4);
      doc.roundedRect(margin-2, y-4, maxW+4, wrapped.length*5.5+4, 2, 2, "F");
      doc.text(wrapped, margin+2, y); y += wrapped.length*5.5+5;
    } else if (isSummary) {
      doc.setFont("helvetica","bolditalic"); doc.setTextColor(13,12,11);
      const wrapped = doc.splitTextToSize(trimmed, maxW);
      doc.text(wrapped, margin, y); y += wrapped.length*5.5+4;
    } else {
      doc.setFont("helvetica","normal"); doc.setTextColor(60,60,60);
      const wrapped = doc.splitTextToSize(trimmed, maxW);
      doc.text(wrapped, margin, y); y += wrapped.length*5.5+3;
    }
  }

  // Footer
  doc.setFontSize(8); doc.setTextColor(150); doc.setFont("helvetica","italic");
  doc.text("Generated by SolverPro — homework-two-beta.vercel.app", margin, 287);
  doc.save(`homework-answer-${Date.now()}.pdf`);
  showToast("PDF downloaded!", "success");
});

// ── Share ─────────────────────────────────────────────────────────
shareBtn?.addEventListener("click", async () => {
  const text = `Q: ${lastQuestion}\n\nA: ${lastRawAnswer}`;
  if (navigator.share) {
    try { await navigator.share({ title: "Homework Answer", text }); } catch {}
  } else {
    await navigator.clipboard.writeText(window.location.href);
    showToast("Link copied!", "success");
  }
});

// ── History ───────────────────────────────────────────────────────
const HISTORY_KEY = "solver_history";
const MAX_HISTORY = 10;

function loadHistory() {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY)) || []; }
  catch { return []; }
}
function saveHistory(h) { localStorage.setItem(HISTORY_KEY, JSON.stringify(h)); }

function addToHistory(question, subject) {
  const h = loadHistory().filter(e => e.question !== question);
  h.unshift({ question, subject, ts: Date.now() });
  saveHistory(h.slice(0, MAX_HISTORY));
  renderHistory();
}

function renderHistory() {
  if (!historySection || !historyList) return;
  const h = loadHistory();
  if (h.length === 0) { historySection.style.display = "none"; return; }
  historySection.style.display = "block";
  historyList.innerHTML = "";
  h.forEach(entry => {
    const li = document.createElement("li");
    li.className = "history-item";
    li.innerHTML = `
      <span class="history-q">${esc(entry.question.slice(0,80))}${entry.question.length>80?"…":""}</span>
      <span class="history-subj">${esc(entry.subject)}</span>`;
    li.addEventListener("click", () => {
      questionInput.value = entry.question;
      questionInput.dispatchEvent(new Event("input"));
      questionInput.scrollIntoView({ behavior:"smooth" });
    });
    historyList.appendChild(li);
  });
}

clearHistoryBtn?.addEventListener("click", () => {
  localStorage.removeItem(HISTORY_KEY);
  renderHistory();
});

// ── Toast ─────────────────────────────────────────────────────────
function showToast(msg, type = "error") {
  document.querySelector(".toast")?.remove();
  const t = document.createElement("div");
  t.className = `toast${type === "success" ? " success" : ""}`;
  t.textContent = msg;
  document.body.appendChild(t);
  requestAnimationFrame(() => requestAnimationFrame(() => t.classList.add("show")));
  setTimeout(() => { t.classList.remove("show"); setTimeout(() => t.remove(), 400); }, 3000);
}

// ── Init ──────────────────────────────────────────────────────────
hideLoading();
answerSection.style.display = "none";
updateLimitBar();
renderHistory();
