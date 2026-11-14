"use strict";
const core = globalThis.EntryBotCore;
const fields = ["commentEnabled","commentMessages","commentMode","commentIntervalMinutes","commentsPerDay","postEnabled","postAutoPublish","postMessages","postMode","postTrigger","countThreshold","timeThresholdMinutes","postsPerDay"];
const $ = id => document.getElementById(id);
const say = message => { $("status").textContent = message; };

function formatStatus(running, runtime) {
  const lines = [running ? "자동 확인 실행 중" : "자동 확인 중지"];
  if (runtime?.lastCheckAt)
    lines.push("최근 확인: " + new Date(runtime.lastCheckAt).toLocaleString("ko-KR"));
  if (Number.isInteger(runtime?.scannedPosts))
    lines.push("조회한 엔트리이야기 글: " + runtime.scannedPosts + "개");
  if (typeof runtime?.countAbove === "number") {
    lines.push("내 글 위 새 글: " + runtime.countAbove +
      (runtime.countIsLowerBound ? "개 이상" : "개"));
  }
  if (runtime?.ageMinutes !== null && Number.isFinite(runtime?.ageMinutes))
    lines.push("내 글 작성 후: " + runtime.ageMinutes + "분");
  if (runtime?.commentStatus) lines.push("댓글: " + runtime.commentStatus);
  if (runtime?.postStatus) lines.push("새 글: " + runtime.postStatus);
  if (runtime?.commentPreview && runtime.dryRun)
    lines.push("다음 댓글: " + runtime.commentPreview);
  if (runtime?.postPreview && runtime.dryRun)
    lines.push("다음 글: " + runtime.postPreview);
  if (runtime?.lastError) lines.push("오류: " + runtime.lastError);
  else if (!runtime?.commentStatus && runtime?.message)
    lines.push(runtime.message);
  return lines.join("\n");
}
async function fetchSettings() {
  const data = await chrome.storage.local.get(["settings","running","runtime"]);
  const settings = core.normalizeSettings(data.settings || core.DEFAULTS);
  for (const name of fields) {
    const el = $(name);
    if (el.type === "checkbox") el.checked = Boolean(settings[name]);
    else el.value = String(settings[name]);
  }
  say(formatStatus(data.running, data.runtime));
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
  const { running, runtime } = await chrome.storage.local.get(["running","runtime"]);
  say(result?.ok ? formatStatus(running, result?.commentStatus ? result : runtime) :
    ("작동 실패: " + (result?.message || "응답 없음")));
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
$("preview").addEventListener("click",safe(async()=>{await saveSettings();const r=await send("ENTRY_BOT_PREVIEW");if(r?.ok)say(formatStatus((await chrome.storage.local.get("running")).running, r));}));
$("loadDraft").addEventListener("click",safe(async()=>{const r=await draftAction("ENTRY_BOT_DRAFT");$("draft").value=r.draft?.content || "";say(r.draft?"준비된 초안을 불러왔습니다.":"준비된 초안이 없습니다.");}));
$("clearDraft").addEventListener("click",safe(async()=>{await draftAction("ENTRY_BOT_CLEAR_DRAFT");$("draft").value="";say("초안을 비웠습니다.");}));
$("copyDraft").addEventListener("click",safe(async()=>{if(!$("draft").value.trim())throw new Error("복사할 초안이 없습니다.");await navigator.clipboard.writeText($("draft").value);say("초안을 복사했습니다. 엔트리 이야기에서 직접 게시하세요.");}));
fetchSettings().catch(e=>say(e.message));
