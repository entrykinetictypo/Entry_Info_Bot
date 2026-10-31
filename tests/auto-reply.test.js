const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const sleep = require("node:timers/promises").setTimeout;

const core = fs.readFileSync(path.join(__dirname, "../src/core.js"), "utf8");
const content = fs.readFileSync(path.join(__dirname, "../src/content.js"), "utf8");
const background = fs.readFileSync(path.join(__dirname, "../src/background.js"), "utf8");

async function until(check, message) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await sleep(10);
  }
  throw new Error("Mock test timed out: " + message);
}

function browserFixture({ posts, nickname = "12옴", ownId = "bot-account", enabled = true, autoReply = true } = {}) {
  let list = posts || [{ id: "old", content: "hello", user: { id: "someone" } }];
  let polls = 0;
  const commentCalls = [];
  const state = {
    entryInfoBotEnabled: enabled,
    entryInfoBotAutoReply: autoReply,
    entryInfoBotSeen: [],
    entryInfoBotPending: [],
    entryInfoBotRecentReplies: [],
    entryInfoBotLogs: []
  };
  let messageHandler;
  const chrome = {
    storage: {
      local: {
        async get(defaults) { return { ...defaults, ...state }; },
        async set(values) { Object.assign(state, values); }
      },
      onChanged: { addListener() {} }
    },
    runtime: { onMessage: { addListener(fn) { messageHandler = fn; } } }
  };
  const document = {
    querySelector() { return { content: "csrf-token" }; },
    getElementById(name) {
      if (name !== "__NEXT_DATA__") return null;
      return { textContent: JSON.stringify({
        props: {
          initialProps: { csrfToken: "csrf-token" },
          pageProps: { initialState: { common: { user: { id: ownId, xToken: "x-token" } } } }
        }
      }) };
    }
  };
  const fetch = async (url, init) => {
    const op = url.split("/").at(-1);
    const request = JSON.parse(init.body);
    let data;
    if (op === "SELECT_ENTRYSTORY") {
      polls++;
      data = { discussList: { list } };
    } else if (op === "SELECT_USER_BY_NICKNAME") {
      data = { user: nickname === null ? null : { id: "user-123", nickname } };
    } else if (op === "SELECT_USER_LIST") {
      data = { userList: { total: 0, list: [] } };
    } else if (op === "FIND_USERSTATUS_BY_USERNAME") {
      data = { userstatus: {
        id: "user-123", nickname, status: { project: 2, follower: 10, following: 7 }
      } };
    } else if (op === "SELECT_USER_PROJECTS") {
      data = { userProjectList: {
        total: 2,
        list: [
          { id: "project-a", ranked: 1, staffPicked: null, isopen: true },
          { id: "project-b", ranked: null, staffPicked: 1, isopen: true }
        ],
        searchAfter: null
      } };
    } else if (op === "CREATE_COMMENT") {
      commentCalls.push({ variables: request.variables, headers: init.headers });
      data = { createComment: { warning: null, comment: { id: "new-comment" } } };
    } else {
      throw new Error("Unexpected GraphQL endpoint: " + op);
    }
    return { ok: true, status: 200, json: async () => ({ data }) };
  };
  const context = { console, fetch, document, chrome,
    location: { pathname: "/community/entrystory/list" } };
  context.window = context;
  vm.runInNewContext(core, context, { filename: "core.js" });
  vm.runInNewContext(content, context, { filename: "content.js" });

  function tick() {
    assert.equal(typeof messageHandler, "function", "tick listener must exist");
    messageHandler({ type: "entryInfoBotTick" }, {}, () => {});
  }
  return {
    state, tick, commentCalls,
    setPosts(next) { list = next; },
    get polls() { return polls; }
  };
}

