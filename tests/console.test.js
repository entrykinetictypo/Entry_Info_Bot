const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "../console.js"), "utf8");

function fixture(options = {}) {
  const storage = new Map();
  const fetchCalls = [];
  const comments = [];
  let interval = null;
  let initialPosts = [
    { id: "old", user: { id: "another", nickname: "작성자" }, content: "이미 있던 글" }
  ];
  let posts = options.posts || initialPosts;
  let nicknameFound = options.nicknameFound === undefined ? true : options.nicknameFound;
  let loggedIn = options.loggedIn === undefined ? true : options.loggedIn;
  let userCount = 0;
  let statusError = false;
  let failStatus = null;
  const quiet = { log() {}, table() {}, warn() {}, error() {} };
  const context = {
    console: quiet,
    setInterval(fn, ms) {
      assert.equal(ms, 30000);
      interval = fn;
      return 1;
    },
    clearInterval() { interval = null; },
    localStorage: {
      getItem(key) { return storage.has(key) ? storage.get(key) : null; },
      setItem(key, val) { storage.set(key, val); }
    },
    location: {
      origin: "https://playentry.org",
      pathname: "/community/entrystory/list"
    },
    document: {
      querySelector(selector) {
        if (selector.includes("csrf-token")) return { content: "csrf-from-page" };
        return null;
      },
      getElementById() { return null; }
    },
    window: {
      confirm() { return false; },
      __NEXT_DATA__: {
        props: {
          initialProps: { csrfToken: "csrf-from-page" },
          pageProps: {
            initialState: {
              common: {
                user: {
                  id: loggedIn ? "bot-id" : null,
                  xToken: loggedIn ? "token-from-page" : null
                }
              }
            }
          }
        }
      }
    },
    fetch: async (url, init) => {
      const operation = url.split("/").at(-1);
      const request = JSON.parse(init.body);
      fetchCalls.push({ operation, request, init });
      if (failStatus && operation === "SELECT_ENTRYSTORY") {
        return { ok: false, status: failStatus, json: async () => ({}) };
      }
      let data;
      switch (operation) {
        case "SELECT_ENTRYSTORY":
          data = { discussList: { total: posts.length, list: posts } };
          break;
        case "SELECT_USER_BY_NICKNAME":
          data = { user: nicknameFound
            ? { id: "profile-id", nickname: request.variables.nickname } : null };
          break;
        case "SELECT_USER_LIST":
          data = { userList: { total: 0, list: [] } };
          break;
        case "FIND_USERSTATUS_BY_USERNAME":
          if (statusError) {
            return { ok: true, status: 200, json: async () => ({
              errors: [{ message: "temporary upstream error" }]
            }) };
          }
          data = { userstatus: {
            id: "profile-id",
            nickname: nicknameFound ? options.nickname || "12옴" : "unknown",
            status: { project: 2, follower: 1234, following: 30 }
          } };
          break;
        case "SELECT_USER_PROJECTS":
          data = { userProjectList: {
            total: 2,
            searchAfter: null,
            list: [
              { id: "p1", isopen: true, ranked: "2026-01-01", staffPicked: null },
              { id: "p2", isopen: true, ranked: null, staffPicked: "2026-01-02" }
            ]
          } };
          break;
        case "CREATE_COMMENT":
          comments.push(request.variables);
          data = { createComment: { warning: null, comment: { id: "comment-" + comments.length } } };
          break;
        default:
          throw new Error("unexpected operation " + operation);
      }
      return { ok: true, status: 200, json: async () => ({ data }) };
    }
  };
  vm.runInNewContext(source, context, { filename: "console.js", timeout: 1000 });
  const bot = context.window.EntryInfoBot;
  return {
    bot, storage, comments, fetchCalls, context,
    setPosts(values) { posts = values; },
    setNicknameFound(value) { nicknameFound = value; },
    setStatusError(value) { statusError = value; },
    setFailStatus(value) { failStatus = value; },
    get interval() { return interval; },
    updateProfileNickname(nick) { options.nickname = nick; }
  };
}

function post(id, text, userId = "author-id", nickname = "작성자") {
  return { id, content: text, user: { id: userId, nickname } };
}

test("ready on paste, but no automatic comment without user approval", async () => {
  const f = fixture();
  assert.ok(f.bot);
  assert.equal(f.bot.status().running, false);
  assert.equal(f.interval, null);
  assert.equal(f.comments.length, 0);
});

test("new command in another user's Entry Story gets a comment on original post", async () => {
  const f = fixture();
  await f.bot.start();
  f.setPosts([post("request-id", "<p>!'12옴'정보</p>"), post("old", "이미 있던 글")]);
  await f.bot.tick();
  assert.equal(f.comments.length, 1);
  assert.equal(f.comments[0].target, "request-id");
  assert.equal(f.comments[0].targetSubject, "discuss");
  assert.equal(f.comments[0].targetType, "individual");
  assert.match(f.comments[0].content, /팔로워 수: 1,234명/);
  assert.match(f.comments[0].content, /인작 수: 1개/);
  assert.match(f.comments[0].content, /스선 수: 1개/);
  const authHeader = f.fetchCalls.find(c => c.operation === "CREATE_COMMENT").init.headers;
  assert.equal(authHeader["x-token"], "token-from-page");
  assert.equal(f.bot.status().queued, 0);
  await f.bot.tick();
  assert.equal(f.comments.length, 1);
  f.bot.stop();
});

test("nonexistent exact nickname replies with the requested message", async () => {
  const f = fixture({ nicknameFound: false });
  await f.bot.start();
  f.setPosts([post("not-found", "!'없는사람'정보"), post("old", "기존 글")]);
  await f.bot.tick();
  assert.equal(f.comments.length, 1);
  assert.equal(f.comments[0].target, "not-found");
  assert.equal(f.comments[0].content, "그런 유저 없음");
  f.bot.stop();
});

