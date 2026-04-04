import hashlib
import json
import os
import time
from collections import defaultdict
from io import BytesIO
from pathlib import Path

import numpy as np
import requests
import stripe
from duckduckgo_search import DDGS
from flask import Flask, request, jsonify
from flask_cors import CORS
from google.auth.transport import requests as google_requests
from google.oauth2 import id_token as google_id_token
from PIL import Image
from pypdf import PdfReader
from rapidocr_onnxruntime import RapidOCR

app = Flask(__name__)
CORS(app, origins=["*"])

DEFAULT_OWNER_EMAILS = {"osmanitrimor11@gmail.com"}
OWNER_EMAILS = {
    email.strip().lower()
    for email in os.environ.get("OWNER_EMAILS", "").split(",")
    if email.strip()
} or DEFAULT_OWNER_EMAILS

FIREBASE_PROJECT_ID = os.environ.get("FIREBASE_PROJECT_ID")
AUTH_REQUEST_LIMIT = int(os.environ.get("AUTH_REQUESTS_PER_MINUTE", "30"))
GUEST_REQUEST_LIMIT = int(os.environ.get("GUEST_REQUESTS_PER_MINUTE", "10"))
RATE_LIMIT_WINDOW = int(os.environ.get("RATE_LIMIT_WINDOW_SECONDS", "60"))
MAX_CONTEXT_TURNS = int(os.environ.get("CONTEXT_TURNS", "6"))
MAX_CONTEXT_CHARS = int(os.environ.get("CONTEXT_CHAR_LIMIT", "1800"))
MAX_UPLOAD_TEXT = int(os.environ.get("UPLOAD_TEXT_LIMIT", "1500"))
ALLOWED_MODES = {"answer", "teach", "quiz"}
MAX_FILE_COUNT = int(os.environ.get("UPLOAD_FILE_LIMIT", "3"))
MAX_FILE_BYTES = int(os.environ.get("UPLOAD_MAX_BYTES", str(5 * 1024 * 1024)))
MODE_INSTRUCTIONS = {
    "answer": "",
    "teach": (
        "Adopt a coaching tone. Explain the overarching concept, outline why each step "
        "works, and mention common mistakes students should avoid."
    ),
    "quiz": (
        "After presenting the solution, include a short 'Quiz me' section with 2-3 practice "
        "questions or variations that help the student check understanding."
    ),
}

from openai import OpenAI
client = OpenAI(api_key=os.environ.get("OPENAI_API_KEY"))

# ── Rate limiting (in-memory, per IP) ──────────────────────────────────────
RATE_LIMIT_REQUESTS = 10       # max requests
RATE_LIMIT_WINDOW = 60         # per N seconds
rate_store = defaultdict(list)  # ip -> [timestamp, ...]

def is_rate_limited(ip: str) -> bool:
    now = time.time()
    window_start = now - RATE_LIMIT_WINDOW
    rate_store[ip] = [t for t in rate_store[ip] if t > window_start]
    if len(rate_store[ip]) >= RATE_LIMIT_REQUESTS:
        return True
    rate_store[ip].append(now)
    return False

# ── Subject auto-detection ─────────────────────────────────────────────────
SUBJECT_KEYWORDS = {
    "math":    ["equation", "solve", "calculate", "integral", "derivative", "algebra",
                "geometry", "polynomial", "prime", "factor", "matrix", "+", "-", "×", "÷",
                "percent", "ratio", "probability", "statistics", "calculus"],
    "science": ["atom", "molecule", "cell", "force", "energy", "velocity", "acceleration",
                "Newton", "Einstein", "DNA", "photosynthesis", "gravity", "electron",
                "chemical", "reaction", "biology", "physics", "chemistry", "element"],
    "history": ["war", "century", "civilization", "empire", "revolution", "president",
                "treaty", "ancient", "medieval", "colonial", "independence", "democracy"],
    "english": ["grammar", "sentence", "paragraph", "essay", "poem", "metaphor", "simile",
                "vocabulary", "spelling", "punctuation", "author", "novel", "theme", "plot"],
    "geography": ["country", "continent", "capital", "ocean", "river", "mountain", "climate",
                  "population", "latitude", "longitude", "region", "territory"],
}

firebase_request_adapter = google_requests.Request()
ocr_engine = None

GROQ_API_KEY = os.environ.get("GROQ_API_KEY")
if not GROQ_API_KEY:
    raise Exception("Missing GROQ_API_KEY environment variable")

