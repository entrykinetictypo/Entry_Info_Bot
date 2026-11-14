/* Entry Info Bot v2.2 - comment on recent stories by OTHER users. */
(() => {
"use strict";
if (globalThis.__entryInfoBotStoryListenerV4) return;
const core = globalThis.EntryBotCore;
const authParser = globalThis.EntryBotAuth;
if (!core || !authParser) {
  console.warn("[EntryInfoBot] 필요한 스크립트를 불러오지 못했습니다.");
  return;
}

const STORY_PATH = "/community/entrystory/list";
const PREFIX = "entryStoryScheduleV2:";
const MAX_POSTS = 100;
const Q = {
  stories: "query SELECT_ENTRYSTORY($pageParam:PageParam,$category:String,$term:String,$discussType:String,$searchType:String,$user:String){discussList(pageParam:$pageParam,category:$category,term:$term,discussType:$discussType,searchType:$searchType,user:$user){total list{id content created user{id nickname}}}}",
  comment: "mutation CREATE_COMMENT($content:String,$target:String,$targetSubject:String,$targetType:String){createComment(content:$content,target:$target,targetSubject:$targetSubject,targetType:$targetType){warning comment{id}}}",
  post: "mutation CREATE_ENTRYSTORY($content:String){createEntryStory(content:$content){discuss{id content created}}}"
};
let busy = false;

function loadState(userId) {
  const key = PREFIX + userId;
  let stored = {};
  try { stored = JSON.parse(localStorage.getItem(key) || "{}") || {}; }
  catch (_) { stored = {}; }
  return {
    key,
    commentCursor: Number.isInteger(stored.commentCursor) ? stored.commentCursor : 0,
    postCursor: Number.isInteger(stored.postCursor) ? stored.postCursor : 0,
    lastCommentIndex: Number.isInteger(stored.lastCommentIndex) ? stored.lastCommentIndex : -1,
    lastPostIndex: Number.isInteger(stored.lastPostIndex) ? stored.lastPostIndex : -1,
    commentAttempts: Array.isArray(stored.commentAttempts) ? stored.commentAttempts : [],
    commentedPostIds: Array.isArray(stored.commentedPostIds)
      ? stored.commentedPostIds.filter(x => typeof x === "string").slice(-500) : [],
    commentAuthorAttempts: Array.isArray(stored.commentAuthorAttempts)
      ? stored.commentAuthorAttempts : [],
    postAttempts: Array.isArray(stored.postAttempts) ? stored.postAttempts : [],
    lastCommentAt: Number(stored.lastCommentAt) || 0,
    lastCommentAnchor: String(stored.lastCommentAnchor || ""),
    lastPostAnchor: String(stored.lastPostAnchor || ""),
    pendingPost: stored.pendingPost && typeof stored.pendingPost === "object"
      ? stored.pendingPost : null
  };
}

function saveState(state) {
  const { key, ...record } = state;
  localStorage.setItem(key, JSON.stringify(record));
}

async function account() {
  const current = authParser.readDocument(document);
  if (authParser.complete(current)) return current;
  let fresh = null;
  let networkError = "";
  try {
    const response = await fetch("https://playentry.org/", {
      credentials: "include",
      cache: "no-store",
      headers: { accept: "text/html" },
      signal: AbortSignal.timeout(12000)
    });
    if (!response.ok) throw new Error("홈페이지 HTTP " + response.status);
    fresh = authParser.readDocument(new DOMParser().parseFromString(
      await response.text(), "text/html"));
    if (authParser.complete(fresh)) return fresh;
  } catch (error) { networkError = String(error?.message || error).slice(0,100); }

  // Do not combine an account ID from one response with another session token.
  const observed = fresh || current;
  const missing = [];
  if (!observed.id) missing.push("계정 ID");
  if (!observed.token) missing.push("xToken");
  if (!observed.csrf) missing.push("CSRF 토큰");
  throw new Error("로그인 세션 확인 실패 (" + missing.join(", ") + " 없음)." +
    " 로그인 후 엔트리 이야기 탭을 새로고침하세요." +
    (networkError ? " [" + networkError + "]" : ""));
}

async function graphql(name, query, variables, write, auth) {
  const endpoint = name === "SELECT_ENTRYSTORY"
    ? "/graphql/SELECT_ENTRYSTORY" : "/graphql";
  const response = await fetch(endpoint, {
    method: "POST",
    credentials: "include",
    signal: AbortSignal.timeout(15000),
    headers: {
      "content-type": "application/json",
      "csrf-token": auth.csrf,
      "x-client-type": "Client",
      ...(write ? { "x-token": auth.token } : {})
    },
    body: JSON.stringify({ query, variables })
  });
  let payload;
  try { payload = await response.json(); } catch (_) { payload = null; }
  const firstError = payload?.errors?.[0];
  const message = String(firstError?.message || firstError?.extensions?.code ||
    payload?.message || "").slice(0,160);
  if ([401,403,429].includes(response.status) ||
      /captcha|rate.limit|too.many|forbidden|unauthorized|도배|차단/i.test(message)) {
    await chrome.storage.local.set({ running: false });
    throw new Error("엔트리 요청 제한/인증 오류로 자동 실행을 중지했습니다. HTTP " +
      response.status + (message ? ": " + message : ""));
  }
  if (!response.ok || payload?.errors?.length) {
    throw new Error(name + " 요청 실패 HTTP " + response.status +
      (message ? ": " + message : ""));
  }
  if (!payload?.data) throw new Error(name + "의 GraphQL 응답이 비어 있습니다.");
  return payload.data;
}

async function scanStories(auth, maxPosts = MAX_POSTS) {
  const posts = [];
  const seen = new Set();
  for (let start = 0; start < maxPosts; start += 20) {
    const result = await graphql("SELECT_ENTRYSTORY", Q.stories, {
      category: "free", term: "all", discussType: "entrystory",
      searchType: "scroll", pageParam: { display: 20, start, sort: "created" }
    }, false, auth);
    const batch = result.discussList?.list;
    if (!Array.isArray(batch)) throw new Error("엔트리이야기 목록을 가져오지 못했습니다.");
    for (const post of batch) {
      if (!post?.id || seen.has(post.id)) continue;
      seen.add(post.id);
      posts.push(post);
    }
    if (batch.length < 20) break;
  }
  return posts;
}

async function findAnchor(auth, posts) {
  const direct = core.storyAnchor(posts, auth.id);
  if (direct) return { ...direct, countIsLowerBound: false };

  // A user's last post can easily fall outside the 100 most recent stories.
  // Query their own latest post for time-based rules. If 100 recent stories
  // precede it, the count threshold is also proven met (max threshold: 100).
  try {
    const result = await graphql("SELECT_ENTRYSTORY", Q.stories, {
      category: "free", term: "all", discussType: "entrystory",
      searchType: "scroll", user: auth.id,
      pageParam: { display: 5, sort: "created" }
    }, false, auth);
    const found = result.discussList?.list?.find(post =>
      post?.id && post.user?.id === auth.id);
    if (found) {
      return { id: found.id, created: found.created,
        countAbove: posts.length >= MAX_POSTS ? MAX_POSTS : null,
        countIsLowerBound: posts.length >= MAX_POSTS };
    }
  } catch (error) {
    console.warn("[EntryInfoBot] 내 게시글 별도 검색 실패: " + error.message);
  }
  return null;
}

function ageMinutes(anchor, now) {
  const raw = anchor?.created;
  const timestamp = typeof raw === "number"
    ? (raw < 1e12 ? raw * 1000 : raw) : Date.parse(String(raw || ""));
  return Number.isFinite(timestamp) ? Math.max(0,(now - timestamp) / 60000) : NaN;
}

function minutesLeft(ms) {
  return Math.max(1, Math.ceil(ms / 60000));
}

async function stillRunning(dryRun) {
  if (dryRun) return true;
  return (await chrome.storage.local.get("running")).running === true;
}

async function tick(dryRun) {
  if (busy) return { ok: false, message: "이전 확인이 진행 중입니다." };
  busy = true;
  const now = Date.now();
  const report = {
    ok: true, lastCheckAt: now, lastError: "", dryRun: Boolean(dryRun),
    commentStatus: "검사 전", postStatus: "검사 전"
  };
  try {
    if (location.origin !== "https://playentry.org" ||
        location.pathname !== STORY_PATH) throw new Error("엔트리 이야기 목록에서 실행하세요.");
    if (!await stillRunning(dryRun)) {
      report.message = "자동 실행이 중지되어 있습니다.";
      return report;
    }
    const settings = core.normalizeSettings(
      (await chrome.storage.local.get("settings")).settings);
    const auth = await account();
    const state = loadState(auth.id);
    state.commentAttempts = core.withinRollingDay(state.commentAttempts, now);
    state.commentAuthorAttempts = state.commentAuthorAttempts.filter(item =>
      item && typeof item.id === "string" && Number.isFinite(item.at) &&
      item.at <= now && item.at > now - 86400000).slice(-100);
    state.postAttempts = core.withinRollingDay(state.postAttempts, now);

    // Comment scheduling is independent from our own post. Only new posts
    // by other accounts are candidates, and only one comment is sent per tick.
    const posts = await scanStories(auth, settings.postEnabled ? MAX_POSTS : 20);
    report.scannedPosts = posts.length;
    const anchor = settings.postEnabled ? await findAnchor(auth, posts) : null;
    if (anchor) {
      report.anchorId = anchor.id;
      report.countAbove = anchor.countAbove;
      report.countIsLowerBound = anchor.countIsLowerBound;
    }
    const age = anchor ? ageMinutes(anchor, now) : NaN;
    report.ageMinutes = Number.isFinite(age) ? Math.floor(age) : null;
    report.commentAttempts24h = state.commentAttempts.length;
    report.postAttempts24h = state.postAttempts.length;

    const target = core.selectCommentTarget(posts, auth.id,
      state.commentedPostIds, state.commentAuthorAttempts, now, 120);
    report.commentTarget = target ? {
      id: target.id, nickname: target.authorNickname
    } : null;
    const comments = core.parseMessages(settings.commentMessages);
    const nextCommentAt = state.lastCommentAt + settings.commentIntervalMinutes * 60000;
    if (!settings.commentEnabled) {
      report.commentStatus = "댓글 기능 꺼짐";
    } else if (!comments.length) {
      report.commentStatus = "댓글 문구가 비어 있음";
    } else if (state.commentAttempts.length >= settings.commentsPerDay) {
      report.commentStatus = "최근 24시간 댓글 한도 도달 (" +
        state.commentAttempts.length + "/" + settings.commentsPerDay + ")";
    } else if (state.lastCommentAt && now < nextCommentAt) {
      report.commentStatus = "다음 댓글까지 " + minutesLeft(nextCommentAt - now) + "분 남음";
    } else if (!target) {
      report.commentStatus = "다른 사람의 최근 글 중 새 댓글 대상 없음 " +
        "(최근 2시간 글·글당 1회·작성자당 24시간 1회)";
    } else {
      const choice = core.chooseMessage(comments, settings.commentMode,
        state.commentCursor, state.lastCommentIndex);
      report.commentPreview = choice.content;
      if (dryRun) {
        report.commentStatus = "다른 사람(" + target.authorNickname +
          ")의 글에 댓글 작성 가능 (미리보기)";
      } else if (!await stillRunning(false)) {
        report.commentStatus = "실행 중지됨";
      } else {
        // Mark attempt BEFORE write. A failed or uncertain response must
        // never trigger duplicate comments to someone else's post.
        state.lastCommentAt = now;
        state.lastCommentAnchor = target.id;
        state.commentAttempts.push(now);
        state.commentedPostIds.push(target.id);
        state.commentedPostIds = state.commentedPostIds.slice(-500);
        state.commentAuthorAttempts.push({ id: target.authorId, at: now });
        state.commentCursor = choice.nextCursor;
        state.lastCommentIndex = choice.index;
        saveState(state);
        const result = await graphql("CREATE_COMMENT", Q.comment, {
          content: choice.content, target: target.id,
          targetSubject: "discuss", targetType: "individual"
        }, true, auth);
        if (!result.createComment?.comment?.id || result.createComment.warning)
          throw new Error("댓글 발행 여부가 불확실해 중복 방지를 위해 재시도하지 않습니다.");
        report.commentStatus = target.authorNickname + "님의 글에 댓글 게시 성공";
      }
    }

    const newMessages = core.parseMessages(settings.postMessages);
    const countReady = Number.isFinite(anchor.countAbove) &&
      anchor.countAbove >= settings.countThreshold;
    const timeReady = Number.isFinite(age) &&
      age >= settings.timeThresholdMinutes;
    report.postCondition = { countReady, timeReady, required: settings.postTrigger };
    if (!settings.postEnabled) {
      report.postStatus = "새 글 기능 꺼짐";
    } else if (!anchor) {
      report.postStatus = "내 글을 찾지 못해 새 글 작성 조건을 확인할 수 없음";
    } else if (!newMessages.length) {
      report.postStatus = "새 글 문구가 비어 있음";
    } else if (state.postAttempts.length >= settings.postsPerDay) {
      report.postStatus = "최근 24시간 새 글 한도 도달 (" +
        state.postAttempts.length + "/" + settings.postsPerDay + ")";
    } else if (state.lastPostAnchor === anchor.id) {
      report.postStatus = state.pendingPost?.sourceId === anchor.id
        ? "현재 내 글의 초안이 이미 있음 (초안 비우기로 다시 설정 가능)"
        : "현재 내 글을 기준으로 이미 처리함";
    } else if (!core.shouldPost(settings, anchor.countAbove, age)) {
      const countText = Number.isFinite(anchor.countAbove)
        ? anchor.countAbove + (anchor.countIsLowerBound ? "개 이상" : "개")
        : "계산 불가";
      const timeText = Number.isFinite(age) ? Math.floor(age) + "분" : "계산 불가";
      report.postStatus = "조건 부족 (새 글 " + countText + "/" +
        settings.countThreshold + "개, 경과 " + timeText + "/" +
        settings.timeThresholdMinutes + "분)";
    } else if (state.pendingPost) {
      report.postStatus = "이미 준비된 새 글 초안이 있음";
    } else {
      const choice = core.chooseMessage(newMessages, settings.postMode,
        state.postCursor, state.lastPostIndex);
      report.postPreview = choice.content;
      if (dryRun) {
        report.postStatus = settings.postAutoPublish
          ? "새 글 자동 게시 가능 (미리보기이므로 게시하지 않음)"
          : "새 글 초안 준비 가능 (미리보기)";
      } else if (!await stillRunning(false)) {
        report.postStatus = "실행 중지됨";
      } else {
        state.postAttempts.push(now);
        state.lastPostAnchor = anchor.id;
        state.lastPostIndex = choice.index;
        state.postCursor = choice.nextCursor;
        if (!settings.postAutoPublish) {
          state.pendingPost = { content: choice.content, sourceId: anchor.id,
            countAbove: anchor.countAbove, ageMinutes: report.ageMinutes, createdAt: now };
          saveState(state);
          report.postStatus = "새 글 초안 준비됨 (자동 게시 미설정)";
        } else {
          saveState(state);
          const result = await graphql("CREATE_ENTRYSTORY", Q.post,
            { content: choice.content }, true, auth);
          const id = result.createEntryStory?.discuss?.id;
          if (!id) throw new Error("새 글 발행을 확인하지 못했습니다. 자동 재시도하지 않습니다.");
          report.postStatus = "새 글 자동 게시 성공";
          report.publishedPostId = id;
        }
      }
    }
    report.pendingPost = Boolean(state.pendingPost);
    report.message = "댓글: " + report.commentStatus + " / 새 글: " + report.postStatus;
    return report;
  } catch (error) {
    report.ok = false;
    report.lastError = String(error?.message || error);
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
    tick(message.dryRun === true).then(reply).catch(error =>
      reply({ ok: false, message: error.message }));
    return true;
  }
  if (message.type === "ENTRY_BOT_DRAFT" || message.type === "ENTRY_BOT_CLEAR_DRAFT") {
    (async () => {
      const auth = await account();
      const state = loadState(auth.id);
      if (message.type === "ENTRY_BOT_DRAFT")
        return { ok: true, draft: state.pendingPost };
      // Clearing an unpublished draft re-arms its conditions without
      // resetting genuine published-post attempts.
      if (state.pendingPost && state.lastPostAnchor === state.pendingPost.sourceId) {
        state.lastPostAnchor = "";
        const createdAt = Number(state.pendingPost.createdAt);
        if (Number.isFinite(createdAt))
          state.postAttempts = state.postAttempts.filter(t => t !== createdAt);
      }
      state.pendingPost = null;
      saveState(state);
      return { ok: true };
    })().then(reply).catch(error =>
      reply({ ok: false, message: error.message }));
    return true;
  }
  return false;
});
globalThis.__entryInfoBotStoryListenerV4 = true;
})();
