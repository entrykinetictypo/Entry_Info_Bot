"use strict";
const core = globalThis.EntryBotCore;
const fields = ["commentEnabled","commentMessages","commentMode","commentIntervalMinutes","commentsPerDay","postEnabled","postMessages","postMode","postTrigger","countThreshold","timeThresholdMinutes","postsPerDay"];
const $ = id => document.getElementById(id);
const say = message => { $("status").textContent = message; };
async function fetchSettings() {
  const data = await chrome.storage.local.get(["settings","running","runtime"]);
  const settings = core.normalizeSettings(data.settings || core.DEFAULTS);
  for (const name of fields) {
    const el = $(name);
    if (el.type === "checkbox") el.checked = Boolean(settings[name]);
    else el.value = String(settings[name]);
  }
  say((data.running ? "실행 중" : "중지 상태") +
    (data.runtime?.lastCheckAt ? "\n최근 확인: " +
      new Date(data.runtime.lastCheckAt).toLocaleString("ko-KR") : "") +
    (data.runtime?.message ? "\n" + data.runtime.message : ""));
}
async function saveSettings() {
  const values = {};
  for (const name of fields) {
    const el = $(name);
    values[name] = el.type === "checkbox" ? el.checked : el.value;
  }
  const settings = core.normalizeSettings(values);
  await chrome.storage.local.set({ settings });
  return settings;
}
async function send(type) {
  const result = await chrome.runtime.sendMessage({ type });
  say(result?.message || "응답 없음");
  return result;
}
async function draftAction(type) {
  // Route through the background worker so it can recover a missing
  // content script after extension installation or reload.
  const response = await chrome.runtime.sendMessage({
    type: "ENTRY_BOT_PAGE",
    action: type
  });
  if (!response?.ok) throw new Error(response?.message || "초안 요청 실패");
  return response;
}
function safe(handler) {
  return async () => { try { await handler(); } catch (e) { say("오류: " + e.message); } };
}
$("save").addEventListener("click",safe(async()=>{await saveSettings();say("설정을 저장했습니다.");}));
$("start").addEventListener("click",safe(async()=>{await saveSettings();await send("ENTRY_BOT_START");}));
$("stop").addEventListener("click",safe(async()=>{await send("ENTRY_BOT_STOP");}));
$("preview").addEventListener("click",safe(async()=>{await saveSettings();const r=await send("ENTRY_BOT_PREVIEW");if(r?.ok)say(JSON.stringify(r,null,2));}));
$("loadDraft").addEventListener("click",safe(async()=>{const r=await draftAction("ENTRY_BOT_DRAFT");$("draft").value=r.draft?.content || "";say(r.draft?"준비된 초안을 불러왔습니다.":"준비된 초안이 없습니다.");}));
$("clearDraft").addEventListener("click",safe(async()=>{await draftAction("ENTRY_BOT_CLEAR_DRAFT");$("draft").value="";say("초안을 비웠습니다.");}));
$("copyDraft").addEventListener("click",safe(async()=>{if(!$("draft").value.trim())throw new Error("복사할 초안이 없습니다.");await navigator.clipboard.writeText($("draft").value);say("초안을 복사했습니다. 엔트리 이야기에서 직접 게시하세요.");}));
fetchSettings().catch(e=>say(e.message));
