/* Entry Info Bot - background scheduler (Manifest V3) */
"use strict";

const ALARM_NAME = "entry-info-bot-minute";
const STORY_URL = "https://playentry.org/community/entrystory/list*";
let dispatching = false;

async function ensureAlarm() {
  const alarm = await chrome.alarms.get(ALARM_NAME);
  if (!alarm) await chrome.alarms.create(ALARM_NAME, { periodInMinutes: 1 });
}

async function saveStatus(patch) {
  const data = await chrome.storage.local.get("runtime");
  await chrome.storage.local.set({
    runtime: Object.assign({}, data.runtime || {}, patch)
  });
}

async function findStoryTab() {
  const tabs = await chrome.tabs.query({ url: STORY_URL });
  if (!tabs.length) {
    throw new Error("엔트리 이야기 목록 탭을 열어주세요.");
  }
  return tabs.find(tab => tab.active && tab.status === "complete") ||
    tabs.find(tab => tab.status === "complete") ||
    tabs[0];
}

function receiverMissing(error) {
  return /receiving end does not exist|could not establish connection/i.test(
    String(error?.message || error || ""));
}

async function messageStory(message) {
  const tab = await findStoryTab();
  if (!Number.isInteger(tab.id)) throw new Error("엔트리 탭을 찾지 못했습니다.");
  try {
    return await chrome.tabs.sendMessage(tab.id, message);
  } catch (error) {
    if (!receiverMissing(error)) throw error;
  }

  // After installation or extension reload, an already-open page may not yet
  // have the declared content scripts. Insert exactly once and retry.
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["core.js", "auth.js", "content.js"]
    });
  } catch (error) {
    throw new Error("엔트리 탭 연결 실패: 페이지를 새로고침해 주세요. " +
      String(error?.message || error));
  }
  try {
    return await chrome.tabs.sendMessage(tab.id, message);
  } catch (error) {
    if (receiverMissing(error)) {
      throw new Error("페이지 연결에 실패했습니다. 확장프로그램을 새로고침하고 다시 시도하세요.");
    }
    throw error;
  }
}

async function dispatch(dryRun) {
  if (dispatching) return { ok: false, message: "이미 확인 중입니다." };
  dispatching = true;
  try {
    const response = await messageStory({
      type: "ENTRY_BOT_TICK", dryRun: dryRun === true
    });
    return response || { ok: false, message: "엔트리 페이지의 응답이 없습니다." };
  } catch (error) {
    const message = String(error?.message || error);
    await saveStatus({ lastError: message, lastCheckAt: Date.now(), message });
    return { ok: false, message };
  } finally {
    dispatching = false;
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  await ensureAlarm();
  const { running } = await chrome.storage.local.get("running");
  if (typeof running !== "boolean") await chrome.storage.local.set({ running: false });
});
chrome.runtime.onStartup.addListener(ensureAlarm);

chrome.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name !== ALARM_NAME) return;
  const { running } = await chrome.storage.local.get("running");
  if (running === true) {
    const response = await dispatch(false);
    if (!response.ok && /로그인 세션|계정 ID|xToken|CSRF 토큰|HTTP 40[13]|HTTP 429/i.test(
      response.message || "")) {
      await chrome.storage.local.set({ running: false });
    }
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !["ENTRY_BOT_START", "ENTRY_BOT_STOP",
    "ENTRY_BOT_PREVIEW", "ENTRY_BOT_PAGE"].includes(message.type)) return false;
  (async () => {
    await ensureAlarm();
    if (message.type === "ENTRY_BOT_START") {
      await chrome.storage.local.set({ running: true });
      const result = await dispatch(false);
      if (!result.ok) await chrome.storage.local.set({ running: false });
      return result;
    }
    if (message.type === "ENTRY_BOT_STOP") {
      await chrome.storage.local.set({ running: false });
      await saveStatus({ lastError: "", running: false, message: "자동 확인 중지" });
      return { ok: true, message: "자동 실행을 중지했습니다." };
    }
    if (message.type === "ENTRY_BOT_PREVIEW") return dispatch(true);
    if (message.type === "ENTRY_BOT_PAGE" &&
        ["ENTRY_BOT_DRAFT", "ENTRY_BOT_CLEAR_DRAFT"].includes(message.action)) {
      return messageStory({ type: message.action });
    }
    return { ok: false, message: "지원하지 않는 명령입니다." };
  })().then(sendResponse).catch(error =>
    sendResponse({ ok: false, message: String(error?.message || error) }));
  return true;
});
