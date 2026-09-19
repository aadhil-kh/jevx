// Behavioral smoke test for the jevx service worker.
// Runs src/service-worker.js in a VM with stubbed chrome.* and fetch.
import fs from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";

const SW_PATH = new URL("../src/service-worker.js", import.meta.url).pathname;
const CONTENT_PATH = new URL("../src/content.js", import.meta.url).pathname;

/* ---------- chrome stubs ---------- */

function makeStorageArea() {
  const data = new Map();
  return {
    data,
    async get(key) {
      return key in data || typeof key === "string" ? { [key]: data.get(key) } : {};
    },
    async set(obj) {
      for (const [k, v] of Object.entries(obj)) data.set(k, v);
    },
    async remove(key) {
      const keys = Array.isArray(key) ? key : [key];
      keys.forEach((k) => data.delete(k));
    },
    async setAccessLevel() {},
  };
}

const session = makeStorageArea();
const local = makeStorageArea();
const badge = { text: "" };
let fetchImpl = null;
let fetchCalls = [];

function httpResp({ status = 200, body = null, headers = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => (name in headers ? headers[name] : null) },
    json: async () => {
      if (body instanceof Error) throw body;
      return body;
    },
  };
}

const VALID_BODY = {
  model: "jev-latest",
  answers: {
    sentiment: {
      type: "choice",
      choice: "positive",
      probabilities: { positive: 0.92, neutral: 0.06, negative: 0.02 },
      confidence: 0.88,
    },
  },
  usage: { input_tokens: 0, output_tokens: 0 },
};

const sandbox = {
  console,
  setTimeout,
  clearTimeout,
  Date,
  URL,
  AbortController,
  fetch: async (...args) => {
    fetchCalls.push(args);
    return fetchImpl(...args);
  },
  chrome: {
    runtime: {
      id: "extid",
      getURL: (path) => `chrome-extension://extid${path}`,
      onMessage: { addListener() {} },
      onStartup: { addListener() {} },
      onInstalled: { addListener() {} },
    },
    storage: { session, local },
    action: {
      setBadgeText: ({ text }) => (badge.text = text),
      setBadgeBackgroundColor() {},
    },
  },
};
vm.createContext(sandbox);
new vm.Script(fs.readFileSync(SW_PATH, "utf8")).runInContext(sandbox);

const X_SENDER = { id: "extid", frameId: 0, url: "https://x.com/someone/status/123" };
const POPUP_SENDER = { id: "extid", frameId: 0, url: "chrome-extension://extid/popup/popup.html" };

let passed = 0;
const test = (name, fn) =>
  Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1;
      console.log(`  ok - ${name}`);
    })
    .catch((e) => {
      console.error(`  FAIL - ${name}\n    ${e.message}`);
      process.exitCode = 1;
    });

/* ---------- pure function checks ---------- */

await test("fingerprintText identical in both scripts", async () => {
  const normalize = (src) => src.split("\n").map((l) => l.trim()).join("\n");
  const extract = (path) =>
    normalize(fs.readFileSync(path, "utf8").match(/function fingerprintText\(text\) \{[\s\S]*?padStart\(8, "0"\);\s*\n\s*\}/)[0]);
  assert.equal(extract(SW_PATH), extract(CONTENT_PATH));
  assert.equal(sandbox.fingerprintText("hello world"), sandbox.fingerprintText("hello world"));
  assert.match(sandbox.fingerprintText("hello"), /^[0-9a-f]{8}$/);
});

await test("cacheKeyFor is versioned", async () => {
  assert.equal(sandbox.cacheKeyFor("123", "hi"), `1:jev-latest:123:${sandbox.fingerprintText("hi")}`);
});

await test("validateSentimentResponse accepts a valid payload, records returned model", async () => {
  const v = sandbox.validateSentimentResponse(VALID_BODY);
  assert.equal(v.label, "positive");
  assert.equal(v.model, "jev-latest");
  assert.equal(v.confidence, 0.88);
});

