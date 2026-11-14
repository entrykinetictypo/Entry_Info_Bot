"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

const sources = ["core.js", "auth.js", "content.js"].map(name =>
  fs.readFileSync(path.join(__dirname, "..", name), "utf8")
);

function harness(overrides = {}) {
  let clock = Date.parse("2026-11-15T12:00:00Z");
  const recent = new Date(clock - 30 * 60 * 1000).toISOString();
  const newer = new Date(clock - 10 * 60 * 1000).toISOString();
  const oldPost = new Date(clock - 5 * 60 * 60 * 1000).toISOString();
  const posts = overrides.posts || [
    { id: "other2", created: newer, user: { id: "otherB", nickname: "다른사람B" } },
    { id: "other1", created: recent, user: { id: "otherA", nickname: "다른사람A" } },
    { id: "mine", created: oldPost, user: { id: "self", nickname: "나" } }
  ];
  let callback = null;
  const record = { comments: [], posts: [], requests: [] };
  const storage = {
    running: true,
    settings: {
      commentEnabled: true,
      commentMessages: "첫 댓글\n두 번째 댓글",
      commentIntervalMinutes: 15,
      commentsPerDay: 6,
      postEnabled: false,
      postAutoPublish: false,
      postMessages: "",
      ...overrides.settings
    }
  };
  const memory = new Map();
  const htmlDoc = {
    querySelector() { return null; },
    getElementById(id) {
      return id === "__NEXT_DATA__" ? {
        textContent: JSON.stringify({props: {
          initialProps: { csrfToken: "csrf" },
          pageProps: { initialState: { common: { user:
            { _id: "self", xToken: "token" } } } }
        }})
      } : null;
    }
  };
  const FakeDate = class extends Date {
    static now() { return clock; }
  };
  const context = {
    globalThis: null,
    document: htmlDoc,
    Date: FakeDate,
    console: { warn: ()=>{}, log: ()=>{} },
    location: { origin:"https://playentry.org", pathname:"/community/entrystory/list" },
    chrome: {
      storage: { local: {
        async get(keys) {
          const result = {};
          for (const k of Array.isArray(keys) ? keys : [keys])
            result[k] = storage[k];
          return result;
        },
        async set(partial) { Object.assign(storage, partial); }
      }},
      runtime: { onMessage: { addListener(cb) { callback = cb; } } }
    },
    localStorage: {
      getItem(key) { return memory.get(key) || null; },
      setItem(key, value) { memory.set(key, String(value)); }
    },
    AbortSignal: { timeout: () => ({}) },
    fetch: async (url, options) => {
      const body = JSON.parse(options.body);
      record.requests.push({ url, query: body.query, variables: body.variables });
      let data;
      if (body.query.includes("discussList")) {
        const list = body.variables?.user
          ? posts.filter(x=>x.user.id === body.variables.user).slice(0,5)
          : posts.slice(body.variables?.pageParam?.start || 0,
              (body.variables?.pageParam?.start || 0)+20);
        data = { discussList: { list } };
      } else if (body.query.includes("createComment")) {
        record.comments.push(body.variables);
        data = { createComment: { warning:false, comment:{ id:"comment"+record.comments.length } } };
      } else if (body.query.includes("createEntryStory")) {
        record.posts.push(body.variables);
        data = { createEntryStory: { discuss:{ id:"story"+record.posts.length } } };
      } else throw new Error("Unexpected GraphQL operation");
      return { ok:true, status:200, async json(){return {data};} };
    }
  };
  context.globalThis = context;
  for (const code of sources) vm.runInNewContext(code, context);
  assert.equal(typeof callback, "function", "content script registered");
  return {
    storage, record,
    advance(minutes) { clock += minutes * 60000; },
    async tick(dryRun=false) {
      return new Promise((resolve, reject) => {
        const result = callback({ type:"ENTRY_BOT_TICK", dryRun },{},resolve);
        if (result !== true) reject(new Error("Message not handled"));
      });
    }
  };
}

test("comments target OTHER users newest eligible posts, never own posts", async () => {
  const h = harness();
  const first = await h.tick();
  assert.equal(first.ok, true);
  assert.equal(first.commentTarget.nickname, "다른사람B");
  assert.equal(h.record.comments.length, 1);
  assert.equal(h.record.comments[0].target, "other2");
  h.advance(16);
  const second = await h.tick();
  assert.equal(second.ok, true);
  assert.equal(h.record.comments.length, 2);
  assert.equal(h.record.comments[1].target, "other1");
  assert.deepEqual(h.record.comments.map(c=>c.content), ["첫 댓글", "두 번째 댓글"]);
  assert.equal(h.record.comments.some(c => c.target === "mine"), false);
});