GROQ_URL   = "https://api.groq.com/openai/v1/chat/completions"
GROQ_MODEL = "llama-3.1-8b-instant"  # current free Groq model

STRIPE_SECRET_KEY   = os.environ.get("STRIPE_SECRET_KEY")
STRIPE_PRICE_ID     = os.environ.get("STRIPE_PRICE_ID")
STRIPE_SUCCESS_URL  = os.environ.get("STRIPE_SUCCESS_URL", "https://homework-two-beta.vercel.app/billing/success?session_id={CHECKOUT_SESSION_ID}")
STRIPE_CANCEL_URL   = os.environ.get("STRIPE_CANCEL_URL", "https://homework-two-beta.vercel.app/")
STRIPE_PORTAL_RETURN_URL = os.environ.get("STRIPE_PORTAL_RETURN_URL", "https://homework-two-beta.vercel.app/account")
STRIPE_WEBHOOK_SECRET = os.environ.get("STRIPE_WEBHOOK_SECRET")

if STRIPE_SECRET_KEY:
    stripe.api_key = STRIPE_SECRET_KEY

PRO_REGISTRY_PATH = Path(__file__).resolve().parent / "pro_registry.json"
pro_registry = {}


def load_pro_registry():
    global pro_registry
    if PRO_REGISTRY_PATH.exists():
        try:
            pro_registry = json.loads(PRO_REGISTRY_PATH.read_text(encoding="utf-8"))
        except Exception:
            pro_registry = {}
    else:
        pro_registry = {}


def save_pro_registry():
    PRO_REGISTRY_PATH.write_text(json.dumps(pro_registry, indent=2), encoding="utf-8")


load_pro_registry()

def get_identity_email(identity):
    if not identity:
        return ""
    return (identity.get("email") or "").lower().strip()


def is_owner(identity):
    return bool(get_identity_email(identity) in OWNER_EMAILS)


def get_registry_entry(uid: str):
    if not uid:
        return {}
    return pro_registry.get(uid, {})


def upsert_registry(uid: str, **fields):
    if not uid:
        return
    entry = pro_registry.get(uid, {})
    entry.update({k: v for k, v in fields.items() if v is not None})
    pro_registry[uid] = entry
    save_pro_registry()


def find_uid_by_customer(customer_id: str):
    if not customer_id:
        return None
    for uid, entry in pro_registry.items():
        if entry.get("stripe_customer_id") == customer_id:
            return uid
    return None


def is_user_pro(identity) -> bool:
    if not identity:
        return False
    if is_owner(identity):
        return True
    uid = identity.get("uid")
    if not uid:
        return False
    entry = get_registry_entry(uid)
    if not entry:
        return False
    status = entry.get("status")
    expiry = entry.get("current_period_end", 0)
    if status in {"trialing", "active"} and expiry and expiry > time.time():
        return True
    return False


def registry_response(identity):
    if not identity:
        return {"tier": "free", "role": "guest"}
    tier = "pro" if is_user_pro(identity) else "free"
    entry = get_registry_entry(identity.get("uid"))
    return {
        "tier": tier,
        "role": "owner" if is_owner(identity) else tier,
        "currentPeriodEnd": entry.get("current_period_end"),
        "status": entry.get("status", "canceled"),
    }


def require_authenticated_identity():
    try:
        identity = extract_firebase_identity()
    except ValueError as exc:
        raise PermissionError(str(exc))

    if not identity:
        raise PermissionError("Sign-in required.")
    return identity


rate_store = defaultdict(list)


def get_quota_snapshot(bucket_key, bucket_limit):
    if not bucket_key or bucket_limit is None:
        return None

    now = time.time()
    window_start = now - RATE_LIMIT_WINDOW
    hits = rate_store[bucket_key]
    hits[:] = [t for t in hits if t > window_start]

    remaining = max(0, bucket_limit - len(hits))
    reset_after = RATE_LIMIT_WINDOW
    if hits:
        reset_after = max(0, int(hits[0] + RATE_LIMIT_WINDOW - now))

    return {
        "limit": bucket_limit,
        "remaining": remaining,
        "reset_after": reset_after,
    }


