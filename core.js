/*
 * Entry Info Bot - Story Scheduler v2
 * Pure functions shared between the extension UI and the page worker.
 * No credentials are stored or transmitted outside playentry.org.
 */
(function (root) {
  "use strict";

  const DEFAULTS = Object.freeze({
    commentEnabled: true,
    commentMessages: "",
    commentMode: "sequential",
    commentIntervalMinutes: 60,
    commentsPerDay: 4,
    postEnabled: false,
    postAutoPublish: false,
    postMessages: "",
    postMode: "sequential",
    postTrigger: "both",
    countThreshold: 40,
    timeThresholdMinutes: 360,
    postsPerDay: 1
  });

  function boundedNumber(value, fallback, min, max) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.floor(number))) : fallback;
  }

  function parseMessages(value) {
    return String(value || "")
      .split(/\r?\n/u)
      .map(line => line.trim())
      .filter(Boolean)
      .slice(0, 50)
      .map(line => line.slice(0, 500));
  }

  function normalizeSettings(value) {
    const input = value && typeof value === "object" ? value : {};
    const mode = name => input[name] === "random" ? "random" : "sequential";
    return {
      commentEnabled: input.commentEnabled !== false,
      commentMessages: String(input.commentMessages || "").slice(0, 26000),
      commentMode: mode("commentMode"),
      commentIntervalMinutes: boundedNumber(input.commentIntervalMinutes, 60, 15, 1440),
      commentsPerDay: boundedNumber(input.commentsPerDay, 4, 1, 6),
      postEnabled: input.postEnabled === true,
      postAutoPublish: input.postAutoPublish === true,
      postMessages: String(input.postMessages || "").slice(0, 26000),
      postMode: mode("postMode"),
      postTrigger: ["count", "time", "both"].includes(input.postTrigger)
        ? input.postTrigger : "both",
      countThreshold: boundedNumber(input.countThreshold, 40, 1, 100),
      timeThresholdMinutes: boundedNumber(input.timeThresholdMinutes, 360, 1, 10080),
      postsPerDay: boundedNumber(input.postsPerDay, 1, 1, 2)
    };
  }

  function chooseMessage(messages, mode, cursor, previousIndex, random = Math.random) {
    if (!Array.isArray(messages) || messages.length === 0) return null;
    const length = messages.length;
    let index;
    if (mode === "random") {
      // When possible, exclude the previously selected message.
      const last = Number.isInteger(previousIndex) ? previousIndex : -1;
      const value = Math.max(0, Math.min(0.999999999, Number(random()) || 0));
      if (length > 1 && last >= 0 && last < length) {
        index = Math.floor(value * (length - 1));
        if (index >= last) index += 1;
      } else {
        index = Math.floor(value * length);
      }
    } else {
      index = ((Number.isInteger(cursor) ? cursor : 0) % length + length) % length;
    }
    return { content: messages[index], index, nextCursor: (index + 1) % length };
  }

  function shouldPost(settings, countAbove, ageMinutes) {
    if (!settings.postEnabled) return false;
    const byCount = Number.isFinite(countAbove) && countAbove >= settings.countThreshold;
    const byTime = Number.isFinite(ageMinutes) && ageMinutes >= settings.timeThresholdMinutes;
    if (settings.postTrigger === "count") return byCount;
    if (settings.postTrigger === "time") return byTime;
    return byCount && byTime;
  }

  function withinRollingDay(timestamps, now) {
    return (Array.isArray(timestamps) ? timestamps : [])
      .filter(value => Number.isFinite(value) && value <= now && value > now - 86400000);
  }

  function storyAnchor(posts, accountId) {
    if (!Array.isArray(posts) || !accountId) return null;
    const index = posts.findIndex(post =>
      post && post.id && post.user && post.user.id === accountId);
    if (index < 0) return null;
    return { id: posts[index].id, created: posts[index].created, countAbove: index };
  }

  // Select the newest eligible story written by someone OTHER than our account.
  // No targeting of old stories, duplicate comments or repeated authors in 24h.
  function selectCommentTarget(posts, accountId, attemptedIds, authorAttempts, now,
      maxAgeMinutes = 120) {
    if (!Array.isArray(posts) || !accountId || !Number.isFinite(now)) return null;
    const handled = new Set(Array.isArray(attemptedIds) ? attemptedIds : []);
    const recentAuthors = new Set(
      (Array.isArray(authorAttempts) ? authorAttempts : [])
        .filter(record => record && typeof record.id === "string" &&
          Number.isFinite(record.at) && record.at <= now &&
          record.at > now - 86400000)
        .map(record => record.id)
    );
    for (const post of posts) {
      const id = post?.id;
      const authorId = post?.user?.id;
      if (typeof id !== "string" || !id ||
          typeof authorId !== "string" || !authorId ||
          authorId === accountId || handled.has(id) || recentAuthors.has(authorId))
        continue;
      const raw = post.created;
      const createdMs = typeof raw === "number"
        ? (raw < 1e12 ? raw * 1000 : raw) : Date.parse(String(raw || ""));
      const elapsed = now - createdMs;
      if (!Number.isFinite(createdMs) || elapsed < -60000 ||
          elapsed > maxAgeMinutes * 60000) continue;
      return {
        id,
        authorId,
        authorNickname: typeof post.user.nickname === "string"
          ? post.user.nickname.slice(0,60) : "(이름 없음)"
      };
    }
    return null;
  }

  const api = {
    DEFAULTS, parseMessages, normalizeSettings, chooseMessage,
    shouldPost, withinRollingDay, storyAnchor, selectCommentTarget
  };
  root.EntryBotCore = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
