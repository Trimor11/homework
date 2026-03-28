import os
import time
from collections import defaultdict

import requests
from flask import Flask, request, jsonify
from flask_cors import CORS

app = Flask(__name__)
CORS(app, origins=["*"])

HF_API_KEY = os.environ.get("HF_API_KEY")
if not HF_API_KEY:
    raise Exception("Missing HF_API_KEY environment variable")

RATE_LIMIT_REQUESTS = 10
RATE_LIMIT_WINDOW = 60
rate_store = defaultdict(list)

SUBJECT_KEYWORDS = {
    "math": [
        "equation", "solve", "calculate", "integral", "derivative", "algebra",
        "geometry", "polynomial", "prime", "factor", "matrix", "+", "-", "×", "÷",
        "percent", "ratio", "probability", "statistics", "calculus"
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

def is_rate_limited(ip: str) -> bool:
    now = time.time()
    window_start = now - RATE_LIMIT_WINDOW
    rate_store[ip] = [t for t in rate_store[ip] if t > window_start]
    if len(rate_store[ip]) >= RATE_LIMIT_REQUESTS:
        return True
    rate_store[ip].append(now)
    return False

def detect_subject(question: str) -> str:
    q_lower = question.lower()
    scores = {subject: 0 for subject in SUBJECT_KEYWORDS}
    for subject, keywords in SUBJECT_KEYWORDS.items():
        for kw in keywords:
            if kw in q_lower:
                scores[subject] += 1
    best = max(scores, key=scores.get)
    return best if scores[best] > 0 else "general"

def generate_with_huggingface(question: str, subject: str, simplify: bool) -> str:
    api_url = "https://api-inference.huggingface.co/models/google/flan-t5-base"

    prompt = (
        f"You are a helpful homework tutor.\n"
        f"Subject: {subject}\n"
        f"Task: Explain the answer step by step in simple language.\n"
        f"Rules: Start each step with 'Step 1:', 'Step 2:', etc. End with 'Summary:'.\n"
    )

    if simplify:
        prompt += "Use even easier words and shorter explanations.\n"

    prompt += f"\nQuestion: {question}\nAnswer:"

    headers = {
        "Authorization": f"Bearer {HF_API_KEY}"
    }

    payload = {
        "inputs": prompt,
        "parameters": {
            "max_new_tokens": 300,
            "temperature": 0.3,
            "return_full_text": False
        }
    }

    response = requests.post(api_url, headers=headers, json=payload, timeout=60)
    data = response.json()

    if response.status_code != 200:
        raise Exception(f"Hugging Face API error: {data}")

    if isinstance(data, list) and len(data) > 0 and "generated_text" in data[0]:
        return data[0]["generated_text"].strip()

    raise Exception(f"Unexpected Hugging Face response: {data}")

@app.route("/", methods=["GET"])
def home():
    return jsonify({"status": "Backend running with Hugging Face"}), 200

@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ok"}), 200

@app.route("/solve", methods=["POST"])
def solve():
    ip = request.headers.get("X-Forwarded-For", request.remote_addr)

    if is_rate_limited(ip):
        return jsonify({"error": "Rate limit exceeded. Please wait a minute and try again."}), 429

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
        answer = generate_with_huggingface(question, subject, simplify)
        return jsonify({
            "answer": answer,
            "subject": subject,
            "provider": "huggingface"
        }), 200
    except Exception as e:
        app.logger.error(f"Hugging Face error: {e}")
        return jsonify({
            "error": "AI service temporarily unavailable. Please try again shortly."
        }), 503

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port)