SUBJECT_KEYWORDS = {
    "math": [
        "equation", "solve", "calculate", "integral", "derivative", "algebra",
        "geometry", "polynomial", "prime", "factor", "matrix", "+", "-", "x",
        "percent", "ratio", "probability", "statistics", "calculus", "divide",
        "multiply", "subtract", "add"
    ],
    "science": [
        "atom", "molecule", "cell", "force", "energy", "velocity", "acceleration",
        "newton", "einstein", "dna", "photosynthesis", "gravity", "electron",
        "chemical", "reaction", "biology", "physics", "chemistry"
    ],
    "history": [
        "war", "century", "civilization", "empire", "revolution", "president",
        "treaty", "ancient", "medieval", "colonial", "independence"
    ],
    "english": [
        "grammar", "sentence", "paragraph", "essay", "poem", "metaphor", "simile",
        "vocabulary", "spelling", "punctuation", "author", "novel"
    ],
    "geography": [
        "country", "continent", "capital", "ocean", "river", "mountain",
        "climate", "population", "latitude", "longitude"
    ]
}


def hash_identifier(raw: str) -> str:
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def build_rate_bucket(identity, ip_address):
    if identity:
        if is_owner(identity) or is_user_pro(identity):
            return None, None

        key_source = identity.get("uid") or get_identity_email(identity)
        if key_source:
            return f"user:{hash_identifier(key_source)}", AUTH_REQUEST_LIMIT

    hashed_ip = hash_identifier((ip_address or "anonymous").strip())
    return f"ip:{hashed_ip}", GUEST_REQUEST_LIMIT


def check_rate_limit(bucket_key, bucket_limit):
    snapshot = get_quota_snapshot(bucket_key, bucket_limit)
    if not snapshot:
        return False, None, None

    if snapshot["remaining"] <= 0:
        return True, 0, snapshot["reset_after"]

    hits = rate_store[bucket_key]
    hits.append(time.time())
    remaining_after = max(0, snapshot["remaining"] - 1)
    return False, remaining_after, snapshot["reset_after"]


def record_subscription(subscription):
    if not subscription:
        return
    metadata = subscription.get("metadata") or {}
    uid = metadata.get("uid") or find_uid_by_customer(subscription.get("customer"))
    if not uid:
        return
    upsert_registry(
        uid,
        stripe_customer_id=subscription.get("customer"),
        subscription_id=subscription.get("id"),
        status=subscription.get("status"),
        current_period_end=subscription.get("current_period_end"),
    )


def fetch_and_record_subscription(subscription_id):
    if not subscription_id or not STRIPE_SECRET_KEY:
        return
    subscription = stripe.Subscription.retrieve(subscription_id)
    record_subscription(subscription)


def handle_checkout_session(session):
    if not session:
        return
    subscription_id = session.get("subscription")
    customer_id = session.get("customer")
    uid = session.get("client_reference_id") or find_uid_by_customer(customer_id)

    if uid and customer_id:
        upsert_registry(uid, stripe_customer_id=customer_id)

    if subscription_id:
        try:
            stripe.Subscription.modify(subscription_id, metadata={"uid": uid or ""})
        except Exception:
            pass
        fetch_and_record_subscription(subscription_id)


def handle_stripe_event(event):
    if not event:
        return
    event_type = event.get("type")
    data_object = event.get("data", {}).get("object", {})

    if event_type == "checkout.session.completed":
        handle_checkout_session(data_object)
    elif event_type and event_type.startswith("customer.subscription"):
        record_subscription(data_object)


def extract_firebase_identity():
    auth_header = request.headers.get("Authorization", "").strip()
    if not auth_header:
        return None

    if not auth_header.lower().startswith("bearer "):
        return None

    token = auth_header.split(" ", 1)[1].strip()
    if not token:
        return None

    if not FIREBASE_PROJECT_ID:
        app.logger.warning(
            "Received Firebase identity token but FIREBASE_PROJECT_ID is not set."
        )
        return None

    try:
        return google_id_token.verify_firebase_token(
            token,
            firebase_request_adapter,
            FIREBASE_PROJECT_ID,
        )
    except Exception as exc:
        raise ValueError(str(exc))


def detect_subject(question):
    q_lower = question.lower()
    scores = {subject: 0 for subject in SUBJECT_KEYWORDS}
    for subject, keywords in SUBJECT_KEYWORDS.items():
        for kw in keywords:
            if kw in q_lower:
                scores[subject] += 1
    best = max(scores, key=scores.get)
    return best if scores[best] > 0 else "general"


