/* Wake up the Story watcher while the browser is running.
   This does not run with the browser closed and does not bypass site restrictions. */
(function () {
  "use strict";
  const ALARM = "entryInfoBotPoll";
  const INTERVAL_MINUTES = 0.5; // Chrome 120+ minimum repeating alarm period.

  async function ensureAlarm() {
    const existing = await chrome.alarms.get(ALARM);
    if (!existing) {
      await chrome.alarms.create(ALARM, { periodInMinutes: INTERVAL_MINUTES });
    }
  }

  async function poll() {
    const config = await chrome.storage.local.get({
      entryInfoBotEnabled: false,
      entryInfoBotAutoReply: false
    });
    if (!config.entryInfoBotEnabled || !config.entryInfoBotAutoReply) return;
    const tabs = await chrome.tabs.query({
      url: "https://playentry.org/community/entrystory/list*"
    });
    // Only one open Entry Story tab is used to prevent duplicate requests.
    const tab = tabs.find(t => t.status === "complete") || tabs[0];
    if (!tab?.id) return;
    try {
      await chrome.tabs.sendMessage(tab.id, { type: "entryInfoBotTick" });
    } catch (error) {
      // A tab may still be loading or refreshing its content scripts.
      console.debug("[Entry Info Bot] Watcher is not ready:", error?.message);
    }
  }

  chrome.runtime.onInstalled.addListener(() => { ensureAlarm(); });
  chrome.runtime.onStartup.addListener(() => { ensureAlarm(); });
  chrome.alarms.onAlarm.addListener(alarm => {
    if (alarm.name === ALARM) poll().catch(error =>
      console.warn("[Entry Info Bot] Alarm failed:", error?.message));
  });
  ensureAlarm().catch(error =>
    console.warn("[Entry Info Bot] Could not initialize alarm:", error?.message));
})();
