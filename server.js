"use strict";

const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const sharp = require("sharp");
const { createWorker } = require("tesseract.js");

const PORT = Number(process.env.PORT) || 3001;
const MAX_HTML_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const ALLOWED_HOST_SUFFIX = ".digialm.com";
const API_BASE_URL = "https://api.apdsc.apcfss.in";
const API_ORIGIN = "https://tet2dsc.apcfss.in";
const CAPTCHA_URL = `${API_BASE_URL}/apdscapi/dsc-public/generate-captcha`;
const AUTH_URL = `${API_BASE_URL}/apdscapi/auth/candidate-authenticate`;
const ANSWER_SHEET_URL = `${API_BASE_URL}/apdscreadapi/tet-ans-sheet`;

const CAPTCHA_LEN = Number(process.env.CAPTCHA_LEN) || 0; // 0 = any length
const MAX_CAPTCHA_ATTEMPTS = 6;
const MIN_AGREEMENT = 0.5;   // fraction of variants that must agree
const MIN_CONFIDENCE = 60;   // tesseract confidence of the winning read
const THRESHOLDS = [100, 120, 140, 160, 180];

/* ---------------- OCR (tesseract.js + sharp) ---------------- */

let workerPromise = null;
let ocrQueue = Promise.resolve();

function getWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      const worker = await createWorker("eng");
      await worker.setParameters({
        tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
        tessedit_pageseg_mode: "7"
      });
      return worker;
    })();
  }
  return workerPromise;
}

async function buildVariants(buffer) {
  const meta = await sharp(buffer).metadata();
  const width = (meta.width || 150) * 3;
  const base = () =>
    sharp(buffer)
      .flatten({ background: "#ffffff" })
      .grayscale()
      .resize({ width, kernel: "cubic" })
      .normalise();
  const pad = { top: 10, bottom: 10, left: 10, right: 10, background: "#ffffff" };

  const variants = [];
  for (const t of THRESHOLDS) {
    variants.push(await base().median(3).threshold(t).extend(pad).png().toBuffer());
  }
  variants.push(await base().median(3).sharpen().extend(pad).png().toBuffer());
  variants.push(await base().blur(0.8).threshold(150).extend(pad).png().toBuffer());
  return variants;
}

async function runOcr(captchaDataUrl) {
  const buffer = Buffer.from(captchaDataUrl.split(",").pop(), "base64");
  const variants = await buildVariants(buffer);
  const worker = await getWorker();

  const reads = [];
  for (const img of variants) {
    const { data } = await worker.recognize(img);
    const text = (data.text || "").replace(/[^A-Za-z0-9]/g, "");
    if (!text) continue;
    if (CAPTCHA_LEN && text.length !== CAPTCHA_LEN) continue;
    reads.push({ text, confidence: data.confidence || 0 });
  }
  if (!reads.length) return { ok: false, text: "", confidence: 0, agreement: 0 };

  const votes = new Map();
  for (const r of reads) votes.set(r.text, (votes.get(r.text) || 0) + 1);
  const [text, count] = [...votes.entries()].sort((a, b) => b[1] - a[1])[0];
  const confidence = Math.max(...reads.filter((r) => r.text === text).map((r) => r.confidence));
  const agreement = count / variants.length;
  return { ok: agreement >= MIN_AGREEMENT && confidence >= MIN_CONFIDENCE, text, confidence, agreement };
}

function solveCaptcha(captchaDataUrl) {
  // tesseract worker handles one job at a time, so serialize
  const job = ocrQueue.then(() => runOcr(captchaDataUrl));
  ocrQueue = job.catch(() => {});
  return job;
}

/* ---------------- Existing logic ---------------- */

function isAllowedDigialmUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === "https:" &&
    (url.hostname === "digialm.com" || url.hostname.endsWith(ALLOWED_HOST_SUFFIX));
}

