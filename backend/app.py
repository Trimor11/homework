import os
import time
from collections import defaultdict

import requests
from flask import Flask, request, jsonify
from flask_cors import CORS

app = Flask(__name__)
CORS(app, origins=["*"])

GROQ_API_KEY = os.environ.get("GROQ_API_KEY")
if not GROQ_API_KEY:
    raise Exception("Missing GROQ_API_KEY environment variable")

GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"
GROQ_MODEL = "llama3-8b-8192"  # free, fast, great answers

RATE_LIMIT_REQUESTS = 10
RATE_LIMIT_WINDOW = 60
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


def is_rate_limited(ip):
    now = time.time()
    window_start = now - RATE_LIMIT_WINDOW
    rate_store[ip] = [t for t in rate_store[ip] if t > window_start]
    if len(rate_store[ip]) >= RATE_LIMIT_REQUESTS:
        return True
    rate_store[ip].append(now)
    return False


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
            {"role": "user", "content": f"[Subject: {subject.upper()}]\n\n{question}"}
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
    ip = request.headers.get("X-Forwarded-For", request.remote_addr)

    if is_rate_limited(ip):
        return jsonify({"error": "Rate limit exceeded. Please wait a minute."}), 429

    data = request.get_json(silent=True)
    if not data:
        return jsonify({"error": "Invalid JSON body."}), 400

    question = data.get("question", "").strip()
    simplify = data.get("simplify", False)

    if not question:
        return jsonify({"error": "Question cannot be empty."}), 400
    if len(question) > 1500:
        return jsonify({"error": "Question is too long (max 1500 characters)."}), 400

    subject = detect_subject(question)

    try:
        answer = generate_with_groq(question, subject, simplify)
        return jsonify({
            "answer": answer,
            "subject": subject,
            "provider": "groq"
        }), 200

    except Exception as e:
        app.logger.error(f"Groq error: {e}")
        return jsonify({"error": str(e)}), 503


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port)
