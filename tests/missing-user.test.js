const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const code = fs.readFileSync(path.join(__dirname, "../console.js"), "utf8");

function createFixture(mode) {
  const comments = [];
  const posts = [{
    id: "requested-story",
    content: "!'rate_GESCP'정보",
    user: { id: "author", nickname: "MINDCAP" }
  }];
  const storage = new Map();
  const browser = {
    console: { log() {}, table() {}, warn() {} },
    location: { origin: "https://playentry.org", pathname: "/community/entrystory/list" },
    localStorage: {
      getItem(k) { return storage.get(k) || null; },
      setItem(k, v) { storage.set(k, v); }
    },
    setInterval() { return 1; },
    clearInterval() {},
    document: {
      querySelector() { return { content: "csrf" }; },
      getElementById() { return null; }
    },
    window: {
      confirm() { return false; },
      __NEXT_DATA__: { props: {
        initialProps: { csrfToken: "csrf" },
        pageProps: { initialState: { common: {
          user: { id: "bot", xToken: "demo" }
        } } }
      } }
    },
    async fetch(url, init) {
      if (url.endsWith("/graphql/getUsers")) {
        if (mode === "offline") throw new TypeError("Network unavailable");
        const users = mode === "absent" ? [] : [
          { id: "0123456789abcdef01234567", nickname: "rate_GESCP" }
        ];
        return { ok: true, status: 200, json: async () => ({
          data: { getUsers: { total: users.length, list: users } }
        }) };
      }
      const request = JSON.parse(init.body);
      const query = request.query;
      let data = null;
      if (query.includes("discussList(")) data = { discussList: { list: posts } };
      else if (query.includes("user(nickname:") || query.includes("userList(")) {
        return { ok: false, status: 400,
          json: async () => ({ errors: [{ message: "Invalid operation" }] }) };
      } else if (query.includes("createComment(")) {
        comments.push(request.variables);
        data = { createComment: { warning: null, comment: { id: "comment-id" } } };
      } else if (query.includes("userstatus(")) {
        data = { userstatus: { id: "0123456789abcdef01234567", nickname: "rate_GESCP",
          status: { project: 0, follower: 6, following: 1 } } };
      } else throw new Error("Unknown test operation");
      return { ok: true, status: 200, json: async () => ({ data }) };
    }
  };
  vm.runInNewContext(code, browser, { filename: "console.js" });
  return { bot: browser.window.EntryInfoBot, comments };
}

test("a complete empty user search gets the exact nonexistent-user response", async () => {
  const f = createFixture("absent");
  await f.bot.replyToRecentCommand("rate_GESCP");
  assert.equal(f.comments.length, 1);
  assert.equal(f.comments[0].target, "requested-story");
  assert.equal(f.comments[0].content, "그런 유저 없음");
  f.bot.stop();
});

test("an offline user search never makes a false nonexistent claim or drops the request", async () => {
  const f = createFixture("offline");
  const initial = await f.bot.replyToRecentCommand("rate_GESCP");
  assert.equal(initial.pending, 1);
  assert.equal(f.comments.length, 0);
  await f.bot.tick();
  assert.equal(f.comments.length, 0);
  await f.bot.tick();
  assert.equal(f.comments.length, 1);
  assert.equal(f.comments[0].target, "requested-story");
  assert.match(f.comments[0].content, /현재 유저 정보를 확인할 수 없습니다/);
  assert.doesNotMatch(f.comments[0].content, /그런 유저 없음/);
  assert.equal(f.bot.status().queued, 0);
  f.bot.stop();
});
