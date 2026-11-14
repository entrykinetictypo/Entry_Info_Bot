/* Entry Info Bot - parse Entry's server-rendered login session without storing tokens. */
(function(root) {
  "use strict";

  function safeString(value) {
    return typeof value === "string" ? value.trim() : "";
  }

  function parseNextData(next, metaCsrf = "") {
    const props = next?.props || {};
    const users = [
      props?.pageProps?.initialState?.common?.user,
      props?.initialState?.common?.user
    ].filter(user => user && typeof user === "object");
    const csrf = safeString(metaCsrf) ||
      safeString(props?.initialProps?.csrfToken) ||
      safeString(props?.pageProps?.initialProps?.csrfToken);
    const entries = users.map(user => ({
      // Entry has used both _id and id in its Next.js session object.
      id: safeString(user._id) || safeString(user.id),
      token: safeString(user.xToken),
      csrf
    }));
    return entries.find(entry => entry.id && entry.token) ||
      entries.find(entry => entry.id || entry.token) ||
      { id: "", token: "", csrf };
  }

  function readDocument(doc) {
    const metaCsrf = safeString(doc?.querySelector('meta[name="csrf-token"]')?.content) ||
      safeString(doc?.querySelector('meta[name="csrf"]')?.content);
    let parsed = {};
    try {
      parsed = JSON.parse(doc?.getElementById("__NEXT_DATA__")?.textContent || "{}");
    } catch (_) {
      // A partial or missing __NEXT_DATA__ is not proof of logout.
    }
    return parseNextData(parsed, metaCsrf);
  }

  function complete(auth) {
    return Boolean(auth?.id && auth?.token && auth?.csrf);
  }

  root.EntryBotAuth = { parseNextData, readDocument, complete };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = root.EntryBotAuth;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
