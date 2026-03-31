// ═══════════════════════════════════════════════════════════════
//  SolverPro — script.js
// ═══════════════════════════════════════════════════════════════

// ── Backend URL ───────────────────────────────────────────────
const API_BASE = "https://homework-799a.onrender.com";

// ── Firebase config ───────────────────────────────────────────
const FIREBASE_CONFIG = {
  apiKey:            "AIzaSyACrdyTid37gig_zlcYLd5zpEtLgHjPY5g",
  authDomain:        "homeworkai-949ce.firebaseapp.com",
  projectId:         "homeworkai-949ce",
  storageBucket:     "homeworkai-949ce.firebasestorage.app",
  messagingSenderId: "655341039369",
  appId:             "1:655341039369:web:76c6559fb7798c250aadd8",
  measurementId:     "G-RQLCH7K90Q"
};

// ── Owner emails — unlimited access ──────────────────────────
const OWNER_EMAILS = [
  "osmanitrimor11@gmail.com"
];

// ── Guest daily limit ─────────────────────────────────────────
const GUEST_DAILY_LIMIT = 5;

// ── Firebase state ────────────────────────────────────────────
let auth = null;
let currentUser = null;

// ── DOM refs ──────────────────────────────────────────────────
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

// ── App state ─────────────────────────────────────────────────
let lastQuestion  = "";
let lastRawAnswer = "";
let isLoading     = false;

// ── Show/hide helpers ─────────────────────────────────────────
function showLoading() {
  if (loadingState)  loadingState.style.display  = "flex";
  if (answerSection) answerSection.style.display = "none";
}
function hideLoading() {
  if (loadingState) loadingState.style.display = "none";
}
function showAnswer() {
  if (answerSection) answerSection.style.display = "block";
}
function esc(str) {
  return String(str)
    .replace(/&/g,"&amp;")
    .replace(/</g,"&lt;")
    .replace(/>/g,"&gt;");
}

// ── Theme ─────────────────────────────────────────────────────
const savedTheme = localStorage.getItem("theme") || "dark";
document.body.dataset.theme = savedTheme;
themeToggle?.addEventListener("click", () => {
  const next = document.body.dataset.theme === "dark" ? "light" : "dark";
  document.body.dataset.theme = next;
  localStorage.setItem("theme", next);
});

// ── Firebase init ─────────────────────────────────────────────
function initFirebase() {
  try {
    if (typeof firebase === "undefined") {
      console.warn("Firebase SDK not loaded.");
      return;
    }
    if (!firebase.apps.length) {
      firebase.initializeApp(FIREBASE_CONFIG);
    }
    auth = firebase.auth();
    auth.onAuthStateChanged(handleAuthChange);
    console.log("✅ Firebase initialized");
  } catch (e) {
    console.error("Firebase init error:", e);
    showToast("Firebase failed to initialize: " + e.message);
  }
}

// ── Google sign-in ────────────────────────────────────────────
loginBtn?.addEventListener("click", async () => {
  if (!auth) {
    showToast("Auth not ready — please wait a moment and try again.");
    return;
  }
  try {
    const provider = new firebase.auth.GoogleAuthProvider();
    provider.setCustomParameters({ prompt: "select_account" });
    await auth.signInWithPopup(provider);
  } catch (e) {
    console.error("Sign-in error:", e);
    if (e.code === "auth/popup-blocked") {
      showToast("Popup blocked — allow popups for this site and try again.");
    } else if (e.code === "auth/unauthorized-domain") {
      showToast("Domain not authorized in Firebase Console. Add homework-two-beta.vercel.app to Authorized Domains.");
    } else {
      showToast("Sign-in failed: " + (e.message || e.code));
    }
  }
});

signOutBtn?.addEventListener("click", async () => {
  try { await auth?.signOut(); }
  catch (e) { showToast("Could not sign out."); }
});

