"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const core = require("../core.js");

test("comment and post inputs explicitly disable visual soft wrapping", () => {
  const html = fs.readFileSync(path.join(__dirname, "../popup.html"), "utf8");
  for (const id of ["commentMessages", "postMessages"]) {
    assert.match(html, new RegExp('<textarea[^>]*id="' + id + '"[^>]*wrap="off"'));
  }
});
test("a long message without Enter remains a single scheduled item", () => {
  const message = "이것은 확프로 쓴 홍보글 " + "ㅇ".repeat(160);
  assert.deepEqual(core.parseMessages(message), [message]);
});
test("only explicit Enter separates scheduled items", () => {
  const one = "이것은 확프로 쓴 홍보글 " + "ㅇ".repeat(40);
  const two = "둘째 문구";
  assert.deepEqual(core.parseMessages(one + "\n" + two), [one, two]);
});
