/* Entry Info Bot: isolated content script for the Entry Story list only. */
(() => {
"use strict";
if (globalThis.__entryInfoBotStoryListenerV2) return;

const core = globalThis.EntryBotCore;
const LIST_URL = "/community/entrystory/list";
const STORAGE_PREFIX = "entryStoryScheduleV2:";
const Q = {
  stories: "query SELECT_ENTRYSTORY($pageParam:PageParam,$category:String,$term:String,$discussType:String,$searchType:String){discussList(pageParam:$pageParam,category:$category,term:$term,discussType:$discussType,searchType:$searchType){total list{id content created user{id nickname}}}}",
  comment: "mutation CREATE_COMMENT($content:String,$target:String,$targetSubject:String,$targetType:String){createComment(content:$content,target:$target,targetSubject:$targetSubject,targetType:$targetType){warning comment{id}}}"
};
let busy = false;

// Content scripts run in an isolated world. Read the shared __NEXT_DATA__
// element first, then refresh session information from Entry's own home page.
// This avoids reading inaccessible page globals or asking for passwords.
async function account() {
  const current = globalThis.EntryBotAuth.readDocument(document);
  if (globalThis.EntryBotAuth.complete(current)) return current;

  let fresh = null;
  let fetchProblem = "";
  try {
    const response = await fetch("https://playentry.org/", {
      credentials: "include",
      cache: "no-store",
      headers: { "accept": "text/html" },
      signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) {
      fetchProblem = "홈페이지 HTTP " + response.status;
    } else {
      const doc = new DOMParser().parseFromString(await response.text(), "text/html");
      fresh = globalThis.EntryBotAuth.readDocument(doc);
      if (globalThis.EntryBotAuth.complete(fresh)) return fresh;
    }
  } catch (error) {
    fetchProblem = String(error?.message || error).slice(0,120);
  }

  // Never mix an account ID from one snapshot with a token from another:
  // the tab might have changed accounts since the initial HTML was rendered.
  const observed = fresh || current;
  const missing = [];
  if (!observed.id) missing.push("계정 ID");
  if (!observed.token) missing.push("xToken");
  if (!observed.csrf) missing.push("CSRF 토큰");
  throw new Error("엔트리 로그인 세션 확인 실패 (" + missing.join(", ") + " 없음)." +
    " 엔트리이야기에서 로그인한 뒤 페이지를 새로고침해 주세요." +
    (fetchProblem ? " [" + fetchProblem + "]" : ""));
}

function loadState(userId) {
  const key = STORAGE_PREFIX + userId;
  try {
    const value = JSON.parse(localStorage.getItem(key) || "{}");
    return {
      key,
      commentCursor: Number.isInteger(value.commentCursor) ? value.commentCursor : 0,
      postCursor: Number.isInteger(value.postCursor) ? value.postCursor : 0,
      lastCommentIndex: Number.isInteger(value.lastCommentIndex) ? value.lastCommentIndex : -1,
      lastPostIndex: Number.isInteger(value.lastPostIndex) ? value.lastPostIndex : -1,
      commentAttempts: Array.isArray(value.commentAttempts) ? value.commentAttempts : [],
      postAttempts: Array.isArray(value.postAttempts) ? value.postAttempts : [],
      lastCommentAt: Number(value.lastCommentAt) || 0,
      lastCommentAnchor: String(value.lastCommentAnchor || ""),
      pendingPost: value.pendingPost || null,
      preparedAt: Number(value.preparedAt) || 0,
      lastPostAnchor: String(value.lastPostAnchor || "")
    };
  } catch (_) { return { key, commentCursor: 0, postCursor: 0, lastCommentIndex: -1,
    lastPostIndex: -1, commentAttempts: [], postAttempts: [], lastCommentAt: 0,
    lastCommentAnchor: "", pendingPost: null, preparedAt: 0, lastPostAnchor: "" }; }
}

function saveState(s) {
  const value = { ...s };
  delete value.key;
  localStorage.setItem(s.key, JSON.stringify(value));
}

async function graphql(operationName, query, variables, write, auth) {
  const response = await fetch(operationName === "SELECT_ENTRYSTORY" ?
    "/graphql/SELECT_ENTRYSTORY" : "/graphql", {
    method: "POST", credentials: "include",
    headers: { "content-type": "application/json", "csrf-token": auth.csrf,
      "x-client-type": "Client", ...(write ? { "x-token": auth.token } : {}) },
    body: JSON.stringify({ query, variables })
  });
  let json;
  try { json = await response.json(); } catch (_) { json = null; }
  if ([401, 403, 429].includes(response.status) ||
      /captcha|rate.limit|too.many|forbidden|도배|차단/i.test(JSON.stringify(json?.errors || []))) {
    await chrome.storage.local.set({ running: false });
    throw new Error("사이트에서 인증/요청 제한을 반환해 실행을 중지했습니다 (HTTP " + response.status + ").");
  }
  if (!response.ok || json?.errors?.length) {
    throw new Error("GraphQL 요청 실패: " + response.status + " " +
      String(json?.errors?.[0]?.message || "").slice(0,140));
  }
  if (!json?.data) throw new Error("GraphQL 응답의 data가 없습니다.");
  return json.data;
}

async function scanStories(auth) {
  const seen = new Set(), posts = [];
  // Up to 100 recent stories; do not guess if our last post is older.
  for (let start = 0; start < 100; start += 20) {
    const list = await graphql("SELECT_ENTRYSTORY", Q.stories, {
      category: "free", term: "all", discussType: "entrystory",
      searchType: "scroll", pageParam: { display: 20, start, sort: "created" }
    }, false, auth);
    const batch = list?.discussList?.list;
    if (!Array.isArray(batch)) throw new Error("이야기 목록 응답이 올바르지 않습니다.");
    for (const item of batch) {
      if (item?.id && !seen.has(item.id)) { seen.add(item.id); posts.push(item); }
    }
    if (batch.length < 20) break;
  }
  return posts;
}

function postAgeMinutes(anchor, now) {
  const raw = anchor?.created;
  const number = typeof raw === "number" ? (raw < 1e12 ? raw * 1000 : raw) : Date.parse(raw);
  return Number.isFinite(number) ? Math.max(0, (now - number) / 60000) : NaN;
}

async function tick(dryRun) {
  if (busy) return { ok: false, message: "이전 확인이 진행 중입니다." };
  busy = true;
  const now = Date.now();
  const report = { ok: true, lastCheckAt: now, lastError: "", message: "확인 완료" };
  try {
    if (location.origin !== "https://playentry.org" || location.pathname !== LIST_URL)
      throw new Error("엔트리 이야기 목록에서만 작동합니다.");
    const [storage] = await Promise.all([chrome.storage.local.get(["settings", "running"])]);
    if (!dryRun && storage.running !== true) return { ok: false, message: "중지 상태입니다." };
    const settings = core.normalizeSettings(storage.settings);
    const auth = await account();
    const state = loadState(auth.id);
    const posts = await scanStories(auth);
    const anchor = core.storyAnchor(posts, auth.id);
    if (!anchor) {
      report.message = "최근 100개 글 안에서 내 글을 찾지 못했습니다. 자동 작성하지 않습니다.";
      return report;
    }
    const countAbove = anchor.countAbove;
    const ageMinutes = postAgeMinutes(anchor, now);
    report.anchorId = anchor.id;
    report.countAbove = countAbove;
    report.ageMinutes = Number.isFinite(ageMinutes) ? Math.floor(ageMinutes) : null;
    const comments = core.parseMessages(settings.commentMessages);
    state.commentAttempts = core.withinRollingDay(state.commentAttempts, now);
    state.postAttempts = core.withinRollingDay(state.postAttempts, now);

    if (settings.commentEnabled && comments.length &&
        state.commentAttempts.length < settings.commentsPerDay &&
        now - state.lastCommentAt >= settings.commentIntervalMinutes * 60000 &&
        // Avoid responding to one story repeatedly before new activity appears.
        (countAbove > 0 || state.lastCommentAnchor !== anchor.id)) {
      const choice = core.chooseMessage(comments, settings.commentMode,
        state.commentCursor, state.lastCommentIndex);
      if (dryRun) {
        report.commentPreview = choice.content;
      } else {
        // Record attempt before network request to prevent duplicate writes on uncertain responses.
        state.lastCommentAt = now;
        state.lastCommentAnchor = anchor.id;
        state.commentAttempts.push(now);
        state.commentCursor = choice.nextCursor;
        state.lastCommentIndex = choice.index;
        saveState(state);
        const response = await graphql("CREATE_COMMENT", Q.comment, {
          content: choice.content, target: anchor.id,
          targetSubject: "discuss", targetType: "individual"
        }, true, auth);
        if (!response.createComment?.comment?.id || response.createComment.warning)
          throw new Error("댓글 발행을 확인할 수 없어 재시도하지 않습니다.");
        report.message = "내 최신 이야기글에 댓글 1개 작성 완료";
        report.lastComment = choice.content;
      }
    }

    const postMessages = core.parseMessages(settings.postMessages);
    if (core.shouldPost(settings, countAbove, ageMinutes) && postMessages.length &&
        state.postAttempts.length < settings.postsPerDay &&
        state.lastPostAnchor !== anchor.id) {
      const choice = core.chooseMessage(postMessages, settings.postMode,
        state.postCursor, state.lastPostIndex);
      report.postPreview = choice.content;
      if (!dryRun && !state.pendingPost) {
        // A draft requires a human to publish it. Do not guess an undocumented write API.
        state.pendingPost = { content: choice.content, sourceId: anchor.id,
          countAbove, ageMinutes: report.ageMinutes, createdAt: now };
        state.postAttempts.push(now);
        state.preparedAt = now;
        state.lastPostAnchor = anchor.id;
        state.lastPostIndex = choice.index;
        state.postCursor = choice.nextCursor;
        saveState(state);
        report.message += " / 새 글 초안이 준비되었습니다 (수동 게시)";
      }
    }
    report.pendingPost = Boolean(state.pendingPost);
    return report;
  } catch (error) {
    report.ok = false;
    report.lastError = String(error && error.message || error);
    report.message = report.lastError;
    return report;
  } finally {
    try { await chrome.storage.local.set({ runtime: report }); } catch (_) {}
    busy = false;
  }
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (!message) return false;
  if (message.type === "ENTRY_BOT_TICK") {
    tick(message.dryRun === true).then(reply);
    return true;
  }
  if (message.type === "ENTRY_BOT_DRAFT") {
    (async () => {
      const auth = await account();
      if (!auth.id) throw new Error("로그인 계정을 찾을 수 없습니다.");
      return loadState(auth.id).pendingPost;
    })().then(draft => reply({ ok: true, draft }))
      .catch(error => reply({ ok: false, message: error.message }));
    return true;
  }
  if (message.type === "ENTRY_BOT_CLEAR_DRAFT") {
    (async () => {
      const auth = await account();
      if (!auth.id) throw new Error("로그인 계정을 찾을 수 없습니다.");
      const state = loadState(auth.id);
      state.pendingPost = null;
      saveState(state);
      return { ok: true };
    })().then(reply).catch(error => reply({ ok: false, message: error.message }));
    return true;
  }
  return false;
});

globalThis.__entryInfoBotStoryListenerV2 = true;
})();