await test("validateSentimentResponse rejects malformed payloads", async () => {
  const bad = [
    null,
    {},
    { ...VALID_BODY, model: "" },
    { ...VALID_BODY, answers: {} },
    { ...VALID_BODY, answers: { sentiment: { ...VALID_BODY.answers.sentiment, type: "text" } } },
    { ...VALID_BODY, answers: { sentiment: { ...VALID_BODY.answers.sentiment, choice: "angry" } } },
    { ...VALID_BODY, answers: { sentiment: { ...VALID_BODY.answers.sentiment, probabilities: { positive: 1.5, neutral: 0, negative: 0 } } } },
    { ...VALID_BODY, answers: { sentiment: { ...VALID_BODY.answers.sentiment, confidence: 2 } } },
    { ...VALID_BODY, answers: { sentiment: { ...VALID_BODY.answers.sentiment, confidence: undefined } } },
  ];
  for (const payload of bad) assert.equal(sandbox.validateSentimentResponse(payload), null, JSON.stringify(payload));
});

await test("parseRetryAfterMs precedence and 60s cap", async () => {
  const h = (obj) => ({ get: (n) => obj[n] ?? null });
  assert.equal(sandbox.parseRetryAfterMs(h({ "retry-after-ms": "250", "Retry-After": "9" })), 250);
  assert.equal(sandbox.parseRetryAfterMs(h({ "Retry-After": "2" })), 2000);
  assert.equal(sandbox.parseRetryAfterMs(h({ "retry-after-ms": "90000" })), null); // falls back to backoff
  assert.equal(sandbox.parseRetryAfterMs(h({})), null);
});

await test("backoffDelay stays bounded with jitter subtracted", async () => {
  for (let i = 0; i < 50; i += 1) {
    const d1 = sandbox.backoffDelay(1);
    assert.ok(d1 >= 375 && d1 <= 500, `retry1: ${d1}`);
    const d3 = sandbox.backoffDelay(3);
    assert.ok(d3 >= 1500 && d3 <= 2000, `retry3: ${d3}`);
  }
});

/* ---------- message validation ---------- */

await test("unknown message type rejected", async () => {
  const r = await sandbox.handleMessage({ type: "NOPE" }, POPUP_SENDER);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, "INVALID_REQUEST");
});

await test("classify rejected from non-X sender and from subframe", async () => {
  for (const sender of [
    { ...X_SENDER, url: "https://evil.example/x" },
    { ...X_SENDER, frameId: 3 },
    { ...X_SENDER, id: "other-extension" },
    POPUP_SENDER,
  ]) {
    const r = await sandbox.handleMessage({ type: "JEVX_CLASSIFY_SENTIMENT", tweetId: "1", text: "hi", fingerprint: sandbox.fingerprintText("hi") }, sender);
    assert.equal(r.error.code, "INVALID_REQUEST");
  }
});

await test("popup settings rejected from X content-script sender", async () => {
  const r = await sandbox.handleMessage({ type: "JEVX_GET_SETTINGS" }, X_SENDER);
  assert.equal(r.error.code, "INVALID_REQUEST");
});

/* ---------- settings / disabled / not configured ---------- */

await test("classify with no key fails NOT_CONFIGURED, zero fetches", async () => {
  fetchCalls = [];
  const r = await sandbox.handleMessage(classifyMsg(), X_SENDER);
  assert.equal(r.error.code, "NOT_CONFIGURED");
  assert.equal(fetchCalls.length, 0);
});

await test("classify while disabled fails DISABLED, zero fetches", async () => {
  await sandbox.handleMessage({ type: "JEVX_SET_ENABLED", enabled: false }, POPUP_SENDER);
  await session.set({ jevxTypesafeApiKey: "sk-test" });
  fetchCalls = [];
  const r = await sandbox.handleMessage(classifyMsg(), X_SENDER);
  assert.equal(r.error.code, "DISABLED");
  assert.equal(fetchCalls.length, 0);
  await sandbox.handleMessage({ type: "JEVX_SET_ENABLED", enabled: true }, POPUP_SENDER);
});

