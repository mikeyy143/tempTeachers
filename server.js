"use strict";

const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");

const PORT = Number(process.env.PORT) || 3001;
const MAX_HTML_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const ALLOWED_HOST_SUFFIX = ".digialm.com";

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

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(payload));
}

async function requestHandler(request, response) {
  const requestUrl = new URL(request.url, `http://${request.headers.host || "localhost"}`);
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

if (require.main === module) {
  http.createServer(requestHandler).listen(PORT, () => {
    console.log(`Digialm Score Calculator running at http://localhost:${PORT}`);
  });
}

module.exports = { isAllowedDigialmUrl, fetchDigialmHtml, requestHandler };
