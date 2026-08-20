"use strict";

const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");

const PORT = Number(process.env.PORT) || 3001;
const MAX_HTML_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const ALLOWED_HOST_SUFFIX = ".digialm.com";
const API_BASE_URL = "https://api.apdsc.apcfss.in";
const API_ORIGIN = "https://tet2dsc.apcfss.in";
const CAPTCHA_URL = `${API_BASE_URL}/apdscapi/dsc-public/generate-captcha`;
const AUTH_URL = `${API_BASE_URL}/apdscapi/auth/candidate-authenticate`;
const ANSWER_SHEET_URL = `${API_BASE_URL}/apdscreadapi/tet-ans-sheet`;

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
  http.createServer(requestHandler).listen(PORT, () => {
    console.log(`Digialm Score Calculator running at http://localhost:${PORT}`);
  });
}

module.exports = { isAllowedDigialmUrl, fetchDigialmHtml, extractToken, extractAnswerSheetUrl, extractAnswerSheetRecords, requestHandler };