function handleAuthChange(user) {
  currentUser = user || null;

  if (currentUser) {
    // signed in
    if (loginBtn)   loginBtn.hidden  = true;
    if (userMenu)   userMenu.hidden  = false;
    if (limitBar)   limitBar.hidden  = true;
    if (userAvatar) userAvatar.src   = currentUser.photoURL || "";
    if (userName)   userName.textContent = currentUser.displayName?.split(" ")[0] || "User";

    if (OWNER_EMAILS.includes(currentUser.email)) {
      showToast("Welcome back! Unlimited access active. 🚀", "success");
    }
  } else {
    // signed out
    if (loginBtn)  loginBtn.hidden = false;
    if (userMenu)  userMenu.hidden = true;
    updateLimitBar();
  }
}

// ── Owner + guest limit ───────────────────────────────────────
function isOwner() {
  return !!(currentUser && OWNER_EMAILS.includes(currentUser.email));
}

function getGuestUsage() {
  const today = new Date().toDateString();
  try {
    const s = JSON.parse(localStorage.getItem("guest_usage") || "{}");
    if (s.date !== today) return { date: today, count: 0 };
    return s;
  } catch { return { date: new Date().toDateString(), count: 0 }; }
}

function incrementGuestUsage() {
  const u = getGuestUsage();
  u.count += 1;
  localStorage.setItem("guest_usage", JSON.stringify(u));
  updateLimitBar();
}

function getRemainingQuestions() {
  if (isOwner() || currentUser) return Infinity;
  const u = getGuestUsage();
  return Math.max(0, GUEST_DAILY_LIMIT - u.count);
}

function updateLimitBar() {
  if (!limitBar) return;
  if (currentUser) { limitBar.hidden = true; return; }
  const rem = getRemainingQuestions();
  limitBar.hidden = false;
  if (limitRemaining) limitRemaining.textContent = String(rem);
}

// ── Subject detection ─────────────────────────────────────────
const SUBJECT_KW = {
  math:      ["equation","solve","calculate","integral","derivative","algebra","geometry","polynomial","prime","factor","matrix","percent","ratio","probability","statistics","calculus","divide","multiply","subtract","add"],
  science:   ["atom","molecule","cell","force","energy","velocity","acceleration","newton","einstein","dna","photosynthesis","gravity","electron","chemical","reaction","biology","physics","chemistry"],
  history:   ["war","century","civilization","empire","revolution","president","treaty","ancient","medieval","colonial","independence","democracy"],
  english:   ["grammar","sentence","paragraph","essay","poem","metaphor","simile","vocabulary","spelling","punctuation","author","novel","theme","plot"],
  geography: ["country","continent","capital","ocean","river","mountain","climate","population","latitude","longitude","region"],
};
const SUBJECT_ICONS = { math:"📐", science:"⚗️", history:"📜", english:"📚", geography:"🌍", general:"✦" };

function detectSubjectLive(q) {
  const ql = String(q).toLowerCase();
  let best = "general", bestScore = 0;
  for (const [subj, kws] of Object.entries(SUBJECT_KW)) {
    const score = kws.filter(k => ql.includes(k)).length;
    if (score > bestScore) { bestScore = score; best = subj; }
  }
  if (subjectBadge) subjectBadge.textContent = bestScore > 0 ? best : "—";
  return best;
}

// ── Input events ──────────────────────────────────────────────
questionInput?.addEventListener("input", () => {
  const len = questionInput.value.length;
  if (charCount) {
    charCount.textContent = len;
    charCount.style.color = len > 1400 ? "var(--red)" : "var(--text-3)";
  }
  detectSubjectLive(questionInput.value);
});

questionInput?.addEventListener("keydown", e => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    solveQuestion(false);
  }
});

document.querySelectorAll(".pill").forEach(pill => {
  pill.addEventListener("click", () => {
    if (!questionInput) return;
    questionInput.value = pill.dataset.example || "";
    questionInput.dispatchEvent(new Event("input"));
    questionInput.focus();
  });
});

// ── Clear ─────────────────────────────────────────────────────
clearBtn?.addEventListener("click", () => {
  if (questionInput) questionInput.value = "";
  if (charCount)     charCount.textContent = "0";
  if (subjectBadge)  subjectBadge.textContent = "—";
  hideLoading();
  if (answerSection) answerSection.style.display = "none";
  questionInput?.focus();
});

