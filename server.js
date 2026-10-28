const express = require("express");
const path = require("path");
const { createWorker } = require("tesseract.js");

const BASE = "https://api.apdsc.apcfss.in";
const PORT = process.env.PORT || 3000;
const MAX_RETRIES = 3;
const CREDENTIAL_ERROR = /password|username|credential|invalid user|user not found|locked|blocked/i;

const httpError = (status, message) => Object.assign(new Error(message), { status });

// One shared OCR worker, created on first use.
let workerPromise;
const getWorker = () =>
  (workerPromise ||= (async () => {
    const w = await createWorker("eng");
    await w.setParameters({ tessedit_char_whitelist: "0123456789" });
    return w;
  })());

async function readJson(res) {
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

async function solveCaptcha() {
  const res = await fetch(`${BASE}/emptetapi/dsc-public/generate-captcha`, { method: "POST" });
  const r = await readJson(res);
  if (!r.captcha) throw httpError(502, "Could not get a captcha from the portal.");
  const buf = Buffer.from(r.captcha.split(",")[1], "base64");
  const worker = await getWorker();
  const { data } = await worker.recognize(buf);
  return { captchaId: r.captchaId, captcha: data.text.replace(/\D/g, "") };
}

function findToken(r) {
  return (
    r?.data?.token || r?.data?.accessToken || r?.data?.access_token ||
    r?.token || r?.accessToken || r?.access_token ||
    (typeof r?.data === "string" ? r.data : null)
  );
}

async function login(username, password) {
  let lastMsg = "";
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const { captchaId, captcha } = await solveCaptcha();
    if (captcha.length < 4) { lastMsg = "The captcha could not be read."; continue; }

    const res = await fetch(`${BASE}/emptetapi/auth/candidate-authenticate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ captcha, captchaId, password, username }),
    });
    const body = await readJson(res);
    const token = findToken(body);
    if (res.ok && body.status !== false && token) return { token, attempts: attempt };

    lastMsg = body.sdesc || body.message || body.error || `Portal returned ${res.status}`;
    // Wrong credentials: stop now instead of retrying and risking a lockout.
    if (CREDENTIAL_ERROR.test(lastMsg) && !/captcha/i.test(lastMsg)) throw httpError(401, lastMsg);
  }
  throw httpError(502, `Sign-in failed after ${MAX_RETRIES} attempts. Last message: ${lastMsg}`);
}

function analyse(sheet) {
  const details = sheet.data?.["Participant Details"]?.[0] || {};
  const qs = sheet.data?.["Question Wise Details"] || [];
  const sections = new Map();

  const questions = qs.map((q) => {
    const sel = q["Selected Option ID"];
    const cor = q["Correct Option ID"];
    let result;
    if (!sel) result = "skipped";
    else if (sel === cor) result = "correct";
    else if (q["Result"] === "Full Marks") result = "grace"; // dropped/graced question
    else result = "wrong";

    const name = q["Section Name"];
    const s = sections.get(name) || { name, correct: 0, wrong: 0, skipped: 0, grace: 0, total: 0 };
    s[result]++;
    s.total++;
    sections.set(name, s);

    return {
      n: Number(q["Question Sr No"]),
      section: name,
      marked: q["Selected Option Number"] || null,
      answer: q["Correct Option Text"],
      result,
    };
  });

  const count = (r) => questions.filter((q) => q.result === r).length;
  const serverScore = Number(details["Score"]);

  return {
    name: details["Name"] || "",
    subject: details["Subject"] || "",
    total: questions.length,
    max: Number(details["Maximum Marks"]) || questions.length,
    correct: count("correct"),
    wrong: count("wrong"),
    skipped: count("skipped"),
    grace: count("grace"),
    score: count("correct") + count("grace"),
    serverScore: Number.isNaN(serverScore) ? null : serverScore,
    sections: [...sections.values()],
    questions,
  };
}

const app = express();
const liveServerOrigin = /^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/;
app.use((req, res, next) => {
  const origin = req.get("Origin");
  if (origin && liveServerOrigin.test(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});
app.use(express.json({ limit: "10kb" }));
app.use(express.static(path.join(__dirname, "public")));

app.post("/api/score", async (req, res) => {
  const username = String(req.body?.username || "").trim();
  const password = String(req.body?.password || "");
  if (!username || !password) {
    return res.status(400).json({ error: "Enter both your username and password." });
  }

  try {
    const { token, attempts } = await login(username, password);
    const headers = { Authorization: `Bearer ${token}` };

    const abs = await readJson(await fetch(`${BASE}/emptetreadapi/tet-response-sheet-abstract`, { headers }));
    if (!abs.data?.length) throw httpError(404, "No response sheet was found for this login.");

    const exams = [];
    for (const exam of abs.data) {
      const sheet = await readJson(
        await fetch(`${BASE}/emptetreadapi/tet-response-sheet-stream?examId=${encodeURIComponent(exam.exam_id)}`, { headers })
      );
      if (!sheet.data) throw httpError(502, `The portal returned no data for ${exam.subject_name}.`);
      exams.push({
        hallticket: exam.hallticket,
        date: exam.exam_date,
        time: exam.exam_time,
        ...analyse(sheet),
      });
    }
    res.json({ attempts, exams });
  } catch (e) {
    console.error("score error:", e.message); // never log credentials
    res.status(e.status || 500).json({ error: e.message || "Something went wrong." });
  }
});

app.listen(PORT, () => console.log(`Open http://localhost:${PORT}`));