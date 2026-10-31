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
  let lastNickname = options.nickname || "12옴";
  let virtualNow = Date.now();
  class MockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [virtualNow])); }
    static now() { return virtualNow; }
  }
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
    Date: MockDate,
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
      const route = url.split("/").at(-1);
      if (url.startsWith("https://raw.githubusercontent.com/")) {
        fetchCalls.push({ operation: "GITHUB_USER_DB", request: null, init, url });
        if (options.githubDbFails) {
          return { ok: false, status: 404, json: async () => ({}) };
        }
        return { ok: true, status: 200,
          json: async () => options.nicknameDatabase || {} };
      }
      const request = JSON.parse(init.body);
      const operation = route === "graphql" ?
        (request.query.includes("user(nickname:") ? "SELECT_USER_BY_NICKNAME" :
          /\b(?:query|mutation)\s+([A-Z_][A-Z_0-9]*)/.exec(request.query)?.[1]) :
        route;
      fetchCalls.push({ operation, request, init, url });
      if (options.userSearchHttp400 &&
          ["SELECT_USER_BY_NICKNAME", "SELECT_USER_LIST"].includes(operation)) {
        return { ok: false, status: 400, json: async () => ({
          errors: [{ message: "Unknown operation at the requested endpoint" }]
        }) };
      }
      if (failStatus && operation === "SELECT_ENTRYSTORY") {
        return { ok: false, status: failStatus, json: async () => ({}) };
      }
      let data;
      switch (operation) {
        case "SELECT_ENTRYSTORY": {
          const start = Number(request.variables?.pageParam?.start) || 0;
          const display = Number(request.variables?.pageParam?.display) || 20;
          data = { discussList: { total: posts.length, list: posts.slice(start, start + display) } };
          break;
        }
        case "SELECT_USER_BY_NICKNAME":
          lastNickname = request.variables.nickname;
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
            id: options.profileId || "profile-id",
            nickname: nicknameFound ? options.nickname || lastNickname : "unknown",
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
    advanceTime(ms) { virtualNow += ms; },
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

test("bot responds to its own valid command, but ignores unrelated commands", async () => {
  const f = fixture();
  await f.bot.start();
  f.setPosts([
    post("wrong", "!12옴"),
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
  assert.equal(reply.matched, 1);
  assert.equal(f.comments.length, 1);
  assert.equal(f.comments[0].target, "mine-old");
  assert.match(f.comments[0].content, /삼류님의 정보/);
  // Manual batch processing starts the watcher to drain pending replies.
  assert.equal(f.bot.status().running, true);
  f.bot.stop();
});

test("one-off reply never targets somebody else's old Story", async () => {
  const f = fixture({
    posts: [post("other-old", "!'삼류'정보", "other-id", "다른 사용자")]
  });
  await assert.rejects(f.bot.replyToOwnPost("삼류"), /조건에 맞는 명령어를 찾지 못했어요/);
  assert.equal(f.comments.length, 0);
});

test("one-off reply cannot post twice to the same Story", async () => {
  const f = fixture({ nickname: "삼류", posts: [post("mine-old", "!'삼류'정보", "bot-id", "ty_pe")] });
  await f.bot.replyToOwnPost("삼류");
  const second = await f.bot.replyToOwnPost("삼류");
  assert.equal(second.addedToQueue, 0);
  assert.equal(second.alreadyHandled, 1);
  assert.equal(f.comments.length, 1);
});

test("one-off reply can only target the exact nickname command", async () => {
  const f = fixture({
    nickname: "삼류",
    posts: [post("mine-old", "!'다른닉'정보", "bot-id", "ty_pe")]
  });
  await assert.rejects(f.bot.replyToOwnPost("삼류"), /조건에 맞는 명령어를 찾지 못했어요/);
  assert.equal(f.comments.length, 0);
});



test("user lookup and comment use generic /graphql instead of broken /graphql/SELECT_USER endpoints", async () => {
  const f = fixture();
  await f.bot.start();
  f.setPosts([post("generic-path", "!'12옴'정보"), post("old", "기존 글")]);
  await f.bot.tick();
  const usernameCalls = f.fetchCalls.filter(c =>
    ["SELECT_USER_BY_NICKNAME", "SELECT_USER_LIST"].includes(c.operation));
  assert.ok(usernameCalls.length >= 1);
  assert.ok(usernameCalls.every(c => c.url === "/graphql"));
  const commentCall = f.fetchCalls.find(c => c.operation === "CREATE_COMMENT");
  assert.equal(commentCall.url, "/graphql");
  assert.equal(f.comments.length, 1);
  f.bot.stop();
});

test("local private nickname database handles HTTP 400 user API without leaking mappings", async () => {
  const id = "0123456789abcdef01234567";
  const f = fixture({
    nickname: "삼류",
    userSearchHttp400: true,
    profileId: id,
    posts: [post("my-old", "!'삼류'정보", "bot-id", "ty_pe")]
  });
  const db = f.bot.useLocalDatabase({ "삼류": id });
  assert.equal(db.saved, false);
  assert.equal(f.bot.status().databaseLoaded, true);
  const output = await f.bot.replyToOwnPost("삼류");
  assert.equal(output.matched, 1);
  assert.equal(f.comments.length, 1);
  assert.equal(f.comments[0].target, "my-old");
  assert.match(f.comments[0].content, /삼류님의 정보/);
  assert.equal(f.fetchCalls.filter(c => c.operation === "SELECT_USER_BY_NICKNAME").length, 0);
  assert.equal(f.fetchCalls.filter(c => c.operation === "GITHUB_USER_DB").length, 0);
});

test("HTTP 400 with no local DB shows helpful error instead of claiming nonexistent user", async () => {
  const f = fixture({
    nickname: "삼류",
    userSearchHttp400: true,
    posts: [post("my-old", "!'삼류'정보", "bot-id", "ty_pe")]
  });
  // The batch command queues the request and logs a lookup failure; it does not
  // falsely publish a nonexistent-user reply.
  const output = await f.bot.replyToOwnPost("삼류");
  assert.equal(output.matched, 1);
  assert.equal(output.addedToQueue, 1);
  assert.equal(output.pending, 1);
  assert.equal(f.comments.length, 0);
  assert.ok(f.bot.status().recentLogs.some(line => line.includes("EntryInfoBot.loadDatabase()")));
  assert.equal(f.fetchCalls.filter(c => c.operation === "GITHUB_USER_DB").length, 0);
  f.bot.stop();
});

test("empty or non-object local database cannot be loaded", async () => {
  const f = fixture();
  assert.throws(() => f.bot.useLocalDatabase({}), /비어 있는/);
  assert.throws(() => f.bot.useLocalDatabase(["삼류"]), /형식/);
  assert.equal(f.bot.status().databaseLoaded, false);
});

test("do not retry writes to prevent duplicate comments after API failure", async () => {
  const f = fixture({ nickname: "삼류", posts: [post("my-old", "!'삼류'정보", "bot-id", "ty_pe")] });
  await f.bot.replyToOwnPost("삼류");
  assert.equal(f.fetchCalls.filter(c => c.operation === "CREATE_COMMENT").length, 1);
  const repeat = await f.bot.replyToOwnPost("삼류");
  assert.equal(repeat.alreadyHandled, 1);
  assert.equal(f.fetchCalls.filter(c => c.operation === "CREATE_COMMENT").length, 1);
});

test("profile and project statistics use ent2-backup compatible named endpoints", async () => {
  const f = fixture({ nickname: "삼류", posts: [post("my-old", "!'삼류'정보", "bot-id", "ty_pe")] });
  await f.bot.replyToOwnPost("삼류");
  const status = f.fetchCalls.find(c => c.operation === "FIND_USERSTATUS_BY_USERNAME");
  const projects = f.fetchCalls.find(c => c.operation === "SELECT_USER_PROJECTS");
  assert.equal(status.url, "/graphql/FIND_USERSTATUS_BY_USERNAME");
  assert.equal(projects.url, "/graphql/SELECT_USER_PROJECTS");
  assert.equal(f.comments.length, 1);
});


test("parses optional space between closing quote and 정보, including HTML markup", async () => {
  const f = fixture();
  assert.equal(f.bot.parse("!'요니작가_온작' 정보"), "요니작가_온작");
  assert.equal(f.bot.parse("!'요니작가_온작'정보"), "요니작가_온작");
  assert.equal(f.bot.parse("<p>!&#39;요니작가_온작&#39;&nbsp;정보</p>"), "요니작가_온작");
  assert.equal(f.bot.parse("!‘요니작가_온작’ 정보"), "요니작가_온작");
  assert.equal(f.bot.parse("!'요니작가_온작'　정보"), "요니작가_온작");
  assert.equal(f.bot.parse("!'요니작가_온작' 다른정보"), null);
});

test("another author requesting their own nickname bypasses the broken user search API", async () => {
  const id = "0123456789abcdef01234567";
  const name = "요니작가_온작";
  const f = fixture({
    nickname: name, profileId: id, userSearchHttp400: true
  });
  await f.bot.start();
  f.setPosts([
    post("new-spaced-post", "<p>!'요니작가_온작' 정보</p>", id, name),
    post("old", "기존 글")
  ]);
  await f.bot.tick();
  assert.equal(f.comments.length, 1);
  assert.equal(f.comments[0].target, "new-spaced-post");
  assert.match(f.comments[0].content, /요니작가_온작님의 정보/);
  assert.equal(f.fetchCalls.some(x => x.operation === "SELECT_USER_BY_NICKNAME"), false);
  assert.equal(f.fetchCalls.some(x => x.operation === "SELECT_USER_LIST"), false);
  f.bot.stop();
});

test("inspectRecent shows exact commands without posting any comment", async () => {
  const f = fixture({
    posts: [post("found", "!'요니작가_온작' 정보", "user1", "요니작가_온작")]
  });
  const rows = await f.bot.inspectRecent();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].recognizedNickname, "요니작가_온작");
  assert.equal(f.comments.length, 0);
});

test("replyToRecentCommand sends one explicit reply to another person's earlier spaced command", async () => {
  const id = "0123456789abcdef01234567";
  const f = fixture({
    nickname: "요니작가_온작", profileId: id, userSearchHttp400: true,
    posts: [post("old-command", "!'요니작가_온작' 정보", id, "요니작가_온작")]
  });
  const answer = await f.bot.replyToRecentCommand("요니작가_온작");
  assert.equal(answer.matched, 1);
  assert.equal(f.comments.length, 1);
  assert.equal(f.comments[0].target, "old-command");
  const again = await f.bot.replyToRecentCommand("요니작가_온작");
  assert.equal(again.alreadyHandled, 1);
  assert.equal(f.comments.length, 1);
});

test("manual reply queues EVERY matching post and replies to each separately", async () => {
  const f = fixture({
    nickname: "요니작가_온작",
    posts: [
      post("a", "!'요니작가_온작' 정보", "userA", "첫번째"),
      post("b", "!'요니작가_온작'정보", "userB", "두번째"),
      post("c", "!'요니작가_온작' 정보", "userC", "세번째")
    ]
  });
  const result = await f.bot.replyToRecentCommand("요니작가_온작");
  assert.equal(result.matched, 3);
  assert.equal(result.addedToQueue, 3);
  assert.equal(f.comments.length, 1);
  assert.equal(f.bot.status().queued, 2);
  f.advanceTime(61000);
  await f.bot.tick();
  assert.equal(f.comments.length, 2);
  f.advanceTime(61000);
  await f.bot.tick();
  assert.equal(f.comments.length, 3);
  assert.deepEqual([...f.comments.map(x=>x.target)].sort(), ["a", "b", "c"]);
  assert.equal(f.bot.status().queued, 0);
  const again = await f.bot.replyToRecentCommand("요니작가_온작");
  assert.equal(again.addedToQueue, 0);
  assert.equal(f.comments.length, 3);
  f.bot.stop();
});


test("replyToAllRecentCommands queues every valid command regardless of nickname", async () => {
  const f = fixture({
    posts: [
      post("a", "!'삼류' 정보", "one", "글쓴이1"),
      post("b", "!'12옴'정보", "two", "글쓴이2"),
      post("not-command", "일반 글", "three", "글쓴이3")
    ]
  });
  const result = await f.bot.replyToAllRecentCommands();
  assert.equal(result.matched, 2);
  assert.equal(result.addedToQueue, 2);
  assert.equal(f.comments.length, 1);
  f.advanceTime(61000);
  await f.bot.tick();
  assert.equal(f.comments.length, 2);
  assert.deepEqual([...f.comments.map(x => x.target)].sort(), ["a", "b"]);
  f.bot.stop();
});

test("manual backfill scans all available pages up to 100 posts, not just 20", async () => {
  const posts = Array.from({ length: 49 }, (_, i) =>
    post("older-" + i, "!'12옴' 정보", "user" + i, "작성자" + i));
  const f = fixture({ posts });
  const result = await f.bot.replyToRecentCommand("12옴");
  assert.equal(result.matched, 49);
  assert.equal(result.addedToQueue, 49);
  assert.equal(result.pending, 48);
  assert.equal(f.comments.length, 1);
  assert.ok(f.fetchCalls.some(x =>
    x.operation === "SELECT_ENTRYSTORY" &&
    x.request.variables?.pageParam?.start === 20));
  f.bot.stop();
});

test("auto monitoring catches up with more than 20 new posts across pages", async () => {
  const f = fixture();
  await f.bot.start();
  f.setPosts([...Array.from({ length: 40 }, (_, i) =>
    post("fresh-" + i, "!'12옴' 정보", "user" + i, "작성자" + i)),
    post("old", "이미 있던 글")]);
  await f.bot.tick();
  assert.equal(f.comments.length, 1);
  assert.equal(f.bot.status().queued, 39);
  f.bot.stop();
});

test("pending queue is restored across a script reload and next tick sends further replies", async () => {
  const f = fixture({
    posts: [
      post("one", "!'12옴'정보"),
      post("two", "!'12옴'정보"),
      post("three", "!'12옴'정보")
    ]
  });
  await f.bot.replyToRecentCommand("12옴");
  assert.equal(f.bot.status().queued, 2);
  assert.equal(JSON.parse(f.storage.get("entryInfoBotConsolePending")).length, 2);
  f.bot.stop();
  const old = f.context.window.EntryInfoBot;
  const newSource = fs.readFileSync(path.join(__dirname, "../console.js"), "utf8");
  vm.runInNewContext(newSource, f.context, { filename: "console.js", timeout: 1000 });
  const resumed = f.context.window.EntryInfoBot;
  assert.notEqual(old, resumed);
  assert.equal(resumed.status().queued, 2);
  await resumed.start();
  f.advanceTime(61000);
  await resumed.tick();
  assert.equal(f.comments.length, 2);
  assert.equal(resumed.status().queued, 1);
  resumed.stop();
});

test("manual batch never silently duplicates a pending or attempted reply", async () => {
  const f = fixture({
    posts: [
      post("one", "!'12옴'정보"),
      post("two", "!'12옴'정보")
    ]
  });
  await f.bot.replyToRecentCommand("12옴");
  const again = await f.bot.replyToRecentCommand("12옴");
  assert.equal(again.matched, 2);
  assert.equal(again.addedToQueue, 0);
  assert.equal(again.alreadyHandled, 2);
  assert.equal(f.comments.length, 1);
  assert.equal(f.bot.status().queued, 1);
  f.bot.stop();
});


test("exception handling classifies unquoted and malformed nickname commands", () => {
  const f = fixture();
  assert.equal(f.bot.parse("!김곤충 정보"), null);
  for (const source of ["!김곤충 정보", "!김곤충정보", "<p>!김곤충&nbsp;정보</p>",
    "!“김곤충”정보", "!\"김곤충\"정보", "!'김곤충 정보", "!김곤충'정보"]) {
    const result = f.bot.classify(source);
    assert.equal(result?.kind, "format-error", source);
    assert.equal(result.nickname, "김곤충", source);
  }
  for (const source of ["!'김곤충'정보", "!'김곤충' 정보", "!‘김곤충’ 정보"]) {
    const result = f.bot.classify(source);
    assert.equal(result?.kind, "info", source);
    assert.equal(result.nickname, "김곤충");
  }
  for (const text of ["!도움말", "나는 김곤충 정보가 궁금하다", "!김곤충 정보 더 알려줘",
    "!어떤 명령어인가요?\n정보", "!" + "김".repeat(95) + " 정보"]) {
    assert.equal(f.bot.classify(text), null, text);
  }
});

test("malformed '김곤충 정보' command gets helpful comment without any profile API call", async () => {
  const f = fixture({ userSearchHttp400: true });
  await f.bot.start();
  f.setPosts([
    post("missing-quotes", "!김곤충 정보", "different-author", "테스터"),
    post("old", "이미 있던 글")
  ]);
  await f.bot.tick();
  assert.equal(f.comments.length, 1);
  assert.equal(f.comments[0].target, "missing-quotes");
  assert.match(f.comments[0].content, /명령어 형식 오류/);
  assert.match(f.comments[0].content, /작은따옴표/);
  assert.match(f.comments[0].content, /!'김곤충'정보/);
  assert.equal(f.fetchCalls.filter(x => [
    "SELECT_USER_BY_NICKNAME", "SELECT_USER_LIST", "FIND_USERSTATUS_BY_USERNAME",
    "SELECT_USER_PROJECTS"
  ].includes(x.operation)).length, 0);
  await f.bot.tick();
  assert.equal(f.comments.length, 1);
  f.bot.stop();
});

test("all matching malformed posts each receive one guidance reply with normal rate limits", async () => {
  const f = fixture({
    nickname: "김곤충",
    posts: [
      post("without-quotes", "!김곤충 정보", "user-a", "첫번째"),
      post("wrong-quotes", '!"김곤충"정보', "user-b", "두번째"),
      post("valid", "!'김곤충' 정보", "user-c", "세번째"),
      post("unrelated", "!도움말", "user-d", "네번째")
    ]
  });
  const batch = await f.bot.replyToAllRecentCommands();
  assert.equal(batch.matched, 3);
  assert.equal(batch.addedToQueue, 3);
  assert.equal(f.comments.length, 1);
  assert.equal(f.bot.status().queued, 2);
  f.advanceTime(61000);
  await f.bot.tick();
  assert.equal(f.comments.length, 2);
  f.advanceTime(61000);
  await f.bot.tick();
  assert.equal(f.comments.length, 3);
  assert.deepEqual([...f.comments.map(x => x.target)].sort(), [
    "valid", "without-quotes", "wrong-quotes"
  ].sort());
  assert.equal(f.comments.filter(x => x.content.includes("명령어 형식 오류")).length, 2);
  assert.equal(f.comments.filter(x => x.content.includes("작품 수:")).length, 1);
  assert.equal(f.bot.status().queued, 0);
  const again = await f.bot.replyToAllRecentCommands();
  assert.equal(again.addedToQueue, 0);
  assert.equal(again.alreadyHandled, 3);
  assert.equal(f.comments.length, 3);
  f.bot.stop();
});

test("manual nickname filter includes both valid and missing-quote requests", async () => {
  const f = fixture({
    nickname: "김곤충",
    posts: [
      post("bad", "!김곤충 정보", "someone", "아무개"),
      post("good", "!'김곤충'정보", "someone-else", "다른 사람"),
      post("another", "!12옴 정보", "someone-third", "세번째")
    ]
  });
  const result = await f.bot.replyToRecentCommand("김곤충");
  assert.equal(result.matched, 2);
  assert.equal(result.addedToQueue, 2);
  assert.equal(f.comments.length, 1);
  f.advanceTime(61000);
  await f.bot.tick();
  assert.equal(f.comments.length, 2);
  assert.equal(f.comments.some(c => c.target === "another"), false);
  f.bot.stop();
});

test("preview mode shows malformed command guidance without posting a comment", async () => {
  const f = fixture();
  await f.bot.preview();
  f.setPosts([post("preview-error", "!김곤충 정보"), post("old", "이미 있던 글")]);
  await f.bot.tick();
  assert.equal(f.comments.length, 0);
  assert.ok(f.bot.status().recentLogs.some(l => l.includes("작은따옴표")));
  f.bot.stop();
});

test("inspectRecent labels malformed nickname command as format error", async () => {
  const f = fixture({ posts: [post("format-error", "!김곤충 정보")] });
  const rows = await f.bot.inspectRecent();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].classification, "형식 오류 → 사용법 안내");
  assert.equal(rows[0].recognizedNickname, "김곤충");
  assert.equal(f.comments.length, 0);
});