def sanitize_history(raw_history):
    if not isinstance(raw_history, list):
        return []

    sanitized = []
    for entry in raw_history:
        if len(sanitized) >= MAX_CONTEXT_TURNS:
            break
        if not isinstance(entry, dict):
            continue
        question = str(entry.get("question", "")).strip()
        answer = str(entry.get("answer", "")).strip()
        if not question or not answer:
            continue
        sanitized.append(
            {
                "question": question[:MAX_CONTEXT_CHARS],
                "answer": answer[: MAX_CONTEXT_CHARS * 2],
            }
        )
    return sanitized


def get_ocr_engine():
    global ocr_engine
    if ocr_engine is False:
        return None
    if ocr_engine is None:
        try:
            ocr_engine = RapidOCR()
        except Exception as exc:
            app.logger.warning(f"Failed to initialize OCR engine: {exc}")
            ocr_engine = False
    return ocr_engine or None


def extract_text_from_image_bytes(data: bytes) -> str:
    try:
        image = Image.open(BytesIO(data)).convert("RGB")
    except Exception as exc:
        app.logger.warning(f"Image decode failed: {exc}")
        return ""

    engine = get_ocr_engine()
    if not engine:
        return ""

    try:
        result, _ = engine(np.array(image))
    except Exception as exc:
        app.logger.warning(f"OCR processing failed: {exc}")
        return ""

    if not result:
        return ""

    lines = [entry[1] for entry in result if isinstance(entry, (list, tuple)) and len(entry) > 1]
    return " ".join(lines).strip()


def extract_text_from_pdf_bytes(data: bytes) -> str:
    try:
        reader = PdfReader(BytesIO(data))
    except Exception as exc:
        app.logger.warning(f"PDF parsing failed: {exc}")
        return ""

    chunks = []
    for page in reader.pages[:5]:
        try:
            text = page.extract_text() or ""
        except Exception:
            text = ""
        if text.strip():
            chunks.append(text.strip())
    return "\n\n".join(chunks).strip()


def process_uploaded_files(file_storages):
    combined = []
    meta = []
    if not file_storages:
        return combined, meta

    for storage in list(file_storages)[:MAX_FILE_COUNT]:
        filename = (storage.filename or "attachment").strip() or "attachment"
        data = storage.read()
        if not data:
            meta.append({"filename": filename, "error": "empty"})
            continue
        if len(data) > MAX_FILE_BYTES:
            meta.append({"filename": filename, "error": "too_large"})
            continue

        mimetype = (storage.mimetype or storage.content_type or "").lower()
        text = ""
        if "pdf" in mimetype or filename.lower().endswith(".pdf"):
            text = extract_text_from_pdf_bytes(data)
        elif mimetype.startswith("image") or filename.lower().endswith((".png", ".jpg", ".jpeg", ".bmp", ".webp", ".gif", ".heic")):
            text = extract_text_from_image_bytes(data)
        else:
            meta.append({"filename": filename, "error": "unsupported"})
            continue

        text = (text or "").strip()
        if text:
            clipped = text[:MAX_UPLOAD_TEXT]
            combined.append((filename, clipped))
            meta.append({"filename": filename, "chars": len(clipped)})
        else:
            meta.append({"filename": filename, "error": "no_text"})

    return combined, meta


def fetch_sources(query: str, limit: int = 3):
    if not query:
        return []
    sources = []
    try:
        with DDGS() as ddgs:
            for result in ddgs.text(query, max_results=limit):
                if not result:
                    continue
                sources.append(
                    {
                        "title": result.get("title"),
                        "url": result.get("href") or result.get("url"),
                        "snippet": result.get("body") or result.get("snippet"),
                    }
                )
                if len(sources) >= limit:
                    break
    except Exception as exc:
        app.logger.warning(f"Source lookup failed: {exc}")
    return sources


