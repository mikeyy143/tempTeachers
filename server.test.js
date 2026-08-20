"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { isAllowedDigialmUrl, extractToken, extractAnswerSheetUrl, extractAnswerSheetRecords } = require("./server");

test("allows HTTPS Digialm hosts only", () => {
  assert.equal(isAllowedDigialmUrl("https://cdn3.digialm.com/result/E1.html"), true);
  assert.equal(isAllowedDigialmUrl("https://digialm.com/result/E1.html"), true);
  assert.equal(isAllowedDigialmUrl("http://cdn3.digialm.com/result/E1.html"), false);
  assert.equal(isAllowedDigialmUrl("https://digialm.com.evil.example/result.html"), false);
  assert.equal(isAllowedDigialmUrl("https://example.com/result.html"), false);
});

test("extracts authentication tokens from top-level and nested responses", () => {
  assert.equal(extractToken({ accessToken: "abc" }), "abc");
  assert.equal(extractToken({ data: { token: "nested" } }), "nested");
});

test("extracts the first answer-sheet URL", () => {
  assert.equal(
    extractAnswerSheetUrl({ data: [{ candidate_name: "A" }, { qp_html_path: "https://cdn3.digialm.com/result.html" }] }),
    "https://cdn3.digialm.com/result.html"
  );
  assert.throws(() => extractAnswerSheetUrl({ data: [] }), /No answer-sheet URL/);
});

test("preserves every paper answer-sheet record", () => {
  const records = extractAnswerSheetRecords({
    data: [
      { paper_id: "paper_1_a", qp_html_path: "https://cdn3.digialm.com/paper-1.html" },
      { paper_id: "paper_2_a", qp_html_path: "https://cdn3.digialm.com/paper-2.html" }
    ]
  });
  assert.deepEqual(records.map((record) => record.paper_id), ["paper_1_a", "paper_2_a"]);
});