test("bot responds to its own new command post, but ignores malformed commands", async () => {
  const f = fixture();
  await f.bot.start();
  f.setPosts([
    post("wrong", "!12옴정보"),
    post("mine", "!'12옴'정보", "bot-id", "ty_pe"),
    post("old", "기존 글")
  ]);
  await f.bot.tick();
  assert.equal(f.comments.length, 1);
  assert.equal(f.comments[0].target, "mine");
  await f.bot.tick();
  assert.equal(f.comments.length, 1);
  f.bot.stop();
});

test("preview only logs and never posts", async () => {
  const f = fixture();
  await f.bot.preview();
  f.setPosts([post("preview-id", "!'12옴'정보"), post("old", "기존 글")]);
  await f.bot.tick();
  assert.equal(f.comments.length, 0);
  assert.equal(f.bot.status().mode, "preview");
  assert.ok(f.bot.status().recentLogs.some(line => line.includes("미리보기")));
  f.bot.stop();
});

test("rate-limited second request remains queued", async () => {
  const f = fixture();
  await f.bot.start();
  f.setPosts([
    post("second-id", "!'12옴'정보"),
    post("first-id", "!'12옴'정보"),
    post("old", "기존 글")
  ]);
  await f.bot.tick();
  assert.equal(f.comments.length, 1);
  assert.equal(f.comments[0].target, "first-id");
  await f.bot.tick();
  assert.equal(f.comments.length, 1);
  assert.equal(f.bot.status().queued, 1);
  f.bot.stop();
});

test("client/server error is not treated as user not existing", async () => {
  const f = fixture();
  await f.bot.start();
  f.setStatusError(true);
  f.setPosts([post("network-failed", "!'12옴'정보"), post("old", "기존 글")]);
  await f.bot.tick();
  assert.equal(f.comments.length, 0);
  assert.equal(f.bot.status().queued, 1);
  f.bot.stop();
});

test("HTTP 429 stops the bot instead of bypassing rate limits", async () => {
  const f = fixture();
  await f.bot.start();
  f.setFailStatus(429);
  await f.bot.tick();
  assert.equal(f.bot.status().running, false);
  assert.equal(f.interval, null);
});

test("profile test returns formatted info but never sends a comment", async () => {
  const f = fixture();
  const answer = await f.bot.test("12옴");
  assert.match(answer, /작품 수: 2개/);
  assert.equal(f.comments.length, 0);
});

test("restart paste stops the earlier instance", async () => {
  const f = fixture();
  await f.bot.start();
  assert.ok(f.interval);
  vm.runInNewContext(source, f.context, { filename: "console.js", timeout: 1000 });
  assert.equal(f.bot.status().running, false);
  assert.equal(f.context.window.EntryInfoBot.status().running, false);
  assert.equal(f.interval, null);
});

test("no login information means auto bot cannot start", async () => {
  const f = fixture({ loggedIn: false });
  await assert.rejects(f.bot.start(), /로그인한 상태/);
  assert.equal(f.comments.length, 0);
});

test("HTML numeric-entity quote is recognized", async () => {
  const f = fixture();
  await f.bot.start();
  f.setPosts([post("encoded", "<div>!&#x27;12옴&#x27;정보</div>"), post("old", "기존 글")]);
  await f.bot.tick();
  assert.equal(f.comments.length, 1);
  assert.equal(f.comments[0].target, "encoded");
  f.bot.stop();
});

test("no tokens are saved to localStorage", async () => {
  const f = fixture();
  await f.bot.start();
  f.setPosts([post("save-id", "!'12옴'정보"), post("old", "기존 글")]);
  await f.bot.tick();
  const stored = [...f.storage.values()].join(" ");
  assert.ok(!stored.includes("token-from-page"));
  assert.ok(!stored.includes("csrf-from-page"));
  f.bot.stop();
});

test("one-off reply works for the user's own pre-existing '삼류' Story even when watcher is off", async () => {
  const f = fixture({
    nickname: "삼류",
    posts: [
      post("mine-old", "!'삼류'정보", "bot-id", "ty_pe"),
      post("someone-old", "기존 글", "another", "다른 사용자")
    ]
  });
  const reply = await f.bot.replyToOwnPost("삼류");
  assert.equal(reply.postId, "mine-old");
  assert.equal(f.comments.length, 1);
  assert.equal(f.comments[0].target, "mine-old");
  assert.match(f.comments[0].content, /삼류님의 정보/);
  assert.equal(f.bot.status().running, false);
});

test("one-off reply never targets somebody else's old Story", async () => {
  const f = fixture({
    posts: [post("other-old", "!'삼류'정보", "other-id", "다른 사용자")]
  });
  await assert.rejects(f.bot.replyToOwnPost("삼류"), /내 .* 게시글을 찾지 못했어요/);
  assert.equal(f.comments.length, 0);
});

test("one-off reply cannot post twice to the same Story", async () => {
  const f = fixture({ nickname: "삼류", posts: [post("mine-old", "!'삼류'정보", "bot-id", "ty_pe")] });
  await f.bot.replyToOwnPost("삼류");
  await assert.rejects(f.bot.replyToOwnPost("삼류"), /이미 이 게시글에 댓글을 시도/);
  assert.equal(f.comments.length, 1);
});

test("one-off reply can only target the exact nickname command", async () => {
  const f = fixture({
    nickname: "삼류",
    posts: [post("mine-old", "!'다른닉'정보", "bot-id", "ty_pe")]
  });
  await assert.rejects(f.bot.replyToOwnPost("삼류"), /찾지 못했어요/);
  assert.equal(f.comments.length, 0);
});

