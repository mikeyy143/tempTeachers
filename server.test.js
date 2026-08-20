"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { isAllowedDigialmUrl } = require("./server");

test("allows HTTPS Digialm hosts only", () => {
  assert.equal(isAllowedDigialmUrl("https://cdn3.digialm.com/result/E1.html"), true);
  assert.equal(isAllowedDigialmUrl("https://digialm.com/result/E1.html"), true);
  assert.equal(isAllowedDigialmUrl("http://cdn3.digialm.com/result/E1.html"), false);
  assert.equal(isAllowedDigialmUrl("https://digialm.com.evil.example/result.html"), false);
  assert.equal(isAllowedDigialmUrl("https://example.com/result.html"), false);
});
