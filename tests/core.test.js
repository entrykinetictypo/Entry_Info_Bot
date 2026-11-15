"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("../core.js");
test("message parsing ignores empty lines and bounds length", () => {
  assert.deepEqual(core.parseMessages(" 하나 \n\n 둘 \r\n"), ["하나", "둘"]);
});
test("sequential messages wrap", () => {
  const messages = ["가", "나", "다"];
  assert.equal(core.chooseMessage(messages, "sequential", 0, -1).content, "가");
  assert.equal(core.chooseMessage(messages, "sequential", 3, -1).content, "가");
  assert.equal(core.chooseMessage(messages, "sequential", 2, -1).nextCursor, 0);
});
test("random choice avoids consecutive repeats", () => {
  const messages = ["가", "나", "다"];
  for (const random of [0, 0.2, 0.5, 0.999]) {
    assert.notEqual(core.chooseMessage(messages, "random", 0, 1, () => random).index, 1);
  }
});
test("new post condition supports count, time and both", () => {
  const base = core.normalizeSettings({ postEnabled: true, countThreshold: 30,
    timeThresholdMinutes: 180 });
  assert.equal(core.shouldPost({ ...base, postTrigger: "count" }, 30, 0), true);
  assert.equal(core.shouldPost({ ...base, postTrigger: "time" }, 0, 180), true);
  assert.equal(core.shouldPost({ ...base, postTrigger: "both" }, 30, 179), false);
  assert.equal(core.shouldPost({ ...base, postTrigger: "both" }, 30, 180), true);
  assert.equal(core.shouldPost({ ...base, postTrigger: "both" }, 29, 180), false);
});
test("limits clamp unsafe values", () => {
  const s = core.normalizeSettings({ commentIntervalMinutes: 0,
    commentsPerDay: 100, countThreshold: 2, timeThresholdMinutes: 10 });
  assert.equal(s.commentIntervalMinutes, 15);
  assert.equal(s.commentsPerDay, 6);
  assert.equal(s.countThreshold, 2);
  assert.equal(s.timeThresholdMinutes, 10);
});
test("find latest own post and count above", () => {
  const posts = [
    { id: "new", user: { id: "other" } },
    { id: "mine", created: "2026-11-14T01:00:00Z", user: { id: "self" } },
    { id: "old", user: { id: "other" } }
  ];
  assert.deepEqual(core.storyAnchor(posts, "self"), { id: "mine",
    created: "2026-11-14T01:00:00Z", countAbove: 1 });
});
test("rolling 24 hours records only recent past events", () => {
  const now = 10 * 86400000;
  assert.deepEqual(core.withinRollingDay([now-86400000, now-1000, now+1000],now),[now-1000]);
});

test("new story triggers accept both thresholds set to 1", () => {
  const config = core.normalizeSettings({
    postEnabled: true, countThreshold: 1, timeThresholdMinutes: 1,
    postTrigger: "both"
  });
  assert.equal(config.countThreshold, 1);
  assert.equal(config.timeThresholdMinutes, 1);
  assert.equal(core.shouldPost(config, 1, 0.99), false);
  assert.equal(core.shouldPost(config, 0, 1), false);
  assert.equal(core.shouldPost(config, 1, 1), true);
  assert.equal(core.normalizeSettings({
    countThreshold: 0, timeThresholdMinutes: 0
  }).countThreshold, 1);
  assert.equal(core.normalizeSettings({
    countThreshold: 0, timeThresholdMinutes: 0
  }).timeThresholdMinutes, 1);
});