await test("classify validates fields (id, text, fingerprint)", async () => {
  const base = { type: "JEVX_CLASSIFY_SENTIMENT" };
  for (const m of [
    { ...base, tweetId: "abc", text: "hi", fingerprint: "x" },
    { ...base, tweetId: "123", text: "", fingerprint: "x" },
    { ...base, tweetId: "123", text: "hi", fingerprint: "wrong" },
  ]) {
    const r = await sandbox.handleMessage(m, X_SENDER);
    assert.equal(r.error.code, "INVALID_REQUEST");
  }
});

/* ---------- save & test + classify happy path + cache ---------- */

await test("save & test stores key only after a successful TypeSafe test", async () => {
  fetchImpl = async () => httpResp({ body: VALID_BODY });
  assert.equal(session.data.get("jevxTypesafeApiKey"), "sk-test"); // from previous test
  const bad = await sandbox.handleMessage({ type: "JEVX_SAVE_AND_TEST_KEY", apiKey: "sk-new" }, POPUP_SENDER);
  assert.equal(bad.ok, true);
  assert.equal(session.data.get("jevxTypesafeApiKey"), "sk-new");
});

await test("save & test rejects bad key with AUTH and no retry", async () => {
  fetchCalls = [];
  fetchImpl = async () => httpResp({ status: 401, body: { error: "unauthorized" } });
  const r = await sandbox.handleMessage({ type: "JEVX_SAVE_AND_TEST_KEY", apiKey: "sk-bad" }, POPUP_SENDER);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, "AUTH");
  assert.equal(fetchCalls.length, 1); // 401 is never retried
  assert.equal(session.data.get("jevxTypesafeApiKey"), "sk-new"); // unchanged
  assert.equal(badge.text, "!"); // badge set on auth failure
});

await test("auth cooldown fails fast without hammering the bad key", async () => {
  await session.set({ jevxTypesafeApiKey: "sk-bad" });
  fetchCalls = [];
  const r = await sandbox.handleMessage(classifyMsg(), X_SENDER);
  assert.equal(r.error.code, "AUTH");
  assert.equal(fetchCalls.length, 0); // cooldown kicked in
});

await test("successful classify: normalized result, badge cleared, persistent cache hit on 2nd call", async () => {
  await session.data.delete("jevxAuthFailureAt");
  await session.set({ jevxTypesafeApiKey: "sk-good" });
  fetchCalls = [];
  fetchImpl = async () => httpResp({ body: VALID_BODY });
  const first = await sandbox.handleMessage(classifyMsg(), X_SENDER);
  assert.equal(first.ok, true);
  assert.equal(first.result.label, "positive");
  assert.equal(first.result.probability, 0.92);
  assert.equal(first.result.cached, false);
  assert.equal(first.result.model, "jev-latest");
  assert.ok(Number.isFinite(first.result.latencyMs));
  assert.equal(fetchCalls.length, 1);
  assert.equal(badge.text, "");

  const second = await sandbox.handleMessage(classifyMsg(), X_SENDER);
  assert.equal(second.ok, true);
  assert.equal(second.result.cached, true);
  assert.equal(fetchCalls.length, 1); // served from chrome.storage.local cache
});

await test("different text fingerprint misses the cache", async () => {
  fetchCalls = [];
  fetchImpl = async () => httpResp({ body: VALID_BODY });
  const r = await sandbox.handleMessage(classifyMsg("edited text"), X_SENDER);
  assert.equal(r.ok, true);
  assert.equal(fetchCalls.length, 1);
});

/* ---------- retry / error mapping ---------- */