// ── Solve ─────────────────────────────────────────────────────
async function solveQuestion(simplify = false) {
  const question = questionInput?.value.trim() || "";

  if (!question)              { showToast("Please enter a question first."); return; }
  if (question.length > 1500) { showToast("Question too long (max 1500 chars)."); return; }
  if (isLoading)              return;

  if (!currentUser && getRemainingQuestions() <= 0) {
    showToast("Daily limit reached! Sign in for unlimited questions.");
    updateLimitBar();
    return;
  }

  isLoading = true;
  lastQuestion = question;
  if (solveBtn) solveBtn.disabled = true;
  showLoading();

  try {
    const res  = await fetch(`${API_BASE}/solve`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ question, simplify }),
    });

    let data;
    try { data = await res.json(); }
    catch { throw new Error("Server returned invalid response."); }

    if (res.status === 429) throw new Error(data?.error || "Too many requests. Wait a moment.");
    if (!res.ok || data?.error) throw new Error(data?.error || "Unknown server error.");

    lastRawAnswer = data.answer || "";
    const subj = data.subject || "general";

    if (subjectBadge) subjectBadge.textContent = subj;
    const iconEl = document.getElementById("answerSubjectIcon");
    if (iconEl) iconEl.textContent = SUBJECT_ICONS[subj] || "✦";

    renderAnswer(lastRawAnswer);
    showAnswer();
    renderMath();

    if (!simplify) {
      if (!currentUser) incrementGuestUsage();
      addToHistory(question, subj);
    }

  } catch (e) {
    console.error("Solve error:", e);
    showToast(e.message || "Something went wrong. Please try again.");
  } finally {
    isLoading = false;
    if (solveBtn) solveBtn.disabled = false;
    hideLoading();
  }
}

solveBtn?.addEventListener("click",    () => solveQuestion(false));
simplifyBtn?.addEventListener("click", () => solveQuestion(true));

// ── Render answer ─────────────────────────────────────────────
function renderInline(text) {
  return esc(text)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/`(.+?)`/g, `<code style="font-family:var(--font-mono);background:var(--bg-3);padding:0.1rem 0.35rem;border-radius:4px;font-size:0.88em;">$1</code>`);
}

