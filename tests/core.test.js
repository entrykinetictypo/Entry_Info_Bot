const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("../src/core.js");

test("quoted exact nickname command", () => {
  assert.equal(core.parseCommand("!'12옴'정보"), "12옴");
  assert.equal(core.parseCommand("!'가 나 다'정보"), "가 나 다");
  assert.equal(core.parseCommand("!'A-b_1'정보"), "A-b_1");
  assert.equal(core.parseCommand("!'없는사람'정보 "), "없는사람");
});

test("invalid commands are ignored", () => {
  for (const text of ["!12옴정보", "!'12옴' 정보", "!'12옴'정보요", "!'12옴'", "안녕", "!'   '정보", "!'a'b'정보"]) {
    assert.equal(core.parseCommand(text), null, text);
  }
});

test("Entry story markup is converted to plain text", () => {
  assert.equal(core.normalizePostText("<p>!'12옴'정보</p>"), "!'12옴'정보");
  assert.equal(core.parseCommand(core.normalizePostText("<div>!&#39;12옴&#39;정보</div>")), "12옴");
});

test("counts ranked and staff-picked projects and excludes private projects", () => {
  assert.deepEqual(core.summarizeProjects([
    { ranked: null, staffPicked: null, isopen: true },
    { ranked: 1, staffPicked: null, isopen: true },
    { ranked: null, staffPicked: 1, isopen: true },
    { ranked: 0, staffPicked: 0, isopen: true },
    { ranked: 1, staffPicked: 1, isopen: false }
  ]), { popular: 2, staff: 2, counted: 4 });
});

test("reply formatting", () => {
  assert.equal(core.formatUserInfo({
    nickname: "12옴",
    status: { project: 4, follower: 1200, following: 3 }
  }, { popular: 2, staff: 1 }), [
    "📊 12옴님의 정보",
    "작품 수: 4개",
    "팔로워 수: 1,200명",
    "팔로잉 수: 3명",
    "인작 수: 2개",
    "스선 수: 1개"
  ].join("\n"));
});
