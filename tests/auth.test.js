"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const auth = require("../auth.js");

test("Entry homepage session: props.initialState common user._id", () => {
  const result = auth.parseNextData({ props: {
    initialProps: { csrfToken: "csrf-from-root" },
    initialState: { common: { user: {
      _id: "507f1f77bcf86cd799439011",
      username: "test-account",
      xToken: "session-token"
    } } }
  } });
  assert.deepEqual(result, {
    id: "507f1f77bcf86cd799439011",
    token: "session-token",
    csrf: "csrf-from-root"
  });
  assert.equal(auth.complete(result), true);
});

test("Entry Story session: pageProps.initialState common user.id", () => {
  const result = auth.parseNextData({ props: {
    initialProps: { csrfToken: "server-csrf" },
    pageProps: { initialState: { common: { user: {
      id: "507f1f77bcf86cd799439099", xToken: "story-token"
    } } } }
  } });
  assert.equal(result.id, "507f1f77bcf86cd799439099");
  assert.equal(result.token, "story-token");
  assert.equal(result.csrf, "server-csrf");
});

test("pick complete user instead of an incomplete snapshot", () => {
  const result = auth.parseNextData({ props: {
    initialProps: { csrfToken: "CSRF" },
    pageProps: { initialState: { common: { user: {
      id: "incomplete", xToken: ""
    } } } },
    initialState: { common: { user: {
      _id: "complete", xToken: "token"
    } } }
  } });
  assert.equal(result.id, "complete");
  assert.equal(result.token, "token");
});

test("missing / logged-out user cannot be treated as authenticated", () => {
  assert.equal(auth.complete(auth.parseNextData({ props: {
    initialProps: { csrfToken: "CSRF" },
    pageProps: { initialState: { common: { user: null } } }
  } })), false);
});

test("readDocument uses shared DOM script and meta CSRF", () => {
  const result = auth.readDocument({
    querySelector: selector => selector === 'meta[name="csrf-token"]'
      ? { content: "meta-csrf" } : null,
    getElementById: id => id === "__NEXT_DATA__" ? {
      textContent: JSON.stringify({ props: {
        pageProps: { initialState: { common: { user: {
          _id: "507f1f77bcf86cd799439011", xToken: "token"
        } } } }
      } })
    } : null
  });
  assert.equal(auth.complete(result), true);
  assert.equal(result.csrf, "meta-csrf");
});

test("invalid NEXT_DATA does not crash auth detection", () => {
  const result = auth.readDocument({
    querySelector: () => null,
    getElementById: () => ({ textContent: "<invalid>" })
  });
  assert.equal(auth.complete(result), false);
});
