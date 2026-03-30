import hashlib
import os
import time
from collections import defaultdict

import requests
from flask import Flask, request, jsonify
from flask_cors import CORS
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
