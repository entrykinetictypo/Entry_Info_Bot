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
    intervalMs: 15000,
    maxRepliesPerHour: 20,
    minReplyIntervalMs: 30000,
    infoCacheMs: 120000,
    negativeCacheMs: 30000,
    maxPending: 200,
    maxScanPages: 5, // scan up to 100 recent posts
    maxProjects: 2500,
    projectsPerPage: 100,
    maxPostFetch: 20,
    maxRetries: 3,
    historyLimit: 300
  });

  const KEYS = {
    replied: "entryInfoBotConsoleReplied",
    attempts: "entryInfoBotConsoleReplyAttempts",
    pending: "entryInfoBotConsolePending"
  };
  const state = {
    running: false,
    starting: false,
    preview: false,
    busy: false,
    newestId: null,
    timer: null,
    queue: readSaved(KEYS.pending).filter(item =>
      item && typeof item.id === "string" &&
      typeof item.nickname === "string" && item.nickname.length <= 40
    ).slice(0, CONFIG.maxPending),
    logs: [],
    generation: 0,
    replied: new Set(readSaved(KEYS.replied)),
    attempts: readSaved(KEYS.attempts).filter(t =>
      Number.isFinite(t) && Date.now() - t < 3600000
    ),
    lastCheckedAt: null
  };
  let nicknameDatabase = null; // optional private ent2-backup data.json, in memory only
  const userInfoCache = new Map(); // short-lived results; never stores authentication
  const unsupportedUserSearch = new Set(); // avoid repeatedly retrying broken lookup queries

  const Q = {
    spaceUsers: "query getUsers($param:UserSearch!){getUsers(param:$param){total list{id nickname}}}",
    stories: "query SELECT_ENTRYSTORY($pageParam:PageParam,$category:String,$term:String,$discussType:String,$searchType:String){discussList(pageParam:$pageParam,category:$category,term:$term,discussType:$discussType,searchType:$searchType){total list{id content created user{id nickname}}}}",
    // Standard (unnamed) GraphQL syntax matches known working Entry console examples.
    byNickname: "query($nickname:String){user(nickname:$nickname){id nickname}}",
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
    // Pause, but keep the queue in localStorage for the next launch.
    log("정지됨 (" + reason + "), 대기 중인 명령어 " + state.queue.length + "건 보관");
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

    // User search and comment mutations use the generic endpoint.
    // Known working profile, projects and Story queries use named endpoints
    // as in ent2-backup, avoiding compatibility issues with generic routing.
    const namedRoute = [
      "SELECT_ENTRYSTORY",
      "FIND_USERSTATUS_BY_USERNAME",
      "SELECT_USER_PROJECTS"
    ].includes(name);
    const endpoint = namedRoute ? "/graphql/" + name : "/graphql";
    const response = await fetch(endpoint, {
      method: "POST",
      credentials: "include",
      headers,
      body: JSON.stringify({ query, variables })
    });
    let payload = null;
    try {
      payload = await response.json();
    } catch (_) {
      // Some API failures return non-JSON bodies.
    }
    const firstError = payload?.errors?.[0];
    const apiError = String(
      (typeof firstError === "string" ? firstError : firstError?.message) ||
      firstError?.extensions?.code ||
      (firstError ? JSON.stringify(firstError) : "") ||
      payload?.message || payload?.error || ""
    ).slice(0, 240);

    if ([401, 403, 429].includes(response.status)) {
      stop("서버가 요청을 제한하거나 인증을 거부함 (HTTP " + response.status + ")");
      throw new Error("HTTP " + response.status + ": 요청 제한/인증 오류" +
        (apiError ? " · " + apiError : ""));
    }
    if (!response.ok) {
      throw new Error(name + " HTTP " + response.status +
        (apiError ? " · " + apiError : ""));
    }
    if (Array.isArray(payload?.errors) && payload.errors.length) {
      const message = apiError || "알 수 없는 GraphQL 오류";
      if (/captcha|rate.limit|too.many|forbidden|unauthorized|도배|차단/i.test(message)) {
        stop("엔트리 서버 제한 감지: " + message);
      }
      throw new Error(name + ": " + message);
    }
    if (!payload?.data) throw new Error(name + ": 정상적인 응답이 아니에요.");
    return payload.data;
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
    // Previous valid commands keep working, including optional whitespace.
    const match = /^![ \t]*['‘’]([^'‘’\r\n]{1,40})['‘’][ \t\u00a0\u3000]*정보$/u.exec(command);
    return match && match[1].trim() ? match[1] : null;
  }

  function classifyCommand(raw) {
    const text = plainText(raw);
    const validNickname = commandNickname(text);
    if (validNickname) return { kind: "info", nickname: validNickname };

    // Only consider very short, command-looking posts ending in '정보'.
    // Avoid replying to unrelated discussion, commands or long free-form text.
    if (text.length > 90 || /[\r\n]/u.test(text)) return null;
    const invalid = /^![ \t]*([\s\S]{0,46}?)[ \t\u00a0\u3000]*정보$/u.exec(text);
    if (!invalid) return null;

    let candidate = invalid[1].trim();
    // Handle missing, mismatched or incorrect quote styles:
    // !김곤충 정보, !김곤충정보, !"김곤충"정보, !'김곤충 정보.
    candidate = candidate.replace(/^['‘’"“”]/u, "")
      .replace(/['‘’"“”]$/u, "").trim();
    if (candidate.length > 40 || /['‘’"“”!\r\n]/u.test(candidate)) candidate = "";
    return { kind: "format-error", nickname: candidate };
  }

  function formatErrorMessage(nickname) {
    const candidate = typeof nickname === "string" && nickname.trim() &&
      nickname.length <= 40 && !/['‘’"“”!\r\n]/u.test(nickname)
      ? nickname : "닉네임";
    return [
      "⚠️ 명령어 형식 오류",
      "닉네임 양쪽에 작은따옴표(')를 넣어 주세요.",
      "권장 형식(공백 없이): !'" + candidate + "'정보"
    ].join("\n");
  }

  function useLocalDatabase(data) {
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new Error("data.json은 {닉네임: 사용자ID} 형식이어야 해요.");
    }
    const keys = Object.keys(data);
    if (!keys.length) throw new Error("비어 있는 닉네임 DB예요.");
    // Do not persist private nickname mappings or send them to a third party.
    nicknameDatabase = data;
    userInfoCache.clear();
    unsupportedUserSearch.clear();
    log("🔐 ent2-backup 개인 DB 준비 완료 (" + keys.length.toLocaleString("ko-KR") +
      "명). 이 탭의 메모리에서만 사용해요.");
    return { count: keys.length, saved: false };
  }

  function loadDatabase() {
    checkPage();
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,application/json";
    input.style.display = "none";

    const button = document.createElement("button");
    button.textContent = "📂 ent2-backup data.json 선택";
    Object.assign(button.style, {
      position: "fixed", top: "10px", right: "10px", zIndex: "2147483647",
      background: "#0bbf91", color: "#fff", padding: "12px 16px",
      border: "0", borderRadius: "8px", cursor: "pointer",
      fontWeight: "bold", fontSize: "14px", boxShadow: "0 4px 15px #0003"
    });

    document.body.append(input, button);
    log("화면 오른쪽 위의 'ent2-backup data.json 선택' 버튼을 클릭해 주세요.");

    return new Promise((resolve, reject) => {
      function clean() {
        button.remove();
        input.remove();
      }
      button.addEventListener("click", () => input.click());
      input.addEventListener("change", async () => {
        const file = input.files?.[0];
        if (!file) return;
        try {
          if (file.size > 30000000) throw new Error("파일이 너무 큽니다(30MB 초과).");
          const data = JSON.parse(await file.text());
          const value = useLocalDatabase(data);
          clean();
          resolve(value);
        } catch (error) {
          clean();
          log("DB 파일 불러오기 실패: " + error.message);
          reject(error);
        }
      });
    });
  }

  async function lookupViaSpace(nickname) {
    const res = await fetch("https://space.playentry.org/graphql/getUsers", {
      method: "POST",
      credentials: "omit",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        operationName: "getUsers",
        query: Q.spaceUsers,
        variables: { param: { nickname, display: 30 } }
      })
    });
    if (res.status === 429) {
      stop("엔트리 스페이스 검색 요청 제한");
      throw new Error("HTTP 429");
    }
    if (!res.ok) throw new Error("Space HTTP " + res.status);
    const body = await res.json();
    if (body?.errors?.length) throw new Error("Space GraphQL 오류");
    const result = body?.data?.getUsers;
    if (!result || !Array.isArray(result.list)) throw new Error("Space 검색 응답 오류");
    const exact = result.list.filter(x => x?.id && x.nickname === nickname);
    if (exact.length === 1) return { user: exact[0] };
    if (exact.length > 1) throw new Error("동일한 닉네임의 사용자 다수");
    const complete = Number.isInteger(result.total) &&
      result.total >= 0 && result.total <= result.list.length;
    return { missing: complete };
  }

  async function lookupUser(nickname) {
    // Private ent2-backup data.json can be loaded manually from the user's PC.
    // It is never uploaded or cached by this script.
    if (nicknameDatabase && Object.prototype.hasOwnProperty.call(nicknameDatabase, nickname)) {
      const id = nicknameDatabase[nickname];
      if (typeof id !== "string" || !/^[0-9a-f]{24}$/i.test(id)) {
        throw new Error("로컬 DB의 ID 형식이 올바르지 않습니다.");
      }
      return { id, nickname };
    }

    let verifiedNoUser = false;
    const errors = [];
    if (!unsupportedUserSearch.has("exact")) {
      try {
        const result = await graphql("SELECT_USER_BY_NICKNAME", Q.byNickname, { nickname });
        const user = result.user;
        if (user?.id && user.nickname === nickname) return user;
        if (user === null) verifiedNoUser = true;
      } catch (error) {
        if (/HTTP (401|403|429)/.test(error.message)) throw error;
        if (/HTTP 400\b/.test(error.message)) unsupportedUserSearch.add("exact");
        errors.push(error.message);
        log("실시간 닉네임 검색 실패: " + error.message);
      }
    }

    if (!unsupportedUserSearch.has("list")) {
      try {
        const result = await graphql("SELECT_USER_LIST", Q.users, {
          query: nickname,
          pageParam: { display: 30, sort: "created" }
        });
        const users = result.userList;
        if (!users || !Array.isArray(users.list)) {
          throw new Error("유저 목록 응답 형식 오류");
        }
        const exact = users.list.filter(u => u?.id && u.nickname === nickname);
        if (exact.length === 1) return exact[0];
        if (exact.length > 1) throw new Error("동일 닉네임을 가진 계정이 여러 개여서 확인할 수 없어요.");
        if (typeof users.total === "number" && users.total <= users.list.length) {
          verifiedNoUser = true;
        }
      } catch (error) {
        if (/HTTP (401|403|429)/.test(error.message)) throw error;
        if (/HTTP 400\b/.test(error.message)) unsupportedUserSearch.add("list");
        errors.push(error.message);
        log("유저 목록 검색 실패: " + error.message);
      }
    }
    if (verifiedNoUser) return null;
    try {
      const space = await lookupViaSpace(nickname);
      if (space.user) {
        log("실시간 스페이스 API에서 닉네임 확인: " + nickname);
        return space.user;
      }
      if (space.missing) {
        log("실시간 사용자 검색에서 닉네임이 없음을 확인: " + nickname);
        return null;
      }
    } catch (error) {
      if (error.message === "HTTP 429") throw error;
      errors.push(error.message);
      log("스페이스 API 검색 실패: " + error.message);
    }
    throw new Error(
      "사용자 검색 API로 계정 존재 여부를 확인하지 못했습니다. " +
      "로컬 데이터가 있으면 EntryInfoBot.loadDatabase()로 불러올 수 있습니다. " +
      errors.slice(-2).join(" / ")
    );
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

  function getUserInfo(nickname, authorHint = null) {
    const existing = userInfoCache.get(nickname);
    if (existing && existing.expiresAt > Date.now()) return existing.promise;
    if (existing) userInfoCache.delete(nickname);

    const promise = fetchUserInfo(nickname, authorHint);
    userInfoCache.set(nickname, {
      promise,
      expiresAt: Date.now() + CONFIG.infoCacheMs
    });
    promise.then(result => {
      const record = userInfoCache.get(nickname);
      if (record?.promise === promise) {
        record.expiresAt = Date.now() +
          (result === "그런 유저 없음" ? CONFIG.negativeCacheMs : CONFIG.infoCacheMs);
      }
    }, () => {
      if (userInfoCache.get(nickname)?.promise === promise) {
        userInfoCache.delete(nickname);
      }
    });
    return promise;
  }

  async function fetchUserInfo(nickname, authorHint = null) {
    if (typeof nickname !== "string" || !nickname.trim() || nickname.length > 40) {
      throw new Error("닉네임은 1~40자여야 해요.");
    }
    // If the Story author asks about their own nickname, the Story API already
    // gives us their account ID. Confirm the exact nickname again via userstatus.
    const hinted = authorHint?.id && authorHint?.nickname === nickname;
    const user = hinted ? { id: authorHint.id, nickname } : await lookupUser(nickname);
    if (hinted) log("작성자 닉네임과 조회 대상이 일치해 검색 API를 생략했어요: " + nickname);
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

  async function latestStories(start = 0) {
    const pageParam = { display: CONFIG.maxPostFetch, sort: "created" };
    if (start > 0) pageParam.start = start;
    const result = await graphql("SELECT_ENTRYSTORY", Q.stories, {
      category: "free",
      term: "all",
      discussType: "entrystory",
      searchType: "scroll",
      pageParam
    });
    if (!Array.isArray(result.discussList?.list)) {
      throw new Error("새 엔트리 이야기 목록을 확인할 수 없어요.");
    }
    return result.discussList.list;
  }

  async function collectRecentStories(first = null) {
    const all = [];
    const ids = new Set();
    for (let page = 0; page < CONFIG.maxScanPages; page++) {
      const batch = page === 0 && first ? first :
        await latestStories(page * CONFIG.maxPostFetch);
      for (const post of batch) {
        if (!post?.id || ids.has(post.id)) continue;
        ids.add(post.id);
        all.push(post);
      }
      if (batch.length < CONFIG.maxPostFetch) break;
    }
    return all;
  }

  function saveQueue() {
    save(KEYS.pending, state.queue.slice(0, CONFIG.maxPending));
  }

  function enqueue(newPosts) {
    const inQueue = new Set(state.queue.map(item => item.id));
    const seenPosts = new Set();
    let added = 0, alreadyHandled = 0, overflow = 0;
    for (const post of newPosts) {
      const request = classifyCommand(post.content);
      if (!post?.id || !post.user?.id || !request || seenPosts.has(post.id)) continue;
      seenPosts.add(post.id);
      if (state.replied.has(post.id) || inQueue.has(post.id)) {
        alreadyHandled++;
        continue;
      }
      if (state.queue.length >= CONFIG.maxPending) {
        overflow++;
        continue;
      }
      state.queue.push({
        id: post.id,
        kind: request.kind,
        nickname: request.nickname,
        author: { id: post.user.id, nickname: post.user.nickname },
        tries: 0
      });
      inQueue.add(post.id);
      added++;
      log(post.user.nickname + "님의 게시글에서 " +
        (request.kind === "format-error" ? "명령어 형식 오류" : request.nickname + " 정보 요청") +
        " 감지");
    }
    if (added) saveQueue();
    if (overflow) log("대기열 최대 " + CONFIG.maxPending +
      "건 초과: " + overflow + "건은 접수하지 못했어요.");
    return { added, alreadyHandled, overflow };
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
      reply = item.kind === "format-error"
        ? formatErrorMessage(item.nickname)
        : await getUserInfo(item.nickname, item.author);
    } catch (error) {
      log(item.nickname + " 정보 조회 실패: " + error.message);
      if (!state.running) {
        saveQueue();
        return;
      }
      item.tries = (item.tries || 0) + 1;
      if (item.tries < CONFIG.maxRetries) {
        state.queue.shift();
        state.queue.push(item);
        saveQueue();
        log("닉네임 조회 재시도 예정 (" + item.tries + "/" + CONFIG.maxRetries + ")");
        return;
      }
      reply = "⚠️ 현재 유저 정보를 확인할 수 없습니다.\n" +
        "조회 대상: " + item.nickname + "\n" +
        "검색 서버 오류가 발생했습니다. 잠시 후 다시 요청해 주세요.";
      log("조회 실패 안내 댓글 준비: " + item.nickname);
    }
    if (!state.running || state.queue[0] !== item) return;

    if (state.preview) {
      state.queue.shift();
      saveQueue();
      log("[미리보기] 게시글 " + item.id + " → " + reply.replace(/\n/g, " | "));
      return;
    }

    // Mark before the network request: unknown HTTP outcomes must not cause duplicate comments.
    markReplyAttempt(item.id);
    state.queue.shift();
    saveQueue();
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
      let posts = await latestStories();
      if (!state.running) return;
      state.lastCheckedAt = Date.now();
      if (posts.length) {
        const previous = state.newestId;
        const newest = posts[0].id;
        if (previous && posts.length >= CONFIG.maxPostFetch &&
            !posts.some(post => post.id === previous)) {
          posts = await collectRecentStories(posts);
        }
        if (!state.running) return;
        const checkpointIndex = previous ?
          posts.findIndex(post => post.id === previous) : -1;
        const unseen = checkpointIndex >= 0 ? posts.slice(0, checkpointIndex) : posts;
        state.newestId = newest;
        if (previous && checkpointIndex === -1) {
          log("이전 확인 글을 찾지 못했어요. 최근 최대 " +
            (CONFIG.maxPostFetch * CONFIG.maxScanPages) + "개 글의 명령어를 복구합니다.");
        }
        if (previous) enqueue(unseen.reverse());
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
      // Preserve queued requests recovered from localStorage.
      state.timer = setInterval(() => { tick(); }, CONFIG.intervalMs);
      // Do not add another full polling delay for requests restored on launch.
      if (state.queue.length) {
        Promise.resolve().then(() => {
          if (state.running && !state.busy) tick();
        });
      }
      log(state.preview
        ? "👀 미리보기 모드 시작 (댓글을 게시하지 않아요)"
        : "🤖 자동 댓글 시작: 이후 올라오는 모든 사용자의 명령어 글(내 글 포함)에 댓글을 답니다.");
      return status();
    } finally {
      if (generation === state.generation) state.starting = false;
    }
  }


  // Read-only diagnostics: show how the bot parses recent command-looking posts.
  async function inspectRecent() {
    checkPage();
    const posts = await collectRecentStories();
    const rows = posts.filter(post => {
      const text = plainText(post.content);
      return text.startsWith("!") || text.includes("정보");
    }).map(post => {
      const text = plainText(post.content);
      const request = classifyCommand(post.content);
      return {
        postId: post.id,
        author: post.user?.nickname || "(알 수 없음)",
        content: text.slice(0, 150),
        recognizedNickname: request?.nickname || "(인식 안 됨)",
        classification: request?.kind === "format-error" ? "형식 오류 → 사용법 안내" :
          request?.kind === "info" ? "정상 명령어" : "해당 없음",
        replyAttempted: state.replied.has(post.id),
        queued: state.queue.some(item => item.id === post.id)
      };
    });
    console.table(rows);
    if (!rows.length) log("최근 " + CONFIG.maxPostFetch * CONFIG.maxScanPages +
      "개 게시글에서 정보 명령어 후보를 찾지 못했어요.");
    return rows;
  }

  // Queue ALL matching posts, not just one, and reply to each as rate limits permit.
  async function replyToRecentCommand(nickname = null, authorNickname = null, authorId = null) {
    checkPage();
    if (nickname !== null &&
        (typeof nickname !== "string" || !nickname.trim() || nickname.length > 40)) {
      throw new Error("조회할 닉네임(1~40자)을 지정하거나 전체 명령어는 인수 없이 호출하세요.");
    }
    const auth = credentials();
    if (!auth.id || !auth.token || !auth.csrf) {
      throw new Error("엔트리 로그인 정보를 확인할 수 없어요.");
    }
    if (state.busy || state.starting) {
      throw new Error("다른 명령어를 처리 중이에요. 잠시 후 다시 실행해 주세요.");
    }
    if (state.running && state.preview) {
      throw new Error("미리보기 모드에서는 댓글을 달지 않습니다. 정지하고 자동 댓글 모드로 다시 실행해 주세요.");
    }

    state.busy = true;
    try {
      const posts = await collectRecentStories();
      const matches = posts.filter(post => {
        const requested = classifyCommand(post.content);
        return requested && (nickname === null || requested.nickname === nickname) &&
          (authorNickname === null || post.user?.nickname === authorNickname) &&
          (authorId === null || post.user?.id === authorId);
      });
      if (!matches.length) {
        throw new Error("최근 " + CONFIG.maxPostFetch * CONFIG.maxScanPages +
          "개 글에서 조건에 맞는 명령어를 찾지 못했어요.");
      }

      // Auto-start only after an explicit reply command; it continues draining the queue.
      if (!state.running) await start();
      const added = enqueue([...matches].reverse());
      const attemptsBefore = state.attempts.length;
      await processQueue();
      const attemptedNow = state.attempts.length > attemptsBefore ? 1 : 0;

      log("📬 일괄 처리: 일치 " + matches.length + "건 / 신규 예약 " +
        added.added + "건 / 이미 처리·예약 " + added.alreadyHandled +
        "건 / 초과 " + added.overflow + "건 / 대기 " + state.queue.length + "건");
      return {
        matched: matches.length,
        addedToQueue: added.added,
        alreadyHandled: added.alreadyHandled,
        overflow: added.overflow,
        attemptedNow,
        pending: state.queue.length
      };
    } finally {
      state.busy = false;
    }
  }

  async function replyToOwnPost(nickname) {
    const id = credentials().id;
    if (!id) throw new Error("엔트리 로그인 정보를 확인할 수 없어요.");
    return replyToRecentCommand(nickname, null, id);
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
      databaseLoaded: Boolean(nicknameDatabase),
      cachedProfiles: userInfoCache.size,
      pollIntervalSeconds: CONFIG.intervalMs / 1000,
      replyGapSeconds: CONFIG.minReplyIntervalMs / 1000,
      hourlyReplyLimit: CONFIG.maxRepliesPerHour,
      recentLogs: state.logs.slice(-5)
    };
    console.table({
      "실행 중": result.running,
      "모드": result.mode,
      "대기 중": result.queued,
      "최근 1시간 댓글 시도": result.repliesAttemptedLastHour,
      "최근 조회": result.lastCheckedAt,
      "로컬 DB 준비": result.databaseLoaded,
      "프로필 캐시": result.cachedProfiles,
      "글 확인 간격(초)": result.pollIntervalSeconds,
      "댓글 간격(초)": result.replyGapSeconds,
      "시간당 최대 댓글": result.hourlyReplyLimit
    });
    return result;
  }

  const api = {
    start,
    preview: () => start({ preview: true }),
    stop,
    status,
    replyToAllRecentCommands: () => replyToRecentCommand(),
    parse: commandNickname,
    classify: classifyCommand,
    inspectRecent,
    replyToRecentCommand,
    useLocalDatabase,
    loadDatabase,
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
      "EntryInfoBot.inspectRecent() 정상/형식 오류 명령어 검사 (댓글 없음)\n" +
      "EntryInfoBot.classify('!김곤충 정보') 명령어 예외처리 결과 확인\n" +
      "await EntryInfoBot.replyToRecentCommand('요니작가_온작') 최근 같은 명령어 글 모두 예약\n" +
      "await EntryInfoBot.replyToAllRecentCommands() 최근 명령어 글 전체 예약\n" +
      "EntryInfoBot.loadDatabase() 비공개 ent2-backup/data.json 선택 (오른쪽 위 버튼 클릭)\n" +
      "await EntryInfoBot.replyToOwnPost('삼류') 이미 올린 내 같은 명령어 글 모두 예약\n" +
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