def generate_with_groq(question, subject, simplify, context_history=None, mode="answer"):
    system_prompt = (
        "You are SolverPro, an expert tutor who speaks to students like capable peers. "
        "Provide rigorous reasoning broken into clearly labeled numbered steps ('Step 1:', 'Step 2:', ...). "
        "Always close with a succinct 'Summary:' line that captures the result or insight. "
        "Acknowledge earlier turns when helpful, but prioritize the current question. "
        "Maintain a respectful, direct tone—never condescending or overly childish."
    )
    if simplify:
        system_prompt += (
            " Simplify the language when Simplify mode is requested, using shorter sentences and analogies."
        )
    extra = MODE_INSTRUCTIONS.get((mode or "answer").lower())
    if extra:
        system_prompt += f" {extra}"

    headers = {
        "Authorization": f"Bearer {GROQ_API_KEY}",
        "Content-Type": "application/json"
    }

    messages = [
        {"role": "system", "content": system_prompt},
    ]

    for turn in context_history or []:
        messages.append(
            {
                "role": "user",
                "content": f"Earlier question:\n{turn['question']}",
            }
        )
        messages.append(
            {
                "role": "assistant",
                "content": f"Earlier answer:\n{turn['answer']}",
            }
        )

    current_prompt = (
        f"[Subject: {subject.upper()}]\n\n"
        "Current question:\n"
        f"{question}\n\n"
        "If the text refers to earlier steps, use the previous turns above as context."
    )
    messages.append({"role": "user", "content": current_prompt})

    payload = {
        "model": GROQ_MODEL,
        "messages": messages,
        "max_tokens": 800,
        "temperature": 0.4
    }

    response = requests.post(GROQ_URL, headers=headers, json=payload, timeout=30)

    try:
        data = response.json()
    except Exception:
        raise Exception(f"Groq returned non-JSON: {response.text[:200]}")

    if response.status_code != 200:
        raise Exception(f"Groq API error {response.status_code}: {data}")

    answer = data["choices"][0]["message"]["content"].strip()
    if not answer:
        raise Exception("Groq returned an empty answer.")

    return answer


@app.route("/", methods=["GET"])
def root_status():
    return jsonify({"status": "Backend running with Groq"}), 200


@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ok"}), 200


@app.route("/me/tier", methods=["GET"])
def me_tier():
    identity = None
    try:
        identity = extract_firebase_identity()
    except ValueError:
        identity = None
    return jsonify(registry_response(identity)), 200


@app.route("/quota", methods=["GET"])
def quota_status():
    forwarded_for = request.headers.get("X-Forwarded-For", "")
    ip = forwarded_for.split(",")[0].strip() if forwarded_for else request.remote_addr

    try:
        identity = extract_firebase_identity()
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 401

    bucket_key, bucket_limit = build_rate_bucket(identity, ip or "unknown")
    snapshot = get_quota_snapshot(bucket_key, bucket_limit)

    if not snapshot:
        return jsonify({"status": "unlimited", "quota": None}), 200

    quota_payload = {
        "limit": snapshot["limit"],
        "remaining": snapshot["remaining"],
        "windowSeconds": RATE_LIMIT_WINDOW,
        "resetSeconds": snapshot["reset_after"],
    }
    return jsonify({"status": "limited", "quota": quota_payload}), 200


@app.route("/billing/create-checkout-session", methods=["POST"])
def create_checkout_session():
    if not STRIPE_SECRET_KEY or not STRIPE_PRICE_ID:
        return jsonify({"error": "Billing is not configured."}), 503

    try:
        identity = require_authenticated_identity()
    except PermissionError as exc:
        return jsonify({"error": str(exc)}), 401

    uid = identity.get("uid")
    email = identity.get("email")
    entry = get_registry_entry(uid)
    customer_id = entry.get("stripe_customer_id")

    try:
        if not customer_id:
            customer = stripe.Customer.create(
                email=email,
                metadata={"uid": uid or "", "source": "solverpro"},
            )
            customer_id = customer["id"]
            upsert_registry(uid, stripe_customer_id=customer_id)

        session = stripe.checkout.Session.create(
            mode="subscription",
            client_reference_id=uid,
            customer=customer_id,
            line_items=[{"price": STRIPE_PRICE_ID, "quantity": 1}],
            allow_promotion_codes=True,
            success_url=STRIPE_SUCCESS_URL,
            cancel_url=STRIPE_CANCEL_URL,
            subscription_data={
                "metadata": {"uid": uid or "", "email": email or ""},
            },
            metadata={"uid": uid or ""},
        )
        return jsonify({"url": session.url}), 200
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500


@app.route("/billing/customer-portal", methods=["POST"])
def create_customer_portal():
    if not STRIPE_SECRET_KEY:
        return jsonify({"error": "Billing is not configured."}), 503

    try:
        identity = require_authenticated_identity()
    except PermissionError as exc:
        return jsonify({"error": str(exc)}), 401

    entry = get_registry_entry(identity.get("uid"))
    customer_id = entry.get("stripe_customer_id")
    if not customer_id:
        return jsonify({"error": "No active subscription found."}), 400

    try:
        session = stripe.billing_portal.Session.create(
            customer=customer_id,
            return_url=STRIPE_PORTAL_RETURN_URL,
        )
        return jsonify({"url": session.url}), 200
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500


