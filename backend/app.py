import hashlib
import json
import os
import time
from collections import defaultdict
from pathlib import Path

import requests
from flask import Flask, request, jsonify
from flask_cors import CORS
import stripe
from google.auth.transport import requests as google_requests
from google.oauth2 import id_token as google_id_token

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

firebase_request_adapter = google_requests.Request()

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
    if not bucket_key or bucket_limit is None:
        return False, None, None

    now = time.time()
    window_start = now - RATE_LIMIT_WINDOW
    hits = rate_store[bucket_key]
    hits[:] = [t for t in hits if t > window_start]

    if len(hits) >= bucket_limit:
        retry_after = max(0, int(hits[0] + RATE_LIMIT_WINDOW - now))
        return True, 0, retry_after

    hits.append(now)
    remaining = max(0, bucket_limit - len(hits))
    return False, remaining, None


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


def generate_with_groq(question, subject, simplify):
    system_prompt = (
        "You are a friendly homework tutor. "
        "Always break your answer into clear numbered steps starting with 'Step 1:', 'Step 2:', etc. "
        "End every answer with a short 'Summary:' line. "
        "Use simple language a student can understand. Be concise."
    )
    if simplify:
        system_prompt += " Use very simple words and short sentences with analogies."

    headers = {
        "Authorization": f"Bearer {GROQ_API_KEY}",
        "Content-Type": "application/json"
    }

    payload = {
        "model": GROQ_MODEL,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user",   "content": f"[Subject: {subject.upper()}]\n\n{question}"}
        ],
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
def home():
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

        response = jsonify(payload)
        if retry_after is not None:
            response.headers["Retry-After"] = str(retry_after)
        return response, 429

    data = request.get_json(silent=True)
    if not data:
        return jsonify({"error": "Invalid JSON body."}), 400

    question = data.get("question", "").strip()
    simplify  = data.get("simplify", False)

    if not question:
        return jsonify({"error": "Question cannot be empty."}), 400
    if len(question) > 1500:
        return jsonify({"error": "Question is too long (max 1500 characters)."}), 400

    subject = detect_subject(question)

    try:
        answer = generate_with_groq(question, subject, simplify)
        quota_payload = None
        if bucket_limit:
            quota_payload = {
                "limit": bucket_limit,
                "remaining": remaining if remaining is not None else bucket_limit,
                "windowSeconds": RATE_LIMIT_WINDOW,
            }

        return (
            jsonify(
                {
                    "answer": answer,
                    "subject": subject,
                    "provider": "groq",
                    "quota": quota_payload,
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

OWNER_EMAILS = {
    email.strip().lower()
    for email in os.environ.get("OWNER_EMAILS", "").split(",")
    if email.strip()
} or DEFAULT_OWNER_EMAILS

FIREBASE_PROJECT_ID = os.environ.get("FIREBASE_PROJECT_ID")
AUTH_REQUEST_LIMIT = int(os.environ.get("AUTH_REQUESTS_PER_MINUTE", "30"))
GUEST_REQUEST_LIMIT = int(os.environ.get("GUEST_REQUESTS_PER_MINUTE", "10"))
RATE_LIMIT_WINDOW = int(os.environ.get("RATE_LIMIT_WINDOW_SECONDS", "60"))

firebase_request_adapter = google_requests.Request()

GROQ_API_KEY = os.environ.get("GROQ_API_KEY")
if not GROQ_API_KEY:
    raise Exception("Missing GROQ_API_KEY environment variable")

GROQ_URL   = "https://api.groq.com/openai/v1/chat/completions"
GROQ_MODEL = "llama-3.1-8b-instant"  # current free Groq model

rate_store = defaultdict(list)

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
        email = (identity.get("email") or "").lower().strip()
        if email and email in OWNER_EMAILS:
            return None, None

        key_source = identity.get("uid") or email
        if key_source:
            return f"user:{hash_identifier(key_source)}", AUTH_REQUEST_LIMIT

    hashed_ip = hash_identifier((ip_address or "anonymous").strip())
    return f"ip:{hashed_ip}", GUEST_REQUEST_LIMIT


def check_rate_limit(bucket_key, bucket_limit):
    if not bucket_key or bucket_limit is None:
        return False, None, None

    now = time.time()
    window_start = now - RATE_LIMIT_WINDOW
    hits = rate_store[bucket_key]
    hits[:] = [t for t in hits if t > window_start]

    if len(hits) >= bucket_limit:
        retry_after = max(0, int(hits[0] + RATE_LIMIT_WINDOW - now))
        return True, 0, retry_after

    hits.append(now)
    remaining = max(0, bucket_limit - len(hits))
    return False, remaining, None


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


def generate_with_groq(question, subject, simplify):
    system_prompt = (
        "You are a friendly homework tutor. "
        "Always break your answer into clear numbered steps starting with 'Step 1:', 'Step 2:', etc. "
        "End every answer with a short 'Summary:' line. "
        "Use simple language a student can understand. Be concise."
    )
    if simplify:
        system_prompt += " Use very simple words and short sentences with analogies."

    headers = {
        "Authorization": f"Bearer {GROQ_API_KEY}",
        "Content-Type": "application/json"
    }

    payload = {
        "model": GROQ_MODEL,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user",   "content": f"[Subject: {subject.upper()}]\n\n{question}"}
        ],
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
def home():
    return jsonify({"status": "Backend running with Groq"}), 200


@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ok"}), 200


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

        response = jsonify(payload)
        if retry_after is not None:
            response.headers["Retry-After"] = str(retry_after)
        return response, 429

    data = request.get_json(silent=True)
    if not data:
        return jsonify({"error": "Invalid JSON body."}), 400

    question = data.get("question", "").strip()
    simplify  = data.get("simplify", False)

    if not question:
        return jsonify({"error": "Question cannot be empty."}), 400
    if len(question) > 1500:
        return jsonify({"error": "Question is too long (max 1500 characters)."}), 400

    subject = detect_subject(question)

    try:
        answer = generate_with_groq(question, subject, simplify)
        quota_payload = None
        if bucket_limit:
            quota_payload = {
                "limit": bucket_limit,
                "remaining": remaining if remaining is not None else bucket_limit,
                "windowSeconds": RATE_LIMIT_WINDOW,
            }

        return (
            jsonify(
                {
                    "answer": answer,
                    "subject": subject,
                    "provider": "groq",
                    "quota": quota_payload,
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