function renderAnswer(raw) {
  if (!answerBody) return;
  answerBody.innerHTML = "";
  const lines = String(raw).split("\n").filter(l => l.trim());
  let delay = 0;

  for (const line of lines) {
    const trimmed = line.trim();

    if (/^summary:/i.test(trimmed)) {
      const div = document.createElement("div");
      div.className = "summary-block";
      div.innerHTML = `<strong>Summary:</strong> ${renderInline(trimmed.replace(/^summary:\s*/i,""))}`;
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

// ── KaTeX ─────────────────────────────────────────────────────
function renderMath() {
  if (typeof renderMathInElement === "undefined" || !answerBody) return;
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
  } catch(e) { console.warn("KaTeX:", e); }
}

// ── Copy ──────────────────────────────────────────────────────
copyBtn?.addEventListener("click", async () => {
  if (!lastRawAnswer) return;
  try {
    await navigator.clipboard.writeText(lastRawAnswer);
    copyBtn.textContent = "✓ Copied!";
    copyBtn.classList.add("copied");
    showToast("Copied!", "success");
    setTimeout(() => { copyBtn.textContent = "📋 Copy"; copyBtn.classList.remove("copied"); }, 2000);
  } catch { showToast("Copy failed — select manually."); }
});

// ── PDF ───────────────────────────────────────────────────────
pdfBtn?.addEventListener("click", () => {
  if (!lastRawAnswer || !window.jspdf) return;
  const { jsPDF } = window.jspdf;
  const doc   = new jsPDF({ unit:"mm", format:"a4" });
  const pageW = doc.internal.pageSize.getWidth();
  const margin = 20, maxW = pageW - margin*2;
  let y = 25;

  doc.setFillColor(124,109,250);
  doc.rect(0, 0, pageW, 15, "F");
  doc.setTextColor(255,255,255);
  doc.setFontSize(10); doc.setFont("helvetica","bold");
  doc.text("SolverPro — AI Homework Solver", margin, 10);
  doc.setFont("helvetica","normal"); doc.setFontSize(8);
  doc.text(new Date().toLocaleDateString("en-US",{year:"numeric",month:"long",day:"numeric"}), pageW-margin, 10, {align:"right"});
  y = 28;

  doc.setFontSize(11); doc.setFont("helvetica","bold"); doc.setTextColor(20,20,30);
  doc.text("Question:", margin, y); y += 6;
  doc.setFont("helvetica","normal"); doc.setFontSize(10); doc.setTextColor(60,60,80);
  const qLines = doc.splitTextToSize(lastQuestion, maxW);
  doc.text(qLines, margin, y); y += qLines.length*5.5+6;

  doc.setDrawColor(124,109,250); doc.setLineWidth(0.5);
  doc.line(margin, y, pageW-margin, y); y += 7;

  doc.setFontSize(11); doc.setFont("helvetica","bold"); doc.setTextColor(20,20,30);
  doc.text("Answer:", margin, y); y += 7;

  for (const line of lastRawAnswer.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (y > 270) { doc.addPage(); y = 20; }
    const isStep    = /^step\s*\d+/i.test(trimmed);
    const isSummary = /^summary:/i.test(trimmed);
    if (isStep) {
      doc.setFont("helvetica","bold"); doc.setTextColor(80,60,200);
      doc.setFillColor(240,238,255);
      const w = doc.splitTextToSize(trimmed, maxW-4);
      doc.roundedRect(margin-2, y-4, maxW+4, w.length*5.5+4, 2, 2, "F");
      doc.text(w, margin+2, y); y += w.length*5.5+5;
    } else if (isSummary) {
      doc.setFont("helvetica","bolditalic"); doc.setTextColor(20,20,30);
      const w = doc.splitTextToSize(trimmed, maxW);
      doc.text(w, margin, y); y += w.length*5.5+4;
    } else {
      doc.setFont("helvetica","normal"); doc.setTextColor(60,60,80);
      const w = doc.splitTextToSize(trimmed, maxW);
      doc.text(w, margin, y); y += w.length*5.5+3;
    }
  }

  doc.setFontSize(8); doc.setTextColor(150); doc.setFont("helvetica","italic");
  doc.text("Generated by SolverPro — homework-two-beta.vercel.app", margin, 287);
  doc.save(`homework-answer-${Date.now()}.pdf`);
  showToast("PDF downloaded!", "success");
});

// ── Share ─────────────────────────────────────────────────────
shareBtn?.addEventListener("click", async () => {
  if (!lastRawAnswer) return;
  const text = `Q: ${lastQuestion}\n\nA: ${lastRawAnswer}`;
  if (navigator.share) {
    try { await navigator.share({ title:"Homework Answer", text }); return; } catch {}
  }
  try {
    await navigator.clipboard.writeText(window.location.href);
    showToast("Link copied!", "success");
  } catch { showToast("Share failed."); }
});

// ── History ───────────────────────────────────────────────────
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
  if (!h.length) { historySection.style.display = "none"; return; }
  historySection.style.display = "block";
  historyList.innerHTML = "";
  h.forEach(entry => {
    const li = document.createElement("li");
    li.className = "history-item";
    li.innerHTML = `
      <span class="history-q">${esc(entry.question.slice(0,80))}${entry.question.length>80?"…":""}</span>
      <span class="history-subj">${esc(entry.subject)}</span>`;
    li.addEventListener("click", () => {
      if (!questionInput) return;
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

// ── Toast ─────────────────────────────────────────────────────
function showToast(msg, type = "error") {
  document.querySelector(".toast")?.remove();
  const t = document.createElement("div");
  t.className = `toast${type === "success" ? " success" : ""}`;
  t.textContent = msg;
  document.body.appendChild(t);
  requestAnimationFrame(() => requestAnimationFrame(() => t.classList.add("show")));
  setTimeout(() => { t.classList.remove("show"); setTimeout(() => t.remove(), 400); }, 3500);
}

// ── Init ──────────────────────────────────────────────────────
hideLoading();
if (answerSection) answerSection.style.display = "none";
if (historySection) historySection.style.display = "none";
updateLimitBar();
renderHistory();
initFirebase();
