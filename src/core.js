/* Core utilities: this file does not access credentials or the network. */
(function (root, factory) {
  "use strict";
  var api = factory();
  root.EntryInfoBotCore = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function normalizePostText(html) {
    return String(html == null ? "" : html)
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(?:p|div|li)>/gi, "\n")
      .replace(/<[^>]*>/g, "")
      .replace(/&(?:#39|apos);/gi, "'")
      .replace(/&quot;/gi, '"')
      .replace(/&nbsp;/gi, " ")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&amp;/gi, "&")
      .trim();
  }

  function parseCommand(rawText) {
    var text = String(rawText == null ? "" : rawText).trim();
    var match = /^!'([^'\r\n]{1,40})'정보$/u.exec(text);
    return match && match[1].trim() ? match[1] : null;
  }

  function isSelected(value) {
    return value !== null && value !== undefined && value !== false;
  }

  function summarizeProjects(projects) {
    var popular = 0;
    var staff = 0;
    var counted = 0;
    for (var project of projects) {
      if (!project || project.isopen === false || project.isopen === "false") continue;
      counted += 1;
      if (isSelected(project.ranked)) popular += 1;
      if (isSelected(project.staffPicked)) staff += 1;
    }
    return { popular: popular, staff: staff, counted: counted };
  }

  function formatUserInfo(user, projectCounts) {
    if (!user || !user.status || !projectCounts) {
      throw new Error("유저 정보가 완전하지 않습니다.");
    }
    var s = user.status;
    var num = function (n) {
      return typeof n === "number" && Number.isFinite(n)
        ? n.toLocaleString("ko-KR")
        : "확인 불가";
    };
    return [
      "📊 " + user.nickname + "님의 정보",
      "작품 수: " + num(s.project) + "개",
      "팔로워 수: " + num(s.follower) + "명",
      "팔로잉 수: " + num(s.following) + "명",
      "인작 수: " + num(projectCounts.popular) + "개",
      "스선 수: " + num(projectCounts.staff) + "개"
    ].join("\n");
  }

  return {
    normalizePostText: normalizePostText,
    parseCommand: parseCommand,
    isSelected: isSelected,
    summarizeProjects: summarizeProjects,
    formatUserInfo: formatUserInfo
  };
});
