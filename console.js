/*
 * Entry Info Bot - Console edition v1.0.0
 * Paste this entire file into DevTools Console on:
 * https://playentry.org/community/entrystory/list
 * Does not use an extension, eval, external scripts, or stored credentials.
 * Source: https://github.com/entrykinetictypo/Entry_Info_Bot
 */
(() => {
  "use strict";

  if (window.EntryInfoBot && typeof window.EntryInfoBot.stop === "function") {
    window.EntryInfoBot.stop();
  }

  const CONFIG = Object.freeze({
    intervalMs: 30000,
    maxRepliesPerHour: 10,
    minReplyIntervalMs: 60000,
    maxPending: 40,
    maxProjects: 2500,
    projectsPerPage: 100,
    maxPostFetch: 20,
    maxRetries: 3,
    historyLimit: 300
  });

  const KEYS = {
    replied: "entryInfoBotConsoleReplied",
    attempts: "entryInfoBotConsoleReplyAttempts"
  };
  const state = {
    running: false,
    starting: false,
    preview: false,
    busy: false,
    newestId: null,
    timer: null,
    queue: [],
    logs: [],
    generation: 0,
    replied: new Set(readSaved(KEYS.replied)),
    attempts: readSaved(KEYS.attempts).filter(t =>
      Number.isFinite(t) && Date.now() - t < 3600000
    ),
    lastCheckedAt: null
  };

  const Q = {
    stories: "query SELECT_ENTRYSTORY($pageParam:PageParam,$category:String,$term:String,$discussType:String,$searchType:String){discussList(pageParam:$pageParam,category:$category,term:$term,discussType:$discussType,searchType:$searchType){total list{id content created user{id nickname}}}}",
    byNickname: "query SELECT_USER_BY_NICKNAME($nickname:String!){user(nickname:$nickname){id nickname}}",
    users: "query SELECT_USER_LIST($query:String,$pageParam:PageParam){userList(query:$query,pageParam:$pageParam){total list{id nickname}}}",
    status: "query FIND_USERSTATUS_BY_USERNAME($id:String){userstatus(id:$id){id nickname status{project follower following}}}",
    projects: "query SELECT_USER_PROJECTS($user:String!,$pageParam:PageParam,$searchAfter:JSON,$searchType:String,$term:String,$isOpen:String){userProjectList(user:$user,pageParam:$pageParam,searchAfter:$searchAfter,searchType:$searchType,term:$term,isOpen:$isOpen){total searchAfter list{id isopen ranked staffPicked}}}",
    comment: "mutation CREATE_COMMENT($content:String,$target:String,$targetSubject:String,$targetType:String){createComment(content:$content,target:$target,targetSubject:$targetSubject,targetType:$targetType){warning comment{id}}}"
  };

  function readSaved(key) {
    try {
      const value = JSON.parse(localStorage.getItem(key) || "[]");
      return Array.isArray(value) ? value : [];
    } catch (_) {
      return [];
    }
  }

  function save(key, values) {
    try {
      localStorage.setItem(key, JSON.stringify(values));
    } catch (_) {
      // No authentication data is ever written to storage.
    }
  }

  function log(message) {
    const line = "[" + new Date().toLocaleTimeString("ko-KR") + "] " + message;
    state.logs.push(line);
    if (state.logs.length > 60) state.logs.shift();
    console.log("[EntryInfoBot] " + line);
  }

  function checkPage() {
    if (location.origin !== "https://playentry.org" ||
        location.pathname !== "/community/entrystory/list") {
      throw new Error("엔트리 이야기 목록 페이지에서만 실행할 수 있어요.");
    }
  }

  function nextData() {
    if (window.__NEXT_DATA__ && typeof window.__NEXT_DATA__ === "object") {
      return window.__NEXT_DATA__;
    }
    try {
      return JSON.parse(document.getElementById("__NEXT_DATA__")?.textContent || "{}");
    } catch (_) {
      return {};
    }
  }

  function credentials() {
    const next = nextData();
    const user = next?.props?.pageProps?.initialState?.common?.user ||
                 next?.props?.initialState?.common?.user || null;
    const csrf = document.querySelector('meta[name="csrf-token"]')?.content ||
                 document.querySelector('meta[name="csrf"]')?.content ||
                 next?.props?.initialProps?.csrfToken || "";
    return {
      id: typeof user?.id === "string" ? user.id : "",
      token: typeof user?.xToken === "string" ? user.xToken : "",
      csrf: typeof csrf === "string" ? csrf : ""
    };
  }

  function stop(reason = "사용자가 중지") {
    state.running = false;
    state.starting = false;
    state.generation += 1;
    if (state.timer !== null) clearInterval(state.timer);
    state.timer = null;
    state.queue.length = 0;
    log("정지됨 (" + reason + ")");
  }

  async function graphql(name, query, variables, write = false) {
    const auth = credentials();
    if (!auth.csrf) throw new Error("CSRF 토큰을 찾지 못했어요. 엔트리 로그인 후 새로고침해 주세요.");
    if (write && (!auth.id || !auth.token)) {
      throw new Error("봇 계정의 로그인 인증 정보를 확인할 수 없어 댓글을 작성하지 않았어요.");
    }

    const headers = {
      "content-type": "application/json",
      "csrf-token": auth.csrf,
      "x-client-type": "Client"
    };
    if (write) headers["x-token"] = auth.token;

    const response = await fetch("/graphql/" + name, {
      method: "POST",
      credentials: "include",
      headers,
      body: JSON.stringify({ query, variables })
    });
    if (response.status === 429 || response.status === 401 || response.status === 403) {
      stop("서버가 요청을 제한하거나 인증을 거부함 (HTTP " + response.status + ")");
      throw new Error("HTTP " + response.status + ": 서버 요청 제한 또는 인증 오류");
    }
    if (!response.ok) throw new Error(name + " HTTP " + response.status);

    const data = await response.json();
    if (Array.isArray(data.errors) && data.errors.length) {
      const message = String(data.errors[0]?.message || "알 수 없는 오류");
      if (/captcha|rate.limit|too.many|forbidden|unauthorized|도배|차단/i.test(message)) {
        stop("엔트리 서버 제한 감지: " + message);
      }
      throw new Error(name + ": " + message);
    }
    if (!data.data) throw new Error(name + ": 정상적인 응답이 아니에요.");
    return data.data;
  }

  function plainText(raw) {
    return String(raw == null ? "" : raw)
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(?:p|div|li)>/gi, "\n")
      .replace(/<[^>]*>/g, "")
      .replace(/&(?:#39|apos|#x27);/gi, "'")
      .replace(/&quot;/gi, '"')
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .trim();
  }

  function commandNickname(raw) {
    const command = plainText(raw);
    const match = /^!'([^'\r\n]{1,40})'정보$/u.exec(command);
    return match && match[1].trim() ? match[1] : null;
  }

  async function lookupUser(nickname) {
    // The exact-nickname API is preferred. A failed API is not proof that a user is missing.
    try {
      const response = await graphql("SELECT_USER_BY_NICKNAME", Q.byNickname, { nickname });
      const user = response.user;
      if (user?.id && user.nickname === nickname) return user;
    } catch (error) {
      if (!state.running && state.starting === false && /HTTP 429|HTTP 401|HTTP 403/.test(error.message)) {
        throw error;
      }
      log("직접 닉네임 검색 실패, 목록 검색으로 재확인: " + error.message);
    }

    const result = await graphql("SELECT_USER_LIST", Q.users, {
      query: nickname,
      pageParam: { display: 30, sort: "created" }
    });
    const users = result.userList;
    if (!users || !Array.isArray(users.list)) {
      throw new Error("검색 결과를 확인할 수 없어요.");
    }
    const matches = users.list.filter(user => user?.id && user.nickname === nickname);
    if (matches.length > 1) {
      throw new Error("동일한 닉네임이 여러 계정에서 발견되어 조회를 중단했어요.");
    }
    if (matches.length === 1) return matches[0];
    if (Number(users.total) > users.list.length) {
      throw new Error("검색 결과가 너무 많아서 계정이 없는지 판단할 수 없어요.");
    }
    return null;
  }

  async function projectCounts(userId, expectedPublicCount) {
    if (expectedPublicCount === 0) return { popular: 0, staff: 0 };
    const projects = new Map();
    let cursor = null;

    for (let page = 0; page < CONFIG.maxProjects / CONFIG.projectsPerPage; page++) {
      const variables = {
        user: userId,
        term: "all",
        isOpen: "all",
        searchType: "scroll",
        pageParam: { display: CONFIG.projectsPerPage, sort: "created" }
      };
      if (cursor !== null) variables.searchAfter = cursor;

      const response = await graphql("SELECT_USER_PROJECTS", Q.projects, variables);
      const result = response.userProjectList;
      if (!result || !Array.isArray(result.list)) {
        throw new Error("작품 목록을 확인할 수 없어요.");
      }
      for (const project of result.list) {
        if (project?.id) projects.set(project.id, project);
      }

      if (!result.searchAfter || result.list.length === 0) {
        if (Number(result.total) > projects.size || projects.size < expectedPublicCount) {
          throw new Error("작품 일부가 누락되어 인작/스선 수를 정확히 계산할 수 없어요.");
        }
        let popular = 0;
        let staff = 0;
        for (const project of projects.values()) {
          if (project.isopen === false || project.isopen === "false") continue;
          if (project.ranked !== null && project.ranked !== undefined &&
              project.ranked !== false) popular += 1;
          if (project.staffPicked !== null && project.staffPicked !== undefined &&
              project.staffPicked !== false) staff += 1;
        }
        return { popular, staff };
      }

      const next = JSON.stringify(result.searchAfter);
      if (next === JSON.stringify(cursor)) throw new Error("작품 페이지 조회가 반복되고 있어요.");
      cursor = result.searchAfter;
    }
    throw new Error("작품이 많아 2,500개 제한 내에서 집계를 완료하지 못했어요.");
  }

  async function getUserInfo(nickname) {
    if (typeof nickname !== "string" || !nickname.trim() || nickname.length > 40) {
      throw new Error("닉네임은 1~40자여야 해요.");
    }
    const user = await lookupUser(nickname);
    if (!user) return "그런 유저 없음";

    const result = await graphql("FIND_USERSTATUS_BY_USERNAME", Q.status, { id: user.id });
    const profile = result.userstatus;
    if (!profile || profile.id !== user.id || profile.nickname !== nickname || !profile.status) {
      throw new Error("계정 프로필을 확인할 수 없거나 닉네임이 변경됐어요.");
    }
    const stats = profile.status;
    if (![stats.project, stats.follower, stats.following].every(n =>
      typeof n === "number" && Number.isFinite(n) && n >= 0)) {
      throw new Error("프로필 통계가 불완전해요.");
    }

    const counts = await projectCounts(user.id, stats.project);
    const num = n => n.toLocaleString("ko-KR");
    return [
      "📊 " + nickname + "님의 정보",
      "작품 수: " + num(stats.project) + "개",
      "팔로워 수: " + num(stats.follower) + "명",
      "팔로잉 수: " + num(stats.following) + "명",
      "인작 수: " + num(counts.popular) + "개",
      "스선 수: " + num(counts.staff) + "개"
    ].join("\n");
  }

  async function latestStories() {
    const result = await graphql("SELECT_ENTRYSTORY", Q.stories, {
      category: "free",
      term: "all",
      discussType: "entrystory",
      searchType: "scroll",
      pageParam: { display: CONFIG.maxPostFetch, sort: "created" }
    });
    if (!Array.isArray(result.discussList?.list)) {
      throw new Error("새 엔트리 이야기 목록을 확인할 수 없어요.");
    }
    return result.discussList.list;
  }

  function enqueue(newPosts) {
    const inQueue = new Set(state.queue.map(p => p.id));
    for (const post of newPosts) {
      const nickname = commandNickname(post.content);
      // Own posts are valid too: the bot answers them as a comment, not a new post.
      if (!post.id || !post.user?.id || !nickname ||
          state.replied.has(post.id) || inQueue.has(post.id)) continue;
      if (state.queue.length >= CONFIG.maxPending) {
        log("댓글 대기열이 가득 차서 일부 명령어는 받지 않았어요.");
        return;
      }
      state.queue.push({ id: post.id, nickname, tries: 0 });
      inQueue.add(post.id);
      log(post.user.nickname + "님의 게시글에서 " + nickname + " 정보 요청 감지");
    }
  }

  function markReplyAttempt(postId) {
    state.replied.add(postId);
    const history = [...state.replied].slice(-CONFIG.historyLimit);
    state.replied = new Set(history);
    save(KEYS.replied, history);
    state.attempts = state.attempts.filter(t => Date.now() - t < 3600000);
    state.attempts.push(Date.now());
    save(KEYS.attempts, state.attempts);
  }

  function rateLimitAllows() {
    const recent = state.attempts.filter(t => Date.now() - t < 3600000);
    state.attempts = recent;
    return recent.length < CONFIG.maxRepliesPerHour &&
      (!recent.length || Date.now() - recent[recent.length - 1] >= CONFIG.minReplyIntervalMs);
  }

  async function sendComment(postId, reply) {
    const result = await graphql("CREATE_COMMENT", Q.comment, {
      content: reply,
      target: postId,
      targetSubject: "discuss",
      targetType: "individual"
    }, true);
    if (!result.createComment?.comment?.id || result.createComment.warning) {
      throw new Error("댓글 게시 여부를 확인할 수 없어요. 중복 게시를 막기 위해 재시도하지 않아요.");
    }
  }

  async function processQueue() {
    if (!state.running || state.queue.length === 0) return;
    if (!state.preview && !rateLimitAllows()) return;
    const item = state.queue[0];

    let reply;
    try {
      reply = await getUserInfo(item.nickname);
    } catch (error) {
      log(item.nickname + " 정보 조회 실패: " + error.message);
      item.tries += 1;
      if (item.tries >= CONFIG.maxRetries || !state.running) {
        state.queue.shift();
        log("조회 실패로 해당 명령어를 건너뛰었어요.");
      }
      return;
    }
    if (!state.running || state.queue[0] !== item) return;

    if (state.preview) {
      state.replied.add(item.id);
      state.queue.shift();
      log("[미리보기] 게시글 " + item.id + " → " + reply.replace(/\n/g, " | "));
      return;
    }

    // Mark before the network request: unknown HTTP outcomes must not cause duplicate comments.
    markReplyAttempt(item.id);
    state.queue.shift();
    try {
      await sendComment(item.id, reply);
      log("✅ 원본 게시글 " + item.id + "에 댓글 작성 완료");
    } catch (error) {
      log("⚠️ 댓글 게시 실패 또는 확인 불가: " + error.message);
      // Respect server-side restrictions and never retry this comment automatically.
    }
  }

  async function tick() {
    if (!state.running || state.busy) return;
    state.busy = true;
    try {
      checkPage();
      const posts = await latestStories();
      if (!state.running) return;
      state.lastCheckedAt = Date.now();
      if (posts.length) {
        const index = state.newestId
          ? posts.findIndex(post => post.id === state.newestId) : -1;
        const latest = posts[0].id;
        const unseen = index >= 0 ? posts.slice(0, index) : posts;
        state.newestId = latest;
        if (index === -1 && unseen.length >= CONFIG.maxPostFetch) {
          log("게시글이 너무 빨리 쌓여 일부 글을 놓쳤을 수 있어 이번 목록은 건너뛰었어요.");
        } else {
          enqueue(unseen.reverse());
        }
      }
      await processQueue();
    } catch (error) {
      log("감지 오류: " + error.message);
      if (/목록 페이지에서만/.test(error.message)) stop("페이지 이동");
    } finally {
      state.busy = false;
    }
  }

  async function start(options = {}) {
    if (state.running || state.starting) {
      log("이미 작동 중이에요.");
      return status();
    }
    checkPage();
    const auth = credentials();
    if (!auth.id || !auth.token || !auth.csrf) {
      throw new Error("엔트리에 로그인한 상태에서 실행해 주세요. 계정/CSRF 정보를 찾을 수 없어요.");
    }
    const generation = ++state.generation;
    state.starting = true;
    try {
      const existing = await latestStories();
      if (generation !== state.generation) return status();
      state.preview = options.preview === true;
      state.running = true;
      state.newestId = existing[0]?.id || null;
      state.queue.length = 0;
      state.timer = setInterval(() => { tick(); }, CONFIG.intervalMs);
      log(state.preview
        ? "👀 미리보기 모드 시작 (댓글을 게시하지 않아요)"
        : "🤖 자동 댓글 시작: 이후 올라오는 모든 사용자의 명령어 글(내 글 포함)에 댓글을 답니다.");
      return status();
    } finally {
      if (generation === state.generation) state.starting = false;
    }
  }


  // Explicit one-off test for an ALREADY PUBLISHED command post by this account.
  // Never responds to somebody else's old post; only scans the most recent 20 posts.
  async function replyToOwnPost(nickname) {
    checkPage();
    if (typeof nickname !== "string" || !nickname.trim() || nickname.length > 40) {
      throw new Error("1~40자의 닉네임을 지정해 주세요. 예: EntryInfoBot.replyToOwnPost('삼류')");
    }
    const auth = credentials();
    if (!auth.id || !auth.token || !auth.csrf) {
      throw new Error("엔트리 로그인 정보가 없어요. 로그인 후 새로고침해 주세요.");
    }
    if (state.busy) throw new Error("다른 게시글을 처리 중이에요. 잠시 후 다시 실행해 주세요.");
    state.busy = true;
    try {
      const posts = await latestStories();
      const matching = posts.find(p => p?.user?.id === auth.id &&
        commandNickname(p.content) === nickname);
      if (!matching) {
        throw new Error("최근 20개 글에서 내 !'" + nickname +
          "'정보 게시글을 찾지 못했어요. 이전 글은 자동 답변하지 않습니다.");
      }
      if (state.replied.has(matching.id)) {
        throw new Error("이미 이 게시글에 댓글을 시도했어요. 중복 댓글은 작성하지 않습니다.");
      }
      if (!rateLimitAllows()) {
        throw new Error("댓글 제한 중이에요. 1분 간격/시간당 최대 10회를 지켜 주세요.");
      }

      const reply = await getUserInfo(nickname);
      if (state.replied.has(matching.id)) {
        throw new Error("다른 작업이 이미 이 게시글을 처리했어요.");
      }
      state.queue = state.queue.filter(item => item.id !== matching.id);
      markReplyAttempt(matching.id);
      try {
        await sendComment(matching.id, reply);
      } catch (error) {
        log("기존 내 글 댓글 실패/확인 불가: " + error.message);
        throw error;
      }
      log("✅ 기존 내 게시글 " + matching.id + "에 댓글 작성 완료");
      return { postId: matching.id, reply };
    } finally {
      state.busy = false;
    }
  }

  function status() {
    const recent = state.attempts.filter(t => Date.now() - t < 3600000);
    const result = {
      running: state.running,
      mode: state.preview ? "preview" : "auto-reply",
      queued: state.queue.length,
      repliesAttemptedLastHour: recent.length,
      lastCheckedAt: state.lastCheckedAt
        ? new Date(state.lastCheckedAt).toLocaleString("ko-KR") : "아직 없음",
      recentLogs: state.logs.slice(-5)
    };
    console.table({
      "실행 중": result.running,
      "모드": result.mode,
      "대기 중": result.queued,
      "최근 1시간 댓글 시도": result.repliesAttemptedLastHour,
      "최근 조회": result.lastCheckedAt
    });
    return result;
  }

  const api = {
    start,
    preview: () => start({ preview: true }),
    stop,
    status,
    replyToOwnPost,
    test: async nickname => {
      checkPage();
      const reply = await getUserInfo(String(nickname || "").trim());
      console.log(reply);
      return reply;
    },
    tick,
    help: () => console.log(
      "EntryInfoBot.start() 자동 댓글 시작\n" +
      "EntryInfoBot.preview() 미리보기 시작\n" +
      "EntryInfoBot.stop() 정지\n" +
      "EntryInfoBot.status() 상태 확인\n" +
      "await EntryInfoBot.replyToOwnPost('삼류') 이미 올린 내 글에 댓글 작성\n" +
      "await EntryInfoBot.test('12옴') 닉네임 조회 테스트"
    )
  };
  window.EntryInfoBot = api;

  console.log("%cEntry Info Bot 콘솔 버전 준비 완료", "color:#00ad79;font-weight:bold");
  api.help();
  if (typeof window.confirm === "function" &&
      window.confirm(
        "Entry Info Bot: 엔트리 이야기에 사용자가 !'닉네임'정보를 올리면(내 글 포함)\n" +
        "현재 로그인한 계정으로 해당 게시글에 댓글을 자동 작성합니다.\n\n" +
        "엔트리 운영 정책을 확인했고 자동 댓글을 실행할까요?"
      )) {
    api.start().catch(error => log("시작 실패: " + error.message));
  } else {
    log("실행 대기 중. EntryInfoBot.start() 또는 EntryInfoBot.preview()를 입력하세요.");
  }
})();