test("another user's NEW command Story receives a comment on THAT Story", async () => {
  const mock = browserFixture();
  await until(() => mock.polls === 1, "initial baseline");
  const fresh = { id: "someone-post", content: "<p>!'12옴'정보</p>", user: { id: "another-user" } };
  mock.setPosts([fresh, { id: "old", content: "hello", user: { id: "someone" } }]);
  mock.tick();
  await until(() => mock.commentCalls.length === 1 && mock.state.entryInfoBotPending.length === 0, "comment sent");
  assert.equal(mock.commentCalls[0].variables.target, "someone-post");
  assert.equal(mock.commentCalls[0].variables.targetSubject, "discuss");
  assert.match(mock.commentCalls[0].variables.content, /12옴님의 정보/);
  assert.match(mock.commentCalls[0].variables.content, /팔로워 수: 10명/);
  assert.match(mock.commentCalls[0].variables.content, /인작 수: 1개/);
  assert.match(mock.commentCalls[0].variables.content, /스선 수: 1개/);
  assert.equal(mock.commentCalls[0].headers["x-token"], "x-token");
  mock.tick();
  await until(() => mock.polls >= 3, "third poll");
  assert.equal(mock.commentCalls.length, 1, "never duplicate a reply");
});

test("nonexistent nickname receives '그런 유저 없음' under the original post", async () => {
  const mock = browserFixture({ nickname: null });
  await until(() => mock.polls === 1, "initial baseline");
  mock.setPosts([{ id: "not-found-post", content: "!'아무도없는닉'정보", user: { id: "other" } },
                 { id: "old", content: "hello", user: { id: "someone" } }]);
  mock.tick();
  await until(() => mock.commentCalls.length === 1, "not found reply");
  assert.equal(mock.commentCalls[0].variables.target, "not-found-post");
  assert.equal(mock.commentCalls[0].variables.content, "그런 유저 없음");
});

test("the bot does not reply to its own posts", async () => {
  const mock = browserFixture();
  await until(() => mock.polls === 1, "initial baseline");
  mock.setPosts([{ id: "bot-post", content: "!'12옴'정보", user: { id: "bot-account" } },
                 { id: "old", content: "hello", user: { id: "someone" } }]);
  mock.tick();
  await until(() => mock.polls === 2, "second poll");
  assert.equal(mock.commentCalls.length, 0);
  assert.equal(mock.state.entryInfoBotPending.length, 0);
});

test("rate limited requests wait in queue instead of getting lost", async () => {
  const mock = browserFixture();
  await until(() => mock.polls === 1, "initial baseline");
  mock.setPosts([
    { id: "second", content: "!'12옴'정보", user: { id: "user2" } },
    { id: "first", content: "!'12옴'정보", user: { id: "user1" } },
    { id: "old", content: "hello", user: { id: "someone" } }
  ]);
  mock.tick();
  await until(() => mock.commentCalls.length === 1 && mock.state.entryInfoBotPending.length === 1, "queue preserved");
  assert.equal(mock.commentCalls[0].variables.target, "first");
  assert.equal(mock.state.entryInfoBotPending[0].id, "second");
  mock.tick();
  await until(() => mock.polls >= 3, "next tick");
  assert.equal(mock.commentCalls.length, 1);
  assert.equal(mock.state.entryInfoBotPending.length, 1);
});

test("disabled bot does not post comments", async () => {
  const mock = browserFixture({ enabled: false, autoReply: false });
  await until(() => mock.polls === 0, "disabled");
  mock.setPosts([{ id: "other", content: "!'12옴'정보", user: { id: "someone" } }]);
  mock.tick();
  await sleep(20);
  assert.equal(mock.commentCalls.length, 0);
});

test("alarm service worker sends a tick to a background Entry Story tab", async () => {
  let alarmListener, alarmCreated = false;
  const messages = [];
  const chrome = {
    alarms: {
      async get() { return null; },
      async create(name, options) {
        assert.equal(name, "entryInfoBotPoll");
        assert.equal(options.periodInMinutes, 0.5);
        alarmCreated = true;
      },
      onAlarm: { addListener(fn) { alarmListener = fn; } }
    },
    runtime: {
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} }
    },
    storage: { local: { async get() { return {
      entryInfoBotEnabled: true, entryInfoBotAutoReply: true
    }; } } },
    tabs: {
      async query(filter) {
        assert.match(filter.url, /entrystory/);
        return [{ id: 42, status: "complete", active: false }];
      },
      async sendMessage(id, msg) { messages.push({ id, msg }); }
    }
  };
  vm.runInNewContext(background, { chrome, console }, { filename: "background.js" });
  await until(() => alarmCreated && typeof alarmListener === "function", "alarm installed");
  alarmListener({ name: "entryInfoBotPoll" });
  await until(() => messages.length === 1, "background tab message");
  assert.equal(messages[0].id, 42);
  assert.equal(messages[0].msg.type, "entryInfoBotTick");
});
