(function () {
  "use strict";
  if (window.__entryInfoBotLoaded) return;
  window.__entryInfoBotLoaded = true;

  const C = window.EntryInfoBotCore;
  const URL_BASE = "https://playentry.org/graphql/";
  const LIMIT_PER_HOUR = 10;
  const MAX_PROJECT_PAGES = 25;
  const HISTORY_LIMIT = 200;
  const MAX_PENDING = 40;
  const SETTINGS = {
    enabled: "entryInfoBotEnabled",
    autoReply: "entryInfoBotAutoReply",
    logs: "entryInfoBotLogs",
    seen: "entryInfoBotSeen",
    pending: "entryInfoBotPending",
    recentReplies: "entryInfoBotRecentReplies",
    lastPoll: "entryInfoBotLastPoll"
  };
  let busy = false;
  let initialized = false;
  let newestId = null;

  function onStoryList() {
    return location.pathname === "/community/entrystory/list";
  }

  function csrfToken() {
    const meta = document.querySelector('meta[name="csrf-token"], meta[name="csrf"]');
    if (meta && meta.content) return meta.content;
    const next = document.getElementById("__NEXT_DATA__");
    if (next && next.textContent) {
      try {
        return JSON.parse(next.textContent)?.props?.initialProps?.csrfToken || "";
      } catch (_) {}
    }
    return "";
  }

  function xToken() {
    const next = document.getElementById("__NEXT_DATA__");
    if (next && next.textContent) {
      try {
        const obj = JSON.parse(next.textContent);
        const user = obj?.props?.pageProps?.initialState?.common?.user ||
                     obj?.props?.initialState?.common?.user;
        return typeof user?.xToken === "string" ? user.xToken : "";
      } catch (_) {}
    }
    return "";
  }

  // Prevent replying to the bot's own Story posts.
  function currentUserId() {
    const next = document.getElementById("__NEXT_DATA__");
    try {
      const data = JSON.parse(next?.textContent || "{}");
      return data?.props?.pageProps?.initialState?.common?.user?.id ||
             data?.props?.initialState?.common?.user?.id || "";
    } catch (_) {
      return "";
    }
  }

  function requiredHeaders(write) {
    const csrf = csrfToken();
    if (!csrf) throw new Error("엔트리 로그인/CSRF 정보를 찾지 못했습니다. 페이지를 새로고침하세요.");
    const headers = { "Content-Type": "application/json", "csrf-token": csrf, "x-client-type": "Client" };
    if (write) {
      const token = xToken();
      if (!token) throw new Error("로그인 인증 토큰을 확인할 수 없어 댓글을 작성하지 않았습니다.");
      headers["x-token"] = token;
    }
    return headers;
  }

  async function graphql(op, query, variables, write = false) {
    const response = await fetch(URL_BASE + op, {
      method: "POST",
      headers: requiredHeaders(write),
      credentials: "include",
      body: JSON.stringify({ query, variables })
    });
    if (response.status === 429) {
      await chrome.storage.local.set({ [SETTINGS.autoReply]: false });
      throw new Error("HTTP 429 요청 제한: 자동 댓글을 껐습니다.");
    }
    if (!response.ok) throw new Error("엔트리 API HTTP " + response.status);
    const result = await response.json();
    if (Array.isArray(result.errors) && result.errors.length > 0) {
      throw new Error("GraphQL: " + (result.errors[0]?.message || "알 수 없는 오류"));
    }
    if (!result.data) throw new Error("엔트리 API 응답이 비어 있습니다.");
    return result.data;
  }

  async function addLog(message) {
    const data = await chrome.storage.local.get({ [SETTINGS.logs]: [] });
    const logs = Array.isArray(data[SETTINGS.logs]) ? data[SETTINGS.logs] : [];
    logs.push({ time: Date.now(), message: String(message).slice(0, 400) });
    await chrome.storage.local.set({ [SETTINGS.logs]: logs.slice(-60) });
  }

  const QUERY_USER = "query SELECT_USER_BY_NICKNAME($nickname:String!){user(nickname:$nickname){id nickname}}";
  const QUERY_USER_LIST = "query SELECT_USER_LIST($query:String,$pageParam:PageParam){userList(query:$query,pageParam:$pageParam){total list{id nickname}}}";
  const QUERY_STATUS = "query FIND_USERSTATUS_BY_USERNAME($id:String){userstatus(id:$id){id nickname status{project follower following}}}";
  const QUERY_PROJECTS = "query SELECT_USER_PROJECTS($user:String!,$pageParam:PageParam,$searchAfter:JSON,$searchType:String,$term:String,$isOpen:String){userProjectList(user:$user,pageParam:$pageParam,searchAfter:$searchAfter,searchType:$searchType,term:$term,isOpen:$isOpen){total searchAfter list{id isopen ranked staffPicked}}}";
  const QUERY_STORIES = "query SELECT_ENTRYSTORY($pageParam:PageParam,$category:String,$term:String,$discussType:String,$searchType:String){discussList(pageParam:$pageParam,category:$category,term:$term,discussType:$discussType,searchType:$searchType){total list{id content created user{id nickname}}}}";
  const MUTATION_COMMENT = "mutation CREATE_COMMENT($content:String,$target:String,$targetSubject:String,$targetType:String){createComment(content:$content,target:$target,targetSubject:$targetSubject,targetType:$targetType){warning comment{id}}}";

  async function findUser(nickname) {
    let user = null;
    let directFailed = false;
    try {
      const data = await graphql("SELECT_USER_BY_NICKNAME", QUERY_USER, { nickname });
      user = data.user || null;
    } catch (error) {
      directFailed = true;
    }
    if (user && user.id && user.nickname === nickname) return user;

    const result = await graphql("SELECT_USER_LIST", QUERY_USER_LIST,
      { query: nickname, pageParam: { display: 30, sort: "created" } });
    const exact = (result.userList?.list || []).find(u => u.nickname === nickname && u.id);
    if (exact) return exact;
    if (directFailed && result.userList == null) throw new Error("사용자 검색 API가 응답하지 않았습니다.");
    if (!result.userList || !Array.isArray(result.userList.list)) throw new Error("검색 결과 형식 오류");
    if (Number(result.userList.total) > result.userList.list.length) {
      throw new Error("검색 결과가 많아 정확히 일치하는 닉네임의 존재 여부를 확정할 수 없습니다.");
    }
    return null;
  }

  async function getUserInfo(nickname) {
    const found = await findUser(nickname);
    if (!found) return "그런 유저 없음";
    const statusData = await graphql("FIND_USERSTATUS_BY_USERNAME", QUERY_STATUS, { id: found.id });
    const user = statusData.userstatus;
    if (!user || !user.status || user.id !== found.id) {
      throw new Error("계정 프로필을 확인하지 못했습니다.");
    }
    if (user.nickname !== nickname) {
      // The nickname may have changed between the two requests.
      throw new Error("닉네임이 변경된 계정입니다. 다시 조회해 주세요.");
    }
    const target = Number(user.status.project);
    if (!Number.isInteger(target) || target < 0) throw new Error("작품 수 응답 형식 오류");
    const projects = new Map();
    let cursor = null;
    for (let page = 0; page < MAX_PROJECT_PAGES; page++) {
      const vars = {
        user: found.id,
        searchType: "scroll",
        term: "all",
        isOpen: "all",
        pageParam: { display: 100, sort: "created" }
      };
      if (cursor != null) vars.searchAfter = cursor;
      const data = await graphql("SELECT_USER_PROJECTS", QUERY_PROJECTS, vars);
      const list = data.userProjectList;
      if (!list || !Array.isArray(list.list)) throw new Error("작품 목록 형식 오류");
      for (const item of list.list) {
        if (item?.id && !projects.has(item.id)) projects.set(item.id, item);
      }
      if (list.list.length === 0 || !list.searchAfter) {
        const count = C.summarizeProjects(projects.values());
        if (typeof list.total === "number" && list.total > projects.size) {
          throw new Error("작품 목록이 일부 누락되어 인작/스선을 계산하지 않았습니다.");
        }
        // Public project total can differ from all projects shown in the internal list.
        // A lower count is not proof of completeness, so only accept a completed pagination run.
        return C.formatUserInfo(user, count);
      }
      const next = JSON.stringify(list.searchAfter);
      if (next === JSON.stringify(cursor)) throw new Error("작품 페이지가 반복됩니다.");
      cursor = list.searchAfter;
    }
    throw new Error("작품이 너무 많아 집계를 끝내지 못했습니다(2,500개 제한).");
  }

  async function latestStories() {
    const data = await graphql("SELECT_ENTRYSTORY", QUERY_STORIES, {
      category: "free",
      term: "all",
      discussType: "entrystory",
      searchType: "scroll",
      pageParam: { display: 20, sort: "created" }
    });
    const list = data.discussList?.list;
    if (!Array.isArray(list)) throw new Error("게시글 목록 응답 형식 오류");
    return list;
  }

  async function canReply(postId) {
    const s = await chrome.storage.local.get({
      [SETTINGS.recentReplies]: [],
      [SETTINGS.seen]: [],
      [SETTINGS.autoReply]: false,
      [SETTINGS.enabled]: false
    });
    const now = Date.now();
    const recent = (s[SETTINGS.recentReplies] || []).filter(t => now - t < 3600000);
    if (!s[SETTINGS.enabled] || !s[SETTINGS.autoReply]) return false;
    if ((s[SETTINGS.seen] || []).includes(postId)) return false;
    if (recent.length >= LIMIT_PER_HOUR || (recent.length && now - recent[recent.length - 1] < 60000)) {
      return false;
    }
    // Mark before mutation to avoid duplicate replies after a failed/ambiguous network response.
    await chrome.storage.local.set({
      [SETTINGS.seen]: [...(s[SETTINGS.seen] || []), postId].slice(-HISTORY_LIMIT),
      [SETTINGS.recentReplies]: [...recent, now]
    });
    return true;
  }

  async function sendComment(postId, message) {
    const data = await graphql("CREATE_COMMENT", MUTATION_COMMENT, {
      content: message,
      target: postId,
      targetSubject: "discuss",
      targetType: "individual"
    }, true);
    const result = data.createComment;
    if (!result || !result.comment?.id || result.warning) {
      throw new Error("댓글이 성공적으로 작성되었는지 확인할 수 없습니다.");
    }
    return result.comment.id;
  }

  // Queue new requests so rate limits delay replies rather than silently discard them.
  async function enqueueNewPosts(posts) {
    const s = await chrome.storage.local.get({
      [SETTINGS.pending]: [], [SETTINGS.seen]: []
    });
    const pending = Array.isArray(s[SETTINGS.pending]) ? s[SETTINGS.pending] : [];
    const seen = new Set(Array.isArray(s[SETTINGS.seen]) ? s[SETTINGS.seen] : []);
    const ids = new Set(pending.map(p => p.id));
    const ownId = currentUserId();
    let added = 0;
    for (const post of posts) {
      const nickname = C.parseCommand(C.normalizePostText(post.content));
      if (!nickname || !post.id || (ownId && post.user?.id === ownId)) continue;
      if (seen.has(post.id) || ids.has(post.id)) continue;
      if (pending.length >= MAX_PENDING) {
        await addLog("대기열이 가득 차 신규 명령어를 추가하지 못했습니다.");
        break;
      }
      pending.push({ id: post.id, nickname, attempts: 0 });
      ids.add(post.id);
      added++;
    }
    if (added) {
      await chrome.storage.local.set({ [SETTINGS.pending]: pending });
      await addLog("다른 사용자의 명령어 " + added + "건 감지 · 해당 글에 댓글 작성 대기");
    }
  }

  async function dropPending(id) {
    const s = await chrome.storage.local.get({ [SETTINGS.pending]: [] });
    await chrome.storage.local.set({
      [SETTINGS.pending]: (s[SETTINGS.pending] || []).filter(p => p.id !== id)
    });
  }

  async function drainPending() {
    const s = await chrome.storage.local.get({
      [SETTINGS.pending]: [],
      [SETTINGS.seen]: [],
      [SETTINGS.recentReplies]: [],
      [SETTINGS.enabled]: false,
      [SETTINGS.autoReply]: false
    });
    if (!s[SETTINGS.enabled] || !s[SETTINGS.autoReply]) return;
    const queue = s[SETTINGS.pending] || [];
    if (!queue.length) return;
    const post = queue[0];
    if ((s[SETTINGS.seen] || []).includes(post.id)) {
      await dropPending(post.id);
      return;
    }
    const recent = (s[SETTINGS.recentReplies] || [])
      .filter(t => Number.isFinite(t) && Date.now() - t < 3600000);
    if (recent.length >= LIMIT_PER_HOUR ||
        (recent.length && Date.now() - recent[recent.length - 1] < 60000)) {
      return; // Keep the request until the next periodic check.
    }

    let answer;
    try {
      answer = await getUserInfo(post.nickname);
    } catch (error) {
      await addLog(post.nickname + " 정보 조회 실패: " + error.message);
      const count = (post.attempts || 0) + 1;
      const now = await chrome.storage.local.get({ [SETTINGS.pending]: [] });
      const items = (now[SETTINGS.pending] || []).map(p =>
        p.id === post.id ? { ...p, attempts: count } : p
      );
      if (count >= 3) {
        await dropPending(post.id);
        await addLog("3회 조회 실패로 대기열에서 제외: " + post.nickname);
      } else {
        await chrome.storage.local.set({ [SETTINGS.pending]: items });
      }
      return;
    }

    if (!(await canReply(post.id))) return;
    try {
      // 'post.id' is the original user's Entry Story post.
      await sendComment(post.id, answer);
      await addLog("다른 사용자 게시글에 댓글 작성 성공: " + post.nickname);
    } catch (error) {
      await addLog("댓글 작성 실패/확인 불가: " + error.message);
      console.warn("[Entry Info Bot] Comment submission failed:", error.message);
    } finally {
      await dropPending(post.id);
    }
  }

  async function checkStories() {
    // An alarm can deliver a tick to a background tab even if it is not focused.
    if (busy || !onStoryList()) return;
    busy = true;
    try {
      const s = await chrome.storage.local.get({
        [SETTINGS.enabled]: false, [SETTINGS.autoReply]: false
      });
      if (!s[SETTINGS.enabled] || !s[SETTINGS.autoReply]) {
        initialized = false;
        newestId = null;
        return;
      }
      const list = await latestStories();
      await chrome.storage.local.set({ [SETTINGS.lastPoll]: Date.now() });
      if (list.length) {
        if (!initialized) {
          newestId = list[0].id;
          initialized = true;
          await addLog("자동 댓글 감지 시작: 이전 게시글은 무시하고 이후 글부터 답합니다.");
        } else {
          const newPosts = [];
          let foundLast = false;
          for (const post of list) {
            if (post.id === newestId) {
              foundLast = true;
              break;
            }
            newPosts.push(post);
          }
          newestId = list[0].id;
          if (!foundLast && newPosts.length >= 20) {
            await addLog("새 글이 20건 이상 누적되어 누락 가능성이 있어 이번 목록은 건너뜁니다.");
          } else {
            await enqueueNewPosts(newPosts.reverse());
          }
        }
      }
      await drainPending();
    } catch (error) {
      await addLog("감시 오류: " + error.message);
    } finally {
      busy = false;
    }
  }

  chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    if (message?.type === "entryInfoBotTick") {
      checkStories();
      return false;
    }
    if (!message || message.type !== "entryInfoBotLookup") return false;
    const nickname = String(message.nickname || "").trim();
    if (!onStoryList() || !nickname || nickname.length > 40) {
      sendResponse({ ok: false, error: "올바른 닉네임과 엔트리 이야기 탭이 필요합니다." });
      return false;
    }
    getUserInfo(nickname).then(function (text) {
      sendResponse({ ok: true, text });
    }).catch(function (error) {
      sendResponse({ ok: false, error: error.message });
    });
    return true;
  });

  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area === "local" && changes[SETTINGS.enabled]) {
      initialized = false;
      newestId = null;
      if (changes[SETTINGS.enabled].newValue) checkStories();
    }
  });

  // Alarms from the extension service worker also run when this tab is unfocused.
  checkStories();
})();