async function fetchDigialmHtml(initialUrl) {
  let currentUrl = initialUrl;
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    if (!isAllowedDigialmUrl(currentUrl)) {
      throw new Error("Only HTTPS URLs on digialm.com domains are allowed.");
    }

    const response = await fetch(currentUrl, {
      redirect: "manual",
      headers: {
        "user-agent": "Digialm Score Calculator/1.0",
        "accept": "text/html,application/xhtml+xml"
      },
      signal: AbortSignal.timeout(15_000)
    });

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw new Error("Digialm returned a redirect without a location.");
      currentUrl = new URL(location, currentUrl).href;
      continue;
    }

    if (!response.ok) throw new Error(`Digialm returned HTTP ${response.status}.`);
    const contentLength = Number(response.headers.get("content-length"));
    if (contentLength > MAX_HTML_BYTES) throw new Error("The result page is too large to process.");

    const html = await response.text();
    if (Buffer.byteLength(html) > MAX_HTML_BYTES) throw new Error("The result page is too large to process.");
    return html;
  }
  throw new Error("Too many redirects from Digialm.");
}

function apiHeaders(cookie) {
  return {
    accept: "application/json",
    "content-type": "application/json",
    origin: API_ORIGIN,
    referer: `${API_ORIGIN}/`,
    ...(cookie ? { cookie } : {})
  };
}

function mergeCookies(existing, setCookieHeaders) {
  const cookies = new Map();
  for (const cookie of existing.split("; ")) {
    const separator = cookie.indexOf("=");
    if (separator > 0) cookies.set(cookie.slice(0, separator), cookie.slice(separator + 1));
  }
  for (const header of setCookieHeaders || []) {
    const separator = header.indexOf("=");
    if (separator > 0) {
      const end = header.indexOf(";", separator);
      cookies.set(header.slice(0, separator), header.slice(separator + 1, end < 0 ? header.length : end));
    }
  }
  return Array.from(cookies, ([name, value]) => `${name}=${value}`).join("; ");
}

async function fetchApiJson(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(30_000) });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`APDSc API returned HTTP ${response.status}.`);
  if (!data || typeof data !== "object") throw new Error("APDSc API returned an invalid response.");
  return { data, cookies: response.headers.getSetCookie ? response.headers.getSetCookie() : [] };
}

function extractToken(authData) {
  const fields = ["token", "access_token", "accessToken", "jwt", "id_token", "authorization"];
  for (const field of fields) {
    if (authData[field]) return authData[field];
  }
  if (authData.data && typeof authData.data === "object") {
    for (const field of fields) {
      if (authData.data[field]) return authData.data[field];
    }
  }
  throw new Error("Could not find a bearer token in the authentication response.");
}

function extractAnswerSheetUrl(answerData) {
  return extractAnswerSheetRecords(answerData)[0].qp_html_path;
}

function extractAnswerSheetRecords(answerData) {
  const records = Array.isArray(answerData.data)
    ? answerData.data.filter((item) => item && item.qp_html_path)
    : [];
  if (!records.length) throw new Error("No answer-sheet URL was returned for this account.");
  return records;
}

async function generateCaptcha() {
  const result = await fetchApiJson(CAPTCHA_URL, {
    method: "POST",
    headers: apiHeaders(),
    body: "{}"
  });
  if (!result.data.status || !result.data.captchaId || !result.data.captcha) {
    throw new Error("CAPTCHA generation failed.");
  }
  const captcha = result.data.captcha.replace(String.raw`data\:`, "data:");
  if (!captcha.includes(",")) throw new Error("The CAPTCHA response did not contain an image.");
  return { captchaId: result.data.captchaId, captcha, cookie: mergeCookies("", result.cookies) };
}

async function fetchAuthenticatedDigialmHtml({ username, password, captcha, captchaId, cookie = "" }) {
  if (![username, password, captcha, captchaId].every((value) => typeof value === "string" && value.trim())) {
    throw new Error("Username, password, CAPTCHA, and CAPTCHA ID are required.");
  }

  const authResult = await fetchApiJson(AUTH_URL, {
    method: "POST",
    headers: apiHeaders(cookie),
    body: JSON.stringify({ username, password, captcha, captchaId })
  });
  if (!authResult.data.status) {
    throw new Error(authResult.data.message || authResult.data.sdesc || "Authentication failed.");
  }
  const token = extractToken(authResult.data);
  const authCookie = mergeCookies(cookie, authResult.cookies);
  const answerResult = await fetchApiJson(ANSWER_SHEET_URL, {
    method: "GET",
    headers: { ...apiHeaders(authCookie), authorization: token.toLowerCase().startsWith("bearer ") ? token : `Bearer ${token}` }
  });
  const records = extractAnswerSheetRecords(answerResult.data);
  return Promise.all(records.map(async (record, index) => {
    if (!isAllowedDigialmUrl(record.qp_html_path)) {
      throw new Error(`The returned answer-sheet URL for paper ${index + 1} is not valid.`);
    }
    return {
      html: await fetchDigialmHtml(record.qp_html_path),
      examId: record.exam_id || "",
      paperId: record.paper_id || "",
      subjectName: record.subject_name || `Paper ${index + 1}`
    };
  }));
}

