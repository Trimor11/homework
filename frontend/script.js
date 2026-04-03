// ═══════════════════════════════════════════════════════════════
//  AI Homework Solver Pro — SAFE script.js
// ═══════════════════════════════════════════════════════════════

// ── Backend URL ───────────────────────────────────────────────
const DEFAULT_API_BASE = "https://homework-799a.onrender.com";
const API_BASE = resolveApiBase();

function resolveApiBase() {
  const globalBase =
    window.__API_BASE ||
    window.__APP_CONFIG__?.apiBase ||
    window.__ENV__?.API_BASE ||
    window.__APP_ENV__?.API_BASE;

  if (globalBase) return globalBase;

  const scriptEl = document.currentScript || document.querySelector("script[data-api-base]");
  if (scriptEl?.dataset?.apiBase) {
    return scriptEl.dataset.apiBase;
  }

  return DEFAULT_API_BASE;
}

// ── Firebase config ───────────────────────────────────────────
// Put ONLY your Firebase web app config here.
// DO NOT put Groq / OpenAI / Stripe secret keys here.
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyACrdyTid37gig_zlcYLd5zpEtLgHjPY5g",
  authDomain: "homeworkai-949ce.firebaseapp.com",
  projectId: "homeworkai-949ce",
  storageBucket: "homeworkai-949ce.firebasestorage.app",
  messagingSenderId: "655341039369",
  appId: "1:655341039369:web:76c6559fb7798c250aadd8",
  measurementId: "G-RQLCH7K90Q",
};

// ── Owner emails — unlimited access ───────────────────────────
const OWNER_EMAILS = [
  "osmanitrimor11@gmail.com"
];

// ── Guest question limit per day ──────────────────────────────
const GUEST_DAILY_LIMIT = 5;

// ── Firebase state ────────────────────────────────────────────
let auth = null;
let currentUser = null;
let firebaseReady = false;
const FIREBASE_INIT_RETRY_MS = 500;
const MAX_FIREBASE_INIT_ATTEMPTS = 5;
let firebaseInitAttempts = 0;
let firebaseInitFailed = false;

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
const managePlanBtn   = document.getElementById("managePlanBtn");
const proCheckoutButtons = document.querySelectorAll("[data-action='start-pro-checkout']");
const portalButtons      = document.querySelectorAll("[data-action='open-portal']");
const fileInput       = document.getElementById("fileInput");
const uploadBtn       = document.getElementById("uploadBtn");
const uploadList      = document.getElementById("uploadList");
const modeToggle      = document.getElementById("modeToggle");
const sourcesSection  = document.getElementById("sourcesSection");
const sourcesList     = document.getElementById("sourcesList");
const navToggle          = document.getElementById("navToggle");
const mobileNav          = document.getElementById("mobileNav");
const mobileNavClose     = document.getElementById("mobileNavClose");
const mobileLoginShortcut = document.getElementById("mobileLoginShortcut");
const mobileSolveShortcut = document.getElementById("mobileSolveShortcut");
const mobileNavLinks = mobileNav ? Array.from(mobileNav.querySelectorAll("[data-nav-link]")) : [];

// ── App state ─────────────────────────────────────────────────
let lastQuestion  = "";
let lastRawAnswer = "";
let isLoading     = false;
let userTier      = "free";
const conversationTurns = [];
const CONVO_KEY = "solver_conversation";
const MAX_CONTEXT_TURNS = 6;
const MAX_CONTEXT_QUESTION_CHARS = 900;
const MAX_CONTEXT_ANSWER_CHARS = 1800;
const attachedFiles = [];
const MAX_UPLOADS = 3;
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB
let selectedMode = "answer";
let lastSources = [];

function clearQuestionField(shouldFocus = true) {
  if (!questionInput) return;
  questionInput.value = "";
  questionInput.dispatchEvent(new Event("input"));
  if (subjectBadge) subjectBadge.textContent = "—";
  resetAttachments();
  if (shouldFocus) {
    questionInput.focus();
  }
}

function getConversationContext() {
  if (!conversationTurns.length) return [];
  return conversationTurns
    .slice(-MAX_CONTEXT_TURNS)
    .map((turn) => ({
      question: String(turn.question || "").slice(0, MAX_CONTEXT_QUESTION_CHARS),
      answer: String(turn.answer || "").slice(0, MAX_CONTEXT_ANSWER_CHARS),
    }));
}

