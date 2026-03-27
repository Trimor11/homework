import os
import time
from collections import defaultdict
from flask import Flask, request, jsonify
from flask_cors import CORS
from openai import OpenAI

app = Flask(__name__)
CORS(app, origins=["*"])  # Restrict to your domain in production

client = OpenAI(api_key=os.environ.get("OPENAI_API_KEY"))

# ── Rate limiting (in-memory, per IP) ──────────────────────────────────────
RATE_LIMIT_REQUESTS = 10       # max requests
RATE_LIMIT_WINDOW   = 60       # per N seconds
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

def detect_subject(question: str) -> str:
    q_lower = question.lower()
    scores = {subject: 0 for subject in SUBJECT_KEYWORDS}
    for subject, keywords in SUBJECT_KEYWORDS.items():
        for kw in keywords:
            if kw.lower() in q_lower:
                scores[subject] += 1
    best = max(scores, key=scores.get)
    return best if scores[best] > 0 else "general"

# ── Solve endpoint ─────────────────────────────────────────────────────────
@app.route("/solve", methods=["POST"])
def solve():
    ip = request.headers.get("X-Forwarded-For", request.remote_addr)

    if is_rate_limited(ip):
        return jsonify({"error": "Rate limit exceeded. Please wait a minute before trying again."}), 429

    data = request.get_json(silent=True)
    if not data:
        return jsonify({"error": "Invalid JSON body."}), 400

    question = data.get("question", "").strip()
    simplify  = data.get("simplify", False)   # "Explain simpler" button

    if not question:
        return jsonify({"error": "Question cannot be empty."}), 400
    if len(question) > 1500:
        return jsonify({"error": "Question is too long (max 1500 characters)."}), 400

    subject = detect_subject(question)

    system_prompt = (
        "You are a friendly, patient teacher helping a student with their homework. "
        "Always break your answer into clear, numbered steps. "
        "Use simple language appropriate for students. "
        "Start each step with 'Step N:'. "
        "End with a short 'Summary:' line. "
        "Do not include unnecessary filler text or apologies. "
        "Be concise but thorough."
    )
    if simplify:
        system_prompt += (
            " The student found the previous explanation too complex. "
            "Use even simpler words, shorter sentences, and analogies where helpful."
        )

    user_message = f"[Subject: {subject.upper()}]\n\n{question}"

    try:
        response = client.chat.completions.create(
            model="gpt-4.1-mini",
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user",   "content": user_message},
            ],
            max_tokens=800,
            temperature=0.4,
        )
        answer = response.choices[0].message.content.strip()
        if not answer:
            return jsonify({"error": "AI returned an empty response. Please try again."}), 500

        return jsonify({
            "answer":  answer,
            "subject": subject,
        })

    except Exception as e:
        app.logger.error(f"OpenAI error: {e}")
        return jsonify({"error": "AI service temporarily unavailable. Please try again shortly."}), 503

# ── Health check ───────────────────────────────────────────────────────────
@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ok"}), 200

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port)