/* ---------------- Auto captcha flow ---------------- */

async function fetchWithAutoCaptcha({ username, password }) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_CAPTCHA_ATTEMPTS; attempt++) {
    const { captchaId, captcha, cookie } = await generateCaptcha();
    const solved = await solveCaptcha(captcha);
    console.log(`attempt ${attempt}: read="${solved.text}" conf=${solved.confidence.toFixed(0)} agree=${solved.agreement.toFixed(2)} ok=${solved.ok}`);
    if (!solved.ok) {
      lastError = new Error("Low-confidence captcha read.");
      continue;
    }
    try {
      return await fetchAuthenticatedDigialmHtml({
        username, password, captcha: solved.text, captchaId, cookie
      });
    } catch (error) {
      console.log("auth error:", error.message);
      lastError = error;
      if (!/captcha|HTTP 4\d\d/i.test(error.message || "")) throw error;
    }
  }
  throw lastError || new Error("Captcha could not be solved.");
}

/* ---------------- HTTP server ---------------- */

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(payload));
}

async function requestHandler(request, response) {
  const requestUrl = new URL(request.url, `http://${request.headers.host || "localhost"}`);

  if (request.method === "GET" && requestUrl.pathname === "/api/captcha") {
    try {
      return sendJson(response, 200, await generateCaptcha());
    } catch (error) {
      return sendJson(response, 502, { error: error.message || "Could not generate the CAPTCHA." });
    }
  }

  if (request.method === "POST" && requestUrl.pathname === "/api/digialm-result-auto") {
    try {
      const papers = await fetchWithAutoCaptcha(await readJsonBody(request));
      return sendJson(response, 200, { papers });
    } catch (error) {
      return sendJson(response, 502, { error: error.message || "Auto login failed." });
    }
  }

  if (request.method === "POST" && requestUrl.pathname === "/api/digialm-result") {
    try {
      const papers = await fetchAuthenticatedDigialmHtml(await readJsonBody(request));
      return sendJson(response, 200, { papers });
    } catch (error) {
      return sendJson(response, 502, { error: error.message || "Could not fetch the authenticated Digialm result." });
    }
  }

  if (request.method === "GET" && requestUrl.pathname === "/api/digialm-result") {
    const resultUrl = requestUrl.searchParams.get("url");
    if (!resultUrl || !isAllowedDigialmUrl(resultUrl)) {
      return sendJson(response, 400, { error: "Enter an HTTPS URL on a Digialm domain." });
    }
    try {
      const html = await fetchDigialmHtml(resultUrl);
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
      return response.end(html);
    } catch (error) {
      return sendJson(response, 502, { error: error.message || "Could not fetch the Digialm result." });
    }
  }

  if (request.method === "GET" && (requestUrl.pathname === "/" || requestUrl.pathname === "/index.html")) {
    try {
      const html = await fs.readFile(path.join(__dirname, "index.html"));
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "x-content-type-options": "nosniff" });
      return response.end(html);
    } catch {
      return sendJson(response, 500, { error: "Could not load the application." });
    }
  }

  return sendJson(response, 404, { error: "Not found." });
}

async function readJsonBody(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body) > 20 * 1024) throw new Error("Request body is too large.");
  }
  try {
    return JSON.parse(body || "{}");
  } catch {
    throw new Error("Request body must be valid JSON.");
  }
}

if (require.main === module) {
  getWorker().then(() => {
    http.createServer(requestHandler).listen(PORT, () => {
      console.log(`Digialm Score Calculator running at http://localhost:${PORT}`);
    });
  });
}

module.exports = { isAllowedDigialmUrl, fetchDigialmHtml, extractToken, extractAnswerSheetUrl, extractAnswerSheetRecords, requestHandler, solveCaptcha };