await test("500 retries exactly 3 times then maps to API", async () => {
  await local.remove("jevxClassificationCache");
  fetchCalls = [];
  let n = 0;
  fetchImpl = async () => {
    n += 1;
    return httpResp({ status: 500, body: { error: "boom" }, headers: { "retry-after-ms": "10" } });
  };
  const r = await sandbox.handleMessage(classifyMsg("500 case"), X_SENDER);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, "API");
  assert.equal(fetchCalls.length, 3);
});

await test("429 with Retry-After retries then maps to RATE_LIMIT", async () => {
  await local.remove("jevxClassificationCache");
  fetchCalls = [];
  fetchImpl = async () => httpResp({ status: 429, body: {}, headers: { "Retry-After": "0.01" } });
  const r = await sandbox.handleMessage(classifyMsg("429 case"), X_SENDER);
  assert.equal(r.error.code, "RATE_LIMIT");
  assert.equal(fetchCalls.length, 3);
});

await test("422 does not retry (INVALID_REQUEST)", async () => {
  fetchCalls = [];
  fetchImpl = async () => httpResp({ status: 422, body: {} });
  const r = await sandbox.handleMessage(classifyMsg("422 case"), X_SENDER);
  assert.equal(r.error.code, "INVALID_REQUEST");
  assert.equal(fetchCalls.length, 1);
});

await test("malformed 200 body maps to INVALID_RESPONSE and is not cached", async () => {
  await local.remove("jevxClassificationCache");
  fetchCalls = [];
  fetchImpl = async () => httpResp({ body: { model: "jev-latest", answers: { sentiment: { type: "choice" } } } });
  const r = await sandbox.handleMessage(classifyMsg("malformed case"), X_SENDER);
  assert.equal(r.error.code, "INVALID_RESPONSE");
  assert.equal(fetchCalls.length, 1);
  assert.equal(local.data.has("jevxClassificationCache"), false);
});

await test("connection failure retries then maps to NETWORK", async () => {
  await local.remove("jevxClassificationCache");
  fetchCalls = [];
  fetchImpl = async () => {
    throw new TypeError("Failed to fetch");
  };
  const r = await sandbox.handleMessage(classifyMsg("network case"), X_SENDER);
  assert.equal(r.error.code, "NETWORK");
  assert.equal(fetchCalls.length, 3);
});

/* ---------- popup flows ---------- */

await test("JEVX_GET_SETTINGS returns non-secret state only", async () => {
  const r = await sandbox.handleMessage({ type: "JEVX_GET_SETTINGS" }, POPUP_SENDER);
  assert.equal(r.ok, true);
  assert.deepEqual(Object.keys(r.settings).sort(), ["enabled", "hasApiKey", "lastErrorCode"]);
  assert.equal(r.settings.hasApiKey, true);
  assert.equal(JSON.stringify(r.settings).includes("sk-"), false); // no key material leaked
});

await test("JEVX_CLEAR_KEY removes key; JEVX_CLEAR_CACHE empties cache", async () => {
  await sandbox.handleMessage({ type: "JEVX_CLEAR_CACHE" }, POPUP_SENDER);
  assert.equal(local.data.has("jevxClassificationCache"), false);
  await sandbox.handleMessage({ type: "JEVX_CLEAR_KEY" }, POPUP_SENDER);
  assert.equal(session.data.has("jevxTypesafeApiKey"), false);
  const s = await sandbox.handleMessage({ type: "JEVX_GET_SETTINGS" }, POPUP_SENDER);
  assert.equal(s.settings.hasApiKey, false);
});

function classifyMsg(text = "This update is fantastic. The team absolutely nailed it.") {
  return {
    type: "JEVX_CLASSIFY_SENTIMENT",
    tweetId: "1234567890",
    text,
    fingerprint: sandbox.fingerprintText(text),
  };
}

console.log(`\n${passed} passed, ${process.exitCode ? "FAILURES" : "0 failures"}`);