function rememberConversationTurn(question, answer) {
  if (!question || !answer) return;
  conversationTurns.push({ question, answer });
  if (conversationTurns.length > MAX_CONTEXT_TURNS) {
    conversationTurns.splice(0, conversationTurns.length - MAX_CONTEXT_TURNS);
  }
  persistConversationMemory();
}

function resetConversation() {
  conversationTurns.length = 0;
  try {
    localStorage.removeItem(CONVO_KEY);
  } catch (error) {
    console.warn("Conversation memory clear failed:", error);
  }
}

function uniqueId() {
  if (window.crypto?.randomUUID) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function renderUploads() {
  if (!uploadList) return;
  uploadList.innerHTML = "";
  if (!attachedFiles.length) {
    const p = document.createElement("p");
    p.className = "upload-empty";
    p.textContent = "No files attached.";
    uploadList.appendChild(p);
    return;
  }
  for (const item of attachedFiles) {
    const chip = document.createElement("div");
    chip.className = "upload-chip";
    chip.dataset.id = item.id;
    chip.innerHTML = `
      <span>${esc(item.file.name)}</span>
      <button type="button" class="upload-remove" data-remove="${item.id}" aria-label="Remove file">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>
      </button>
    `;
    uploadList.appendChild(chip);
  }
}

function resetAttachments() {
  attachedFiles.length = 0;
  renderUploads();
}

function handleSelectedFiles(fileList) {
  if (!fileList || !fileList.length) return;
  const files = Array.from(fileList);
  for (const file of files) {
    if (attachedFiles.length >= MAX_UPLOADS) {
      showToast(`Max ${MAX_UPLOADS} files per question.`);
      break;
    }
    if (!file.type?.includes("image") && file.type !== "application/pdf") {
      showToast("Only images or PDFs are supported.");
      continue;
    }
    if (file.size > MAX_FILE_SIZE) {
      showToast(`${file.name} is larger than 5MB.`);
      continue;
    }
    attachedFiles.push({ id: uniqueId(), file });
  }
  renderUploads();
}

function selectMode(mode) {
  selectedMode = mode;
  modeToggle?.querySelectorAll(".mode-option").forEach((btn) => {
    const active = btn.dataset.mode === mode;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-selected", active ? "true" : "false");
  });
}

function renderSources(sources) {
  lastSources = Array.isArray(sources) ? sources : [];
  if (!sourcesSection || !sourcesList) return;
  if (!lastSources.length) {
    sourcesSection.hidden = true;
    sourcesList.innerHTML = "";
    return;
  }
  sourcesSection.hidden = false;
  sourcesList.innerHTML = "";
  lastSources.forEach((source) => {
    const card = document.createElement("div");
    card.className = "source-card";
    const title = source.title || source.url || "Source";
    const snippet = source.snippet || "";
    const url = source.url || "";
    card.innerHTML = `
      <strong>${esc(title)}</strong>
      <p>${esc(snippet)}</p>
      ${url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(url)}</a>` : ""}
    `;
    sourcesList.appendChild(card);
  });
}

function persistConversationMemory() {
  try {
    const payload = conversationTurns
      .slice(-MAX_CONTEXT_TURNS)
      .map((turn) => ({
        question: String(turn.question || "").slice(0, MAX_CONTEXT_QUESTION_CHARS),
        answer: String(turn.answer || "").slice(0, MAX_CONTEXT_ANSWER_CHARS),
      }));
    localStorage.setItem(CONVO_KEY, JSON.stringify(payload));
  } catch (error) {
    console.warn("Conversation memory save failed:", error);
  }
}

function loadConversationMemory() {
  try {
    const stored = JSON.parse(localStorage.getItem(CONVO_KEY) || "[]");
    if (!Array.isArray(stored) || !stored.length) {
      return;
    }
    conversationTurns.push(
      ...stored
        .slice(-MAX_CONTEXT_TURNS)
        .filter((entry) => entry?.question && entry?.answer)
        .map((entry) => ({
          question: String(entry.question).slice(0, MAX_CONTEXT_QUESTION_CHARS),
          answer: String(entry.answer).slice(0, MAX_CONTEXT_ANSWER_CHARS),
        }))
    );
  } catch (error) {
    console.warn("Conversation memory load failed:", error);
  }
}

function isMobileNavOpen() {
  return mobileNav?.classList.contains("open");
}

function setMobileNav(open) {
  if (!mobileNav || !navToggle) return;
  mobileNav.classList.toggle("open", open);
  mobileNav.setAttribute("aria-hidden", open ? "false" : "true");
  navToggle.setAttribute("aria-expanded", open ? "true" : "false");
  document.body.classList.toggle("nav-open", open);
}

function toggleMobileNav(force) {
  const nextState = typeof force === "boolean" ? force : !isMobileNavOpen();
  setMobileNav(nextState);
}

function closeMobileNav() {
  if (isMobileNavOpen()) {
    setMobileNav(false);
  }
}

// ── Helpers ───────────────────────────────────────────────────
function showLoading() {
  if (loadingState) loadingState.style.display = "flex";
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
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function isPlaceholder(value) {
  return (
    !value ||
    value.includes("YOUR_") ||
    value.includes("your_") ||
    value === "YOUR_PROJECT_ID.firebaseapp.com" ||
    value === "YOUR_PROJECT_ID.appspot.com"
  );
}

function isValidFirebaseConfig(config) {
  if (!config || typeof config !== "object") return false;

  const required = [
    "apiKey",
    "authDomain",
    "projectId",
    "storageBucket",
    "messagingSenderId",
    "appId",
  ];

  for (const key of required) {
    if (!config[key] || isPlaceholder(config[key])) return false;
  }

  // Prevent obvious secret-key mistakes in frontend
  if (String(config.apiKey).startsWith("gsk_")) return false;   // Groq
  if (String(config.apiKey).startsWith("sk-")) return false;    // OpenAI-style
  if (String(config.apiKey).includes("https://")) return false; // malformed
  if (String(config.storageBucket).includes("http")) return false;

  return true;
}

function showFirebaseSetupAlert(message) {
  firebaseInitFailed = true;
  if (message) {
    showToast(message);
  } else {
    showToast("Sign-in is unavailable right now. Please try again later.");
  }
  console.warn(message || "Firebase auth is not configured.");
}

function hideFirebaseSetupAlert() {
  firebaseInitFailed = false;
}

// ── Theme ─────────────────────────────────────────────────────
const savedTheme = localStorage.getItem("theme") || "dark";
document.body.dataset.theme = savedTheme;
if (!document.body.dataset.auth) {
  document.body.dataset.auth = "guest";
}
if (!document.body.dataset.plan) {
  document.body.dataset.plan = "free";
}

themeToggle?.addEventListener("click", () => {
  const nextTheme = document.body.dataset.theme === "dark" ? "light" : "dark";
  document.body.dataset.theme = nextTheme;
  localStorage.setItem("theme", nextTheme);
});

modeToggle?.addEventListener("click", (event) => {
  const target = event.target.closest(".mode-option");
  if (!target) return;
  const mode = target.dataset.mode || "answer";
  selectMode(mode);
});

uploadBtn?.addEventListener("click", () => fileInput?.click());
fileInput?.addEventListener("change", (event) => {
  handleSelectedFiles(event.target.files);
  fileInput.value = "";
});

uploadList?.addEventListener("click", (event) => {
  const removeBtn = event.target.closest("[data-remove]");
  if (!removeBtn) return;
  const id = removeBtn.dataset.remove;
  const idx = attachedFiles.findIndex((item) => item.id === id);
  if (idx >= 0) {
    attachedFiles.splice(idx, 1);
    renderUploads();
  }
});

navToggle?.addEventListener("click", () => toggleMobileNav());
mobileNavClose?.addEventListener("click", () => closeMobileNav());
mobileNav?.addEventListener("click", (event) => {
  if (event.target === mobileNav) {
    closeMobileNav();
  }
});
mobileNavLinks.forEach((link) =>
  link.addEventListener("click", () => closeMobileNav())
);
window.addEventListener("resize", () => {
  if (window.innerWidth >= 769) {
    closeMobileNav();
  }
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && isMobileNavOpen()) {
    closeMobileNav();
  }
});
mobileLoginShortcut?.addEventListener("click", () => {
  closeMobileNav();
  loginBtn?.click();
});
mobileSolveShortcut?.addEventListener("click", () => {
  closeMobileNav();
  questionInput?.scrollIntoView({ behavior: "smooth", block: "center" });
  questionInput?.focus();
});

// ── Firebase init ─────────────────────────────────────────────
function initFirebase() {
  try {
    if (typeof firebase === "undefined") {
      console.warn("Firebase SDK is not loaded.");
      firebaseReady = false;
      showFirebaseSetupAlert(
        "Firebase scripts failed to load. Make sure the SDK URLs are accessible and not blocked by extensions."
      );
      return;
    }

    if (!isValidFirebaseConfig(FIREBASE_CONFIG)) {
      console.warn("Firebase config is missing or invalid.");
      firebaseReady = false;
      showFirebaseSetupAlert(
        "Firebase Auth isn't configured yet. Paste your Firebase web config into FIREBASE_CONFIG and redeploy."
      );
      return;
    }

    if (!firebase.apps.length) {
      firebase.initializeApp(FIREBASE_CONFIG);
    }

    auth = firebase.auth();
    firebaseReady = true;
    hideFirebaseSetupAlert();
    auth.onAuthStateChanged(handleAuthChange);
  } catch (error) {
    firebaseReady = false;
    console.error("Firebase init failed:", error);
    showFirebaseSetupAlert(
      `Firebase failed to initialize (${error?.message || error}). Double-check your config and try again.`
    );
  }
}

// ── Google Auth ───────────────────────────────────────────────
loginBtn?.addEventListener("click", async () => {
  if (!firebaseReady || !auth) {
    showFirebaseSetupAlert(
      "Sign-in is disabled until Firebase Auth is configured. Add your Firebase web config and redeploy."
    );
    showToast("Login is not set up yet. Add your Firebase web config first.");
    return;
  }

  try {
    const provider = new firebase.auth.GoogleAuthProvider();
    provider.setCustomParameters({ prompt: "select_account" });
    await auth.signInWithPopup(provider);
  } catch (error) {
    console.error("Sign-in failed:", error);
    showToast("Google sign-in failed. Check Firebase Auth setup.");
  }
});

signOutBtn?.addEventListener("click", async () => {
  try {
    await auth?.signOut();
  } catch (error) {
    console.error("Sign-out failed:", error);
    showToast("Could not sign out.");
  }
});

function handleAuthChange(user) {
  currentUser = user || null;
  document.body.dataset.auth = currentUser ? "signed-in" : "guest";

  if (loginBtn) {
    loginBtn.hidden = !!currentUser;
  }
  if (userMenu) {
    userMenu.hidden = !currentUser;
  }

  if (firebaseReady) {
    hideFirebaseSetupAlert();
  }

  if (currentUser) {
    if (limitBar) limitBar.hidden = true;

    if (userAvatar) {
      userAvatar.src = currentUser.photoURL || "";
      userAvatar.alt = currentUser.displayName || "User";
    }

    if (userName) {
      userName.textContent = currentUser.displayName?.split(" ")[0] || "User";
    }

    if (OWNER_EMAILS.includes(currentUser.email)) {
      showToast("Welcome back, owner! Unlimited access active.", "success");
    }
    refreshPlanTier();
  } else {
    setPlanTier("free");
    updateLimitBar();
  }
}

// ── Owner + guest usage ───────────────────────────────────────
function isOwner() {
  return !!(currentUser && OWNER_EMAILS.includes(currentUser.email));
}

function getGuestUsage() {
  const today = new Date().toDateString();

  try {
    const stored = JSON.parse(localStorage.getItem("guest_usage") || "{}");
    if (stored.date !== today) {
      return { date: today, count: 0 };
    }
    return stored;
  } catch {
    return { date: today, count: 0 };
  }
}

function incrementGuestUsage() {
  const usage = getGuestUsage();
  usage.count += 1;
  localStorage.setItem("guest_usage", JSON.stringify(usage));
  updateLimitBar();
}

function getRemainingQuestions() {
  if (isOwner()) return Infinity;
  if (currentUser) return Infinity;

  const usage = getGuestUsage();
  return Math.max(0, GUEST_DAILY_LIMIT - usage.count);
}

function updateLimitBar() {
  if (!limitBar) return;

  if (userTier === "pro") {
    limitBar.hidden = true;
    return;
  }

  if (currentUser) {
    limitBar.hidden = true;
    return;
  }

  const remaining = getRemainingQuestions();
  limitBar.hidden = false;

  if (limitRemaining) {
    limitRemaining.textContent = String(remaining);
  }
}

// ── Subject detection ─────────────────────────────────────────
const SUBJECT_KW = {
  math: [
    "equation","solve","calculate","integral","derivative","algebra","geometry",
    "polynomial","prime","factor","matrix","percent","ratio","probability",
    "statistics","calculus","divide","multiply","subtract","add"
  ],
  science: [
    "atom","molecule","cell","force","energy","velocity","acceleration","newton",
    "einstein","dna","photosynthesis","gravity","electron","chemical","reaction",
    "biology","physics","chemistry"
  ],
  history: [
    "war","century","civilization","empire","revolution","president","treaty",
    "ancient","medieval","colonial","independence","democracy"
  ],
  english: [
    "grammar","sentence","paragraph","essay","poem","metaphor","simile",
    "vocabulary","spelling","punctuation","author","novel","theme","plot"
  ],
  geography: [
    "country","continent","capital","ocean","river","mountain","climate",
    "population","latitude","longitude","region"
  ],
};

const SUBJECT_ICONS = {
  math: "📐",
  science: "⚗️",
  history: "📜",
  english: "📚",
  geography: "🌍",
  general: "✦"
};

function detectSubjectLive(question) {
  const q = String(question || "").toLowerCase();
  let best = "general";
  let bestScore = 0;

  for (const [subject, keywords] of Object.entries(SUBJECT_KW)) {
    const score = keywords.filter((kw) => q.includes(kw)).length;
    if (score > bestScore) {
      bestScore = score;
      best = subject;
    }
  }

  if (subjectBadge) {
    subjectBadge.textContent = bestScore > 0 ? best : "—";
  }

  return best;
}

// ── Input events ──────────────────────────────────────────────
questionInput?.addEventListener("input", () => {
  const len = questionInput.value.length;
  if (charCount) {
    charCount.textContent = String(len);
    charCount.style.color =
      len > 1400 ? "var(--error)" : "var(--text-secondary)";
  }
  detectSubjectLive(questionInput.value);
});

questionInput?.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;

  if (e.ctrlKey || e.metaKey) {
    e.preventDefault();
    solveQuestion(false);
    return;
  }

  if (!e.shiftKey && !e.altKey) {
    e.preventDefault();
    solveQuestion(false);
  }
});

document.querySelectorAll(".pill").forEach((pill) => {
  pill.addEventListener("click", () => {
    questionInput.value = pill.dataset.example || "";
    questionInput.dispatchEvent(new Event("input"));
    questionInput.focus();
  });
});

// ── Clear ─────────────────────────────────────────────────────
clearBtn?.addEventListener("click", () => {
  clearQuestionField();
  hideLoading();
  if (answerSection) answerSection.style.display = "none";
});

async function buildAuthHeaders() {
  if (currentUser?.getIdToken) {
    try {
      const token = await currentUser.getIdToken();
      if (token) {
        return { Authorization: `Bearer ${token}` };
      }
    } catch (error) {
      console.warn('Failed to fetch auth token:', error);
    }
  }
  return {};
}

// ── Solve ─────────────────────────────────────────────────────
async function solveQuestion(simplify = false) {
  let question = (questionInput?.value || "").trim();

  if (!question) {
    if (simplify && lastQuestion) {
      question = lastQuestion;
    } else {
      showToast("Please enter a question first.");
      return;
    }
  }

  if (question.length > 1500) {
    showToast("Question too long (max 1500 chars).");
    return;
  }

  if (isLoading) return;

  if (!currentUser && getRemainingQuestions() <= 0) {
    showToast("Daily limit reached. Sign in for unlimited questions.");
    updateLimitBar();
    return;
  }

  isLoading = true;
  lastQuestion = question;
  if (solveBtn) solveBtn.disabled = true;
  showLoading();

  try {
    const authHeaders = await buildAuthHeaders();
    const contextHistory = getConversationContext();
    const hasUploads = attachedFiles.length > 0;
    const fetchOptions = {
      method: "POST",
      headers: {
        ...authHeaders,
      },
    };

    if (hasUploads) {
      const formData = new FormData();
      formData.append("question", question);
      formData.append("simplify", String(simplify));
      formData.append("mode", selectedMode);
      formData.append("history", JSON.stringify(contextHistory));
      attachedFiles.forEach((item) => {
        formData.append("attachments", item.file, item.file.name);
      });
      fetchOptions.body = formData;
    } else {
      fetchOptions.headers["Content-Type"] = "application/json";
      fetchOptions.body = JSON.stringify({
        question,
        simplify,
        mode: selectedMode,
        history: contextHistory,
      });
    }

    const res = await fetch(`${API_BASE}/solve`, fetchOptions);

    let data = null;
    try {
      data = await res.json();
    } catch {
      throw new Error("Server returned invalid JSON.");
    }

    if (res.status === 401) {
      if (auth) {
        try {
          await auth.signOut();
        } catch (signOutErr) {
          console.warn("Could not clear expired session:", signOutErr);
        }
      }
      throw new Error(data?.error || "Session expired. Please sign in again.");
    }

    if (res.status === 429) {
      const wait = typeof data?.retryAfter === "number" ? Math.ceil(data.retryAfter) : null;
      const message = data?.error || "You're sending questions too quickly.";
      throw new Error(wait ? `${message} Try again in ${wait}s.` : message);
    }

    if (!res.ok || data?.error) {
      throw new Error(data?.error || "Unknown server error.");
    }

    lastRawAnswer = data.answer || "";
    const subject = data.subject || "general";
    lastSources = Array.isArray(data.sources) ? data.sources : [];

    if (subjectBadge) subjectBadge.textContent = subject;
    const iconEl = document.getElementById("answerSubjectIcon");
    if (iconEl) iconEl.textContent = SUBJECT_ICONS[subject] || "✦";

    renderAnswer(lastRawAnswer);
    showAnswer();
    renderMath();
    renderSources(lastSources);

    if (!simplify) {
      if (!currentUser) incrementGuestUsage();
      addToHistory(question, subject);
      rememberConversationTurn(question, lastRawAnswer);
    }

    clearQuestionField();
  } catch (error) {
    console.error("Solve failed:", error);
    showToast(error.message || "Something went wrong. Please try again.");
  } finally {
    isLoading = false;
    if (solveBtn) solveBtn.disabled = false;
    hideLoading();
  }
}

solveBtn?.addEventListener("click", () => solveQuestion(false));
simplifyBtn?.addEventListener("click", () => solveQuestion(true));

// ── Answer render ─────────────────────────────────────────────
function renderInline(text) {
  return esc(text)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(
      /`(.+?)`/g,
      '<code style="font-family:var(--font-mono);background:var(--bg-surface);padding:0.1rem 0.35rem;border-radius:4px;font-size:0.88em;">$1</code>'
    );
}

function renderAnswer(raw) {
  if (!answerBody) return;

  answerBody.innerHTML = "";
  const lines = String(raw)
    .split("\n")
    .filter((line) => line.trim());

  let delay = 0;

  for (const line of lines) {
    const trimmed = line.trim();

    if (/^summary:/i.test(trimmed)) {
      const div = document.createElement("div");
      div.className = "summary-block";
      div.innerHTML = `<strong>Summary:</strong> ${renderInline(
        trimmed.replace(/^summary:\s*/i, "")
      )}`;
      answerBody.appendChild(div);
      continue;
    }

    const stepMatch = trimmed.match(/^(step\s*\d+[:.]?\s*)/i);
    if (stepMatch) {
      const label = stepMatch[1].trim();
      const content = trimmed.slice(label.length).trim();

      const div = document.createElement("div");
      div.className = "step";
      div.style.animationDelay = `${delay}ms`;
      div.innerHTML =
        `<span class="step-number">${esc(label)}</span>` +
        `<span class="step-content">${renderInline(content)}</span>`;
      answerBody.appendChild(div);
      delay += 100;
      continue;
    }

    const p = document.createElement("p");
    p.innerHTML = renderInline(trimmed);
    answerBody.appendChild(p);
  }
}

// ── Math render ───────────────────────────────────────────────
function renderMath() {
  if (typeof renderMathInElement === "undefined" || !answerBody) return;

  try {
    renderMathInElement(answerBody, {
      delimiters: [
        { left: "$$", right: "$$", display: true },
        { left: "$", right: "$", display: false },
        { left: "\\(", right: "\\)", display: false },
        { left: "\\[", right: "\\]", display: true },
      ],
      throwOnError: false,
    });
  } catch (error) {
    console.warn("KaTeX render error:", error);
  }
}

// ── Copy ──────────────────────────────────────────────────────
copyBtn?.addEventListener("click", async () => {
  if (!lastRawAnswer) return;

  try {
    await navigator.clipboard.writeText(lastRawAnswer);
    copyBtn.textContent = "✓ Copied!";
    copyBtn.classList.add("copied");
    showToast("Copied!", "success");

    setTimeout(() => {
      copyBtn.textContent = "📋 Copy";
      copyBtn.classList.remove("copied");
    }, 2000);
  } catch {
    showToast("Copy failed — select text manually.");
  }
});

// ── PDF export ────────────────────────────────────────────────
pdfBtn?.addEventListener("click", () => {
  if (!lastRawAnswer || !window.jspdf) return;

  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: "mm", format: "a4" });

  const pageW = doc.internal.pageSize.getWidth();
  const margin = 20;
  const maxW = pageW - margin * 2;
  let y = 25;

  doc.setFillColor(232, 160, 74);
  doc.rect(0, 0, pageW, 15, "F");
  doc.setTextColor(13, 12, 11);
  doc.setFontSize(10);
  doc.setFont("helvetica", "bold");
  doc.text("SolverPro — AI Homework Solver", margin, 10);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  doc.setTextColor(80);
  doc.text(
    new Date().toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
    }),
    pageW - margin,
    10,
    { align: "right" }
  );

  y = 28;

  doc.setFontSize(11);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(13, 12, 11);
  doc.text("Question:", margin, y);
  y += 6;

  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.setTextColor(60, 60, 60);
  const qLines = doc.splitTextToSize(lastQuestion, maxW);
  doc.text(qLines, margin, y);
  y += qLines.length * 5.5 + 6;

  doc.setDrawColor(232, 160, 74);
  doc.setLineWidth(0.5);
  doc.line(margin, y, pageW - margin, y);
  y += 7;

  doc.setFontSize(11);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(13, 12, 11);
  doc.text("Answer:", margin, y);
  y += 7;

  for (const line of lastRawAnswer.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (y > 270) {
      doc.addPage();
      y = 20;
    }

    const isStep = /^step\s*\d+/i.test(trimmed);
    const isSummary = /^summary:/i.test(trimmed);

    if (isStep) {
      doc.setFont("helvetica", "bold");
      doc.setTextColor(180, 100, 20);
      doc.setFillColor(252, 242, 228);
      const wrapped = doc.splitTextToSize(trimmed, maxW - 4);
      doc.roundedRect(margin - 2, y - 4, maxW + 4, wrapped.length * 5.5 + 4, 2, 2, "F");
      doc.text(wrapped, margin + 2, y);
      y += wrapped.length * 5.5 + 5;
    } else if (isSummary) {
      doc.setFont("helvetica", "bolditalic");
      doc.setTextColor(13, 12, 11);
      const wrapped = doc.splitTextToSize(trimmed, maxW);
      doc.text(wrapped, margin, y);
      y += wrapped.length * 5.5 + 4;
    } else {
      doc.setFont("helvetica", "normal");
      doc.setTextColor(60, 60, 60);
      const wrapped = doc.splitTextToSize(trimmed, maxW);
      doc.text(wrapped, margin, y);
      y += wrapped.length * 5.5 + 3;
    }
  }

  doc.setFontSize(8);
  doc.setTextColor(150);
  doc.setFont("helvetica", "italic");
  doc.text("Generated by SolverPro — homework-two-beta.vercel.app", margin, 287);

  doc.save(`homework-answer-${Date.now()}.pdf`);
  showToast("PDF downloaded!", "success");
});

// ── Share ─────────────────────────────────────────────────────
shareBtn?.addEventListener("click", async () => {
  const text = `Q: ${lastQuestion}\n\nA: ${lastRawAnswer}`;

  if (!lastRawAnswer) return;

  if (navigator.share) {
    try {
      await navigator.share({
        title: "Homework Answer",
        text,
      });
      return;
    } catch {
      // user cancelled, do nothing
    }
  }

  try {
    await navigator.clipboard.writeText(window.location.href);
    showToast("Link copied!", "success");
  } catch {
    showToast("Share failed.");
  }
});

proCheckoutButtons.forEach((btn) => btn?.addEventListener("click", startCheckout));
portalButtons.forEach((btn) => btn?.addEventListener("click", openPortal));

// ── History ───────────────────────────────────────────────────
const HISTORY_KEY = "solver_history";
const MAX_HISTORY = 10;

function loadHistory() {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY)) || [];
  } catch {
    return [];
  }
}

function saveHistory(history) {
  localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
}

function addToHistory(question, subject) {
  const history = loadHistory().filter((entry) => entry.question !== question);
  history.unshift({
    question,
    subject,
    ts: Date.now(),
  });
  saveHistory(history.slice(0, MAX_HISTORY));
  renderHistory();
}

function renderHistory() {
  if (!historySection || !historyList) return;

  const history = loadHistory();
  if (!history.length) {
    historySection.style.display = "none";
    return;
  }

  historySection.style.display = "block";
  historyList.innerHTML = "";

  for (const entry of history) {
    const li = document.createElement("li");
    li.className = "history-item";
    li.innerHTML = `
      <span class="history-q">${esc(entry.question.slice(0, 80))}${entry.question.length > 80 ? "…" : ""}</span>
      <span class="history-subj">${esc(entry.subject)}</span>
    `;

    li.addEventListener("click", () => {
      if (!questionInput) return;
      questionInput.value = entry.question;
      questionInput.dispatchEvent(new Event("input"));
      questionInput.scrollIntoView({ behavior: "smooth" });
    });

    historyList.appendChild(li);
  }
}

clearHistoryBtn?.addEventListener("click", () => {
  localStorage.removeItem(HISTORY_KEY);
  resetConversation();
  renderHistory();
});

// ── Toast ─────────────────────────────────────────────────────
function showToast(message, type = "error") {
  document.querySelector(".toast")?.remove();

  const toast = document.createElement("div");
  toast.className = `toast${type === "success" ? " success" : ""}`;
  toast.textContent = message;

  document.body.appendChild(toast);

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      toast.classList.add("show");
    });
  });

  setTimeout(() => {
    toast.classList.remove("show");
    setTimeout(() => toast.remove(), 400);
  }, 3000);
}

// ── Billing helpers ───────────────────────────────────────────
function setPlanTier(tier) {
  userTier = tier === "pro" ? "pro" : "free";
  document.body.dataset.plan = userTier;
  updateLimitBar();
}

async function refreshPlanTier() {
  if (!currentUser) {
    setPlanTier("free");
    return;
  }

  try {
    const headers = await buildAuthHeaders();
    const res = await fetch(`${API_BASE}/me/tier`, {
      headers,
    });
    const data = await res.json();
    const tier =
      data?.role === "owner" || data?.tier === "pro" ? "pro" : "free";
    setPlanTier(tier);
  } catch (error) {
    console.warn("Could not refresh plan tier:", error);
    setPlanTier("free");
  }
}

async function startCheckout(event) {
  event?.preventDefault();
  if (!currentUser) {
    showToast("Sign in to upgrade.");
    loginBtn?.click();
    return;
  }

  try {
    const headers = {
      "Content-Type": "application/json",
      ...(await buildAuthHeaders()),
    };
    const res = await fetch(`${API_BASE}/billing/create-checkout-session`, {
      method: "POST",
      headers,
      body: JSON.stringify({ plan: "pro" }),
    });
    const data = await res.json();
    if (!res.ok || !data?.url) {
      throw new Error(data?.error || "Unable to start checkout.");
    }
    window.location.href = data.url;
  } catch (error) {
    console.error("Checkout failed:", error);
    showToast(error.message || "Checkout failed.");
  }
}

async function openPortal(event) {
  event?.preventDefault();
  if (!currentUser) {
    showToast("Sign in to manage your plan.");
    loginBtn?.click();
    return;
  }

  try {
    const headers = {
      "Content-Type": "application/json",
      ...(await buildAuthHeaders()),
    };
    const res = await fetch(`${API_BASE}/billing/customer-portal`, {
      method: "POST",
      headers,
      body: JSON.stringify({}),
    });
    const data = await res.json();
    if (!res.ok || !data?.url) {
      throw new Error(data?.error || "Portal unavailable.");
    }
    window.location.href = data.url;
  } catch (error) {
    console.error("Portal error:", error);
    showToast(error.message || "Could not open portal.");
  }
}

// ── Init ──────────────────────────────────────────────────────
hideLoading();
if (answerSection) answerSection.style.display = "none";
updateLimitBar();
renderUploads();
renderSources([]);
selectMode("answer");
loadConversationMemory();
renderHistory();
initFirebase();
