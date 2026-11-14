/* Entry Info Bot - background scheduler (Manifest V3) */
"use strict";

const ALARM_NAME = "entry-info-bot-minute";
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

async function dispatch(dryRun) {
  if (dispatching) return { ok: false, message: "이미 확인 중입니다." };
  dispatching = true;
  try {
    const tabs = await chrome.tabs.query({
      url: "https://playentry.org/community/entrystory/list*"
    });
    if (!tabs.length) {
      const message = "엔트리 이야기 목록 탭을 열어야 확인할 수 있습니다.";
      await saveStatus({ lastError: message, lastCheckAt: Date.now() });
      return { ok: false, message };
    }
    const preferred = tabs.find(tab => tab.active) || tabs[0];
    const response = await chrome.tabs.sendMessage(preferred.id, {
      type: "ENTRY_BOT_TICK",
      dryRun: dryRun === true
    });
    return response || { ok: false, message: "콘텐츠 스크립트의 응답이 없습니다." };
  } catch (error) {
    const message = String(error && error.message || error);
    await saveStatus({ lastError: message, lastCheckAt: Date.now() });
    return { ok: false, message };
  } finally {
    dispatching = false;
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  await ensureAlarm();
  const saved = await chrome.storage.local.get(["running", "runtime"]);
  if (typeof saved.running !== "boolean") {
    await chrome.storage.local.set({ running: false });
  }
});

chrome.runtime.onStartup.addListener(ensureAlarm);

chrome.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name !== ALARM_NAME) return;
  const { running } = await chrome.storage.local.get("running");
  if (running === true) await dispatch(false);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    await ensureAlarm();
    if (message && message.type === "ENTRY_BOT_START") {
      await chrome.storage.local.set({ running: true });
      return dispatch(false);
    }
    if (message && message.type === "ENTRY_BOT_STOP") {
      await chrome.storage.local.set({ running: false });
      await saveStatus({ lastError: "", running: false });
      return { ok: true, message: "자동 실행을 중지했습니다." };
    }
    if (message && message.type === "ENTRY_BOT_PREVIEW") {
      return dispatch(true);
    }
    return { ok: false, message: "알 수 없는 명령입니다." };
  })().then(sendResponse).catch(error =>
    sendResponse({ ok: false, message: String(error && error.message || error) }));
  return true;
});