test("never repeats a comment on the same post even after cooldown", async () => {
  const h = harness({ posts: [
    { id:"theirPost", created:"2026-11-15T11:50:00Z",
      user:{id:"other",nickname:"other"} },
    { id:"mine", created:"2026-11-15T11:30:00Z", user:{id:"self"} }
  ] });
  await h.tick();
  assert.equal(h.record.comments.length, 1);
  h.advance(20);
  const second = await h.tick();
  assert.equal(second.ok,true);
  assert.match(second.commentStatus,/대상 없음/);
  assert.equal(h.record.comments.length, 1);
});

test("limits to one comment per other author in rolling 24h", async () => {
  const h = harness({ posts:[
    { id:"first",created:"2026-11-15T11:55:00Z", user:{id:"otherA"} },
    { id:"second",created:"2026-11-15T11:54:00Z", user:{id:"otherA"} }
  ]});
  await h.tick();
  h.advance(20);
  await h.tick();
  assert.equal(h.record.comments.length,1);
  assert.equal(h.record.comments[0].target,"first");
});

test("can reply to another person's story even if user never posted", async () => {
  const h = harness({ posts: [
    { id:"onlyOther",created:"2026-11-15T11:55:00Z",
      user:{id:"otherA",nickname:"타인"} }
  ] });
  const result = await h.tick();
  assert.equal(result.ok,true);
  assert.equal(h.record.comments.length,1);
  assert.equal(h.record.comments[0].target,"onlyOther");
  assert.equal(result.postStatus,"새 글 기능 꺼짐");
});

test("does not target old or unidentified posts", async () => {
  const h = harness({ posts: [
    { id:"old",created:"2026-11-15T07:00:00Z",user:{id:"otherA"} },
    { id:"unknown",created:"2026-11-15T11:59:00Z" },
    { id:"mine",created:"2026-11-15T11:58:00Z",user:{id:"self"} }
  ] });
  const result = await h.tick();
  assert.equal(result.ok,true);
  assert.equal(h.record.comments.length,0);
  assert.match(result.commentStatus,/대상 없음/);
});

test("explains why no comment is written when messages are empty", async () => {
  const h = harness({ settings: { commentMessages:"" } });
  const result = await h.tick();
  assert.equal(result.ok, true);
  assert.equal(result.commentStatus, "댓글 문구가 비어 있음");
  assert.equal(h.record.comments.length, 0);
});

test("preview does not perform a public mutation", async () => {
  const h = harness({ settings: {
    postEnabled:true,postAutoPublish:true,postMessages:"글 내용",
    postTrigger:"time",timeThresholdMinutes:120
  }});
  const result = await h.tick(true);
  assert.equal(result.ok,true);
  assert.match(result.commentStatus,/미리보기/);
  assert.match(result.postStatus,/미리보기/);
  assert.equal(h.record.comments.length,0);
  assert.equal(h.record.posts.length,0);
});

test("auto-post requires explicit opt-in; otherwise it only prepares a draft", async () => {
  const h = harness({ settings: {
    commentEnabled:false,postEnabled:true,postAutoPublish:false,
    postMessages:"새 글 하나",postTrigger:"time",timeThresholdMinutes:120
  }});
  const first = await h.tick();
  assert.equal(first.ok,true);
  assert.match(first.postStatus,/초안 준비됨/);
  assert.equal(h.record.posts.length,0);
  const second = await h.tick();
  assert.equal(second.ok,true);
  assert.equal(h.record.posts.length,0);
});

test("opted-in auto-post writes only one Story for an anchor", async () => {
  const h = harness({ settings: {
    commentEnabled:false,postEnabled:true,postAutoPublish:true,
    postMessages:"새 글 하나",postTrigger:"both",
    countThreshold:20,timeThresholdMinutes:120
  }, posts:[
    ...Array.from({length:30},(_,i)=>({id:"other"+i,
      created:"2026-11-15T11:00:00Z",user:{id:"other"}})),
    {id:"mine",created:"2026-11-15T07:00:00Z",user:{id:"self"}}
  ]});
  const first = await h.tick();
  assert.equal(first.ok,true);
  assert.equal(first.postStatus,"새 글 자동 게시 성공");
  assert.equal(h.record.posts.length,1);
  assert.equal(h.record.posts[0].content,"새 글 하나");
  const second = await h.tick();
  assert.equal(second.ok,true);
  assert.equal(h.record.posts.length,1);
});
