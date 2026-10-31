(function () {
  "use strict";
  var keys = {
    enabled: "entryInfoBotEnabled",
    autoReply: "entryInfoBotAutoReply",
    logs: "entryInfoBotLogs",
    lastPoll: "entryInfoBotLastPoll"
  };
  var enabled = document.getElementById("botEnabled");
  var status = document.getElementById("status");
  var result = document.getElementById("testResult");
  var nickname = document.getElementById("nickname");
  var testBtn = document.getElementById("testBtn");
  var logBox = document.getElementById("logs");

  function renderLogs(logs) {
    logBox.replaceChildren();
    if (!Array.isArray(logs) || logs.length === 0) {
      logBox.textContent = "아직 기록이 없습니다.";
      return;
    }
    logs.slice().reverse().forEach(function (entry) {
      var row = document.createElement("div");
      row.className = "log-item";
      var time = document.createElement("span");
      time.className = "log-time";
      time.textContent = entry.time ? new Date(entry.time).toLocaleTimeString("ko-KR") : "";
      row.append(time, document.createTextNode(String(entry.message || "")));
      logBox.appendChild(row);
    });
  }

  async function renderState() {
    var data = await chrome.storage.local.get({
      [keys.enabled]: false,
      [keys.autoReply]: false,
      [keys.logs]: [],
      [keys.lastPoll]: 0
    });
    enabled.checked = Boolean(data[keys.enabled] && data[keys.autoReply]);
    var text = enabled.checked ? "🟢 새 명령어 감지 · 원본 글에 댓글 자동 작성" :
      "⏸ 자동 댓글 중지";
    if (enabled.checked && data[keys.lastPoll]) {
      text += " · 마지막 확인 " + new Date(data[keys.lastPoll]).toLocaleTimeString("ko-KR");
    }
    status.textContent = text;
    renderLogs(data[keys.logs]);
  }

  enabled.addEventListener("change", async function () {
    var start = enabled.checked;
    if (start) {
      var ok = confirm(
        "봇이 다른 사람의 엔트리 이야기 글에서 !'닉네임'정보 명령어를 감지해\n" +
        "봇 계정으로 그 게시글에 자동 댓글을 작성합니다.\n" +
        "엔트리 운영 정책을 확인했고 자동 댓글을 허용하겠습니까?"
      );
      if (!ok) {
        enabled.checked = false;
        return;
      }
    }
    await chrome.storage.local.set({
      [keys.enabled]: start,
      [keys.autoReply]: start,
      entryInfoBotPending: [] // A stopped bot won't resume old pending comments.
    });
    renderState();
  });

  async function testLookup() {
    var nick = nickname.value.trim();
    if (!nick) {
      result.textContent = "닉네임을 입력해 주세요.";
      return;
    }
    testBtn.disabled = true;
    result.textContent = "조회하는 중...";
    try {
      var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      var tab = tabs[0];
      if (!tab || !tab.id || !tab.url ||
          !tab.url.startsWith("https://playentry.org/community/entrystory/list")) {
        throw new Error("엔트리 이야기 목록 탭을 연 뒤 조회해 주세요.");
      }
      var response = await chrome.tabs.sendMessage(tab.id, {
        type: "entryInfoBotLookup",
        nickname: nick
      });
      if (!response || !response.ok) {
        throw new Error((response && response.error) || "답변을 받지 못했습니다.");
      }
      result.textContent = response.text;
    } catch (e) {
      result.textContent = "조회 실패: " + (e.message || String(e));
    } finally {
      testBtn.disabled = false;
    }
  }
  testBtn.addEventListener("click", testLookup);
  nickname.addEventListener("keydown", function (event) {
    if (event.key === "Enter") testLookup();
  });
  document.getElementById("clearLog").addEventListener("click", async function () {
    await chrome.storage.local.set({ [keys.logs]: [] });
    renderState();
  });
  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area === "local" && Object.keys(changes).some(function (k) {
      return Object.values(keys).includes(k);
    })) renderState();
  });
  renderState().catch(function (error) {
    status.textContent = "설정 로드 실패: " + error.message;
  });
})();
