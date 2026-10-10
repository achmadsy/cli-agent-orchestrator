import { afterEach, test } from "node:test";
import assert from "node:assert/strict";

import { authFetch, clearAuthState, setCsrfToken } from "../auth-client.js";

afterEach(() => {
  clearAuthState();
  delete global.fetch;
  delete global.window;
  delete global.CustomEvent;
});

test("state-changing requests include credentials and CSRF", async () => {
  let seen;
  global.window = { dispatchEvent() {} };
  global.CustomEvent = class { constructor(type) { this.type = type; } };
  global.fetch = async (path, options) => {
    seen = { path, options };
    return { status: 200 };
  };
  setCsrfToken("csrf-value");
  await authFetch("/api/change", { method: "POST", headers: { "content-type": "application/json" } });
  assert.equal(seen.options.credentials, "same-origin");
  assert.equal(seen.options.headers["X-CSRF-Token"], "csrf-value");
});

test("safe requests omit CSRF", async () => {
  let seen;
  global.window = { dispatchEvent() {} };
  global.CustomEvent = class { constructor(type) { this.type = type; } };
  global.fetch = async (_path, options) => {
    seen = options;
    return { status: 200 };
  };
  setCsrfToken("csrf-value");
  await authFetch("/api/read");
  assert.equal(seen.credentials, "same-origin");
  assert.equal(seen.headers, undefined);
});

test("401 emits authentication-required event", async () => {
  let eventType;
  global.window = { dispatchEvent(event) { eventType = event.type; } };
  global.CustomEvent = class { constructor(type) { this.type = type; } };
  global.fetch = async () => ({ status: 401 });
  await authFetch("/api/read");
  assert.equal(eventType, "cao-auth-required");
});