@app.route("/stripe/webhook", methods=["POST"])
def stripe_webhook():
    if not STRIPE_WEBHOOK_SECRET:
        return jsonify({"error": "Webhook secret missing."}), 503

    payload = request.data.decode("utf-8")
    sig_header = request.headers.get("Stripe-Signature")

    try:
        event = stripe.Webhook.construct_event(
            payload, sig_header, STRIPE_WEBHOOK_SECRET
        )
    except Exception as exc:
        return jsonify({"error": str(exc)}), 400

    handle_stripe_event(event)
    return jsonify({"received": True}), 200


@app.route("/solve", methods=["POST"])
def solve():
    forwarded_for = request.headers.get("X-Forwarded-For", "")
    ip = forwarded_for.split(",")[0].strip() if forwarded_for else request.remote_addr

    identity = None
    try:
        identity = extract_firebase_identity()
    except ValueError:
        return (
            jsonify(
                {"error": "Your sign-in expired. Please sign in again to keep solving."}
            ),
            401,
        )

    bucket_key, bucket_limit = build_rate_bucket(identity, ip or "unknown")
    limited, remaining, retry_after = check_rate_limit(bucket_key, bucket_limit)
    if limited:
        payload = {
            "error": "Rate limit exceeded. Please slow down or upgrade.",
            "retryAfter": retry_after,
        }
        if bucket_limit:
            payload["quota"] = {
                "limit": bucket_limit,
                "remaining": 0,
                "windowSeconds": RATE_LIMIT_WINDOW,
            }
            if retry_after is not None:
                payload["quota"]["resetSeconds"] = retry_after

        response = jsonify(payload)
        if retry_after is not None:
            response.headers["Retry-After"] = str(retry_after)
        return response, 429

    files = []
    question_raw = ""
    simplify = False
    mode = "answer"
    history_payload = []

    content_type = (request.content_type or "").lower()
    if "multipart/form-data" in content_type:
        question_raw = (request.form.get("question") or "").strip()
        simplify_value = (request.form.get("simplify") or "").lower()
        simplify = simplify_value in {"true", "1", "yes"}
        mode = (request.form.get("mode") or "answer").lower()
        history_raw = request.form.get("history") or "[]"
        try:
            history_payload = json.loads(history_raw)
        except Exception:
            history_payload = []
        files = request.files.getlist("attachments")
    else:
        data = request.get_json(silent=True)
        if not data:
            return jsonify({"error": "Invalid JSON body."}), 400
        question_raw = (data.get("question") or "").strip()
        simplify = bool(data.get("simplify", False))
        mode = (data.get("mode") or "answer").lower()
        history_payload = data.get("history") or []

    if mode not in ALLOWED_MODES:
        mode = "answer"

    context_history = sanitize_history(history_payload)
    combined_chunks, upload_meta = process_uploaded_files(files)

    question = question_raw
    if combined_chunks:
        additions = []
        for idx, (filename, text) in enumerate(combined_chunks, 1):
            additions.append(f"[Attachment {idx}: {filename}]\n{text}")
        question = f"{question}\n\nUploaded references:\n" + "\n\n".join(additions)
        question = question.strip()

    if not question:
        return jsonify({"error": "Question cannot be empty."}), 400
    if len(question) > 4000:
        return jsonify({"error": "Question is too long (max 4000 characters)."}), 400

    base_query = question_raw or (combined_chunks[0][1] if combined_chunks else question)
    subject = detect_subject(base_query or question)

    try:
        answer = generate_with_groq(question, subject, simplify, context_history, mode=mode)
        sources = fetch_sources(base_query, limit=3)
        quota_payload = None
        if bucket_limit:
            quota_payload = {
                "limit": bucket_limit,
                "remaining": remaining if remaining is not None else bucket_limit,
                "windowSeconds": RATE_LIMIT_WINDOW,
            }
            if retry_after is not None:
                quota_payload["resetSeconds"] = retry_after

        return (
            jsonify(
                {
                    "answer": answer,
                    "subject": subject,
                    "provider": "groq",
                    "quota": quota_payload,
                    "sources": sources,
                    "uploads": upload_meta,
                    "mode": mode,
                }
            ),
            200,
        )

    except Exception as e:
        app.logger.error(f"Groq error: {e}")
        return jsonify({"error": str(e)}), 503


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port)
