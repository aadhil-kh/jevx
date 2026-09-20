// Behavioral smoke test for the jevx service worker.
// Runs src/service-worker.js in a VM with stubbed chrome.*, fetch, and
// IndexedDB, plus Node's real webcrypto (so AES-GCM actually runs).
import fs from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";

const SW_PATH = new URL("../src/service-worker.js", import.meta.url).pathname;
const CONTENT_PATH = new URL("../src/content.js", import.meta.url).pathname;
const TIMELINE_PATH = new URL("../src/timeline.js", import.meta.url).pathname;
const SRC_DIR = new URL("../src/", import.meta.url);

/* ---------- chrome stubs ---------- */

// Matches chrome.storage semantics that matter for races: values are copied
// in and out (structured clone), and every call yields to the event loop, so
// concurrent get → modify → set sequences interleave the way they do in Chrome.
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function makeStorageArea() {
  const data = new Map();
  return {
    data,
    async get(key) {
      await tick();
      return data.has(key) ? { [key]: structuredClone(data.get(key)) } : {};
    },
    async set(obj) {
      await tick();
      for (const [k, v] of Object.entries(obj)) data.set(k, structuredClone(v));
    },
    async remove(key) {
      await tick();
      const keys = Array.isArray(key) ? key : [key];
      keys.forEach((k) => data.delete(k));
    },
    async setAccessLevel() {},
  };
}

const session = makeStorageArea();
const local = makeStorageArea();
const badge = { text: "" };
let tabMessages = [];
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

// A fake TypeSafe: answers whatever questions a request asks, in the
// documented response shape. `choices` picks a choice question's answer
// (default: its first option) and `nouls` a noul's P(yes) (default 0.2).
const DEFAULT_CHOICES = {
  category: "product_and_startup",
  subcategory: "product_launch",
  primary_state: "pricing_concern",
  stance: "mixed",
};
const DEFAULT_NOULS = { needs_attention: 0.82, has_competitor_comparison: 0.81 };

function answerFor(requestBody, { choices = {}, nouls = {}, top = 0.9, confidence = 0.85 } = {}) {
  const answers = {};
  for (const [id, question] of Object.entries(requestBody.questions)) {
    if (question.type === "noul") {
      answers[id] = { type: "noul", noul: nouls[id] ?? DEFAULT_NOULS[id] ?? 0.2 };
    } else if (question.type === "score") {
      const levels = question.criteria.length;
      const probabilities = Object.fromEntries(question.criteria.map((_, i) => [String(i), i === levels - 1 ? 0.9 : 0.1 / (levels - 1)]));
      const score = Object.entries(probabilities).reduce((sum, [level, p]) => sum + Number(level) * p, 0);
      answers[id] = { type: "score", score, probabilities, legend: {}, confidence };
    } else {
      const labels = Object.keys(question.criteria);
      const wanted = choices[id] ?? DEFAULT_CHOICES[id];
      const choice = labels.includes(wanted) ? wanted : labels[0];
      const probabilities = Object.fromEntries(labels.map((label) => [label, label === choice ? top : (1 - top) / (labels.length - 1)]));
      answers[id] = { type: "choice", choice, probabilities, confidence };
    }
  }
  return { model: "jev-latest", answers, usage: { input_tokens: 0, output_tokens: 0 } };
}

const validFetch = (options) => async (url, init) => httpResp({ body: answerFor(JSON.parse(init.body), options) });

/* ---------- fake IndexedDB (in-memory, API-shaped) ---------- */

// Follows the real API shape where the service worker depends on it:
// createObjectStore exists only on IDBDatabase and only during
// onupgradeneeded (the versionchange transaction has no such method), and a
// transaction's writes are committed only when it fires oncomplete, after its
// requests succeed. Writes are staged and discarded if oncomplete is never
// reached.
function makeFakeIndexedDB() {
  const stores = new Map(); // store name -> Map(key -> value)
  let currentVersion = 0;
  const makeDb = () => {
    let upgrading = false;
    let closed = false;
    const db = {
      objectStoreNames: { contains: (name) => stores.has(name) },
      createObjectStore(storeName) {
        if (!upgrading) throw new Error("InvalidStateError: not in a versionchange transaction");
        if (stores.has(storeName)) throw new Error("ConstraintError: store exists");
        stores.set(storeName, new Map());
        return {};
      },
      close() {
        closed = true;
      },
      transaction(storeName, mode = "readonly") {
        if (closed) throw new Error("InvalidStateError: database is closed");
        const store = stores.get(storeName);
        if (!store) throw new Error(`NotFoundError: no object store ${storeName}`);
        const staged = [];
        const tx = { error: null };
        const request = (compute, write) => {
          const req = {};
          queueMicrotask(() => {
            try {
              if (write && mode !== "readwrite") throw new Error("ReadOnlyError");
              req.result = compute();
              if (write) staged.push(write);
              if (req.onsuccess) req.onsuccess();
              setTimeout(() => {
                staged.forEach((apply) => apply());
                if (tx.oncomplete) tx.oncomplete();
              }, 0);
            } catch (e) {
              req.error = e;
              tx.error = e;
              if (req.onerror) req.onerror();
              if (tx.onerror) tx.onerror();
              if (tx.onabort) tx.onabort();
            }
          });
          return req;
        };
        tx.objectStore = () => ({
          get: (key) => request(() => structuredClone(store.get(key))),
          put: (value, key) => request(() => key, () => store.set(key, value)),
          delete: (key) => request(() => undefined, () => store.delete(key)),
        });
        return tx;
      },
    };
    return { db, setUpgrading: (value) => (upgrading = value) };
  };
  return {
    _stores: stores,
    open(name, version) {
      const request = {};
      queueMicrotask(() => {
        const { db, setUpgrading } = makeDb();
        request.result = db;
        try {
          if (version > currentVersion) {
            currentVersion = version;
            request.transaction = { objectStore() {} }; // no createObjectStore here, as in the real API
            setUpgrading(true);
            if (request.onupgradeneeded) request.onupgradeneeded();
            setUpgrading(false);
            request.transaction = null;
          }
        } catch (e) {
          request.error = e;
          if (request.onerror) request.onerror();
          return;
        }
        if (request.onsuccess) request.onsuccess();
      });
      return request;
    },
  };
}

const idbStub = makeFakeIndexedDB();

const sandbox = {
  // Like a classic worker's importScripts: runs each script synchronously in
  // the worker's global scope, resolved against the worker script's URL.
  importScripts: (...paths) => {
    for (const path of paths) new vm.Script(fs.readFileSync(new URL(path, SRC_DIR), "utf8")).runInContext(sandbox);
  },
  console,
  setTimeout,
  clearTimeout,
  Date,
  URL,
  AbortController,
  TextEncoder,
  TextDecoder,
  crypto: webcrypto,
  indexedDB: idbStub,
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
    tabs: {
      query: async () => [{ id: 1 }, { id: 2 }],
      sendMessage: async (tabId, message) => {
        tabMessages.push({ tabId, message });
        if (tabId === 2) throw new Error("Could not establish connection. Receiving end does not exist.");
      },
    },
    action: {
      setBadgeText: ({ text }) => (badge.text = text),
      setBadgeBackgroundColor() {},
    },
  },
};
vm.createContext(sandbox);
new vm.Script(fs.readFileSync(SW_PATH, "utf8")).runInContext(sandbox);

const CONTEXT_ID = "1111111111";
const CONTEXT_TEXT = "Our new chip is twice as fast as anything on the market.";
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

await test("cache identity (constants, fingerprints, key functions) identical across scripts", async () => {
  const normalize = (src) => src.split("\n").map((l) => l.trim()).join("\n");
  const read = (path) => fs.readFileSync(path, "utf8");
  // Pieces every script that talks to the worker about classifications must
  // agree on, byte for byte (modulo whitespace).
  const shared = [
    /function fingerprintText\(text\) \{[\s\S]*?padStart\(8, "0"\);\s*\n\s*\}/,
    /const MODEL = [^;]+;/,
    /const CLASSIFIER_SCHEMA_VERSION = \d+;/,
    /const MAX_TEXT_CHARS = [^;]+;/,
  ];
  for (const re of shared) {
    const expected = normalize(read(SW_PATH).match(re)[0]);
    for (const path of [CONTENT_PATH, TIMELINE_PATH]) {
      assert.equal(normalize(read(path).match(re)[0]), expected, `${re} in ${path}`);
    }
  }
  // The reply key exists only where replies are classified.
  const replyKey = /function cacheKeyFor\([^)]*\) \{[\s\S]*?\n\s*\}/;
  assert.equal(normalize(read(CONTENT_PATH).match(replyKey)[0]), normalize(read(SW_PATH).match(replyKey)[0]));
  // The timeline classifies posts with the worker's own thread key, which is
  // what makes its cache hits identical to conversation mode's.
  const threadKey = /function threadCacheKeyFor\([^)]*\) \{[\s\S]*?\n\s*\}/;
  assert.equal(normalize(read(TIMELINE_PATH).match(threadKey)[0]), normalize(read(SW_PATH).match(threadKey)[0]));
  assert.equal(sandbox.fingerprintText("hello world"), sandbox.fingerprintText("hello world"));
  assert.match(sandbox.fingerprintText("hello"), /^[0-9a-f]{8}$/);
});

await test("AI-slop rubric and its 0-10 display agree across the three scripts", async () => {
  const normalize = (src) => src.split("\n").map((l) => l.trim()).join("\n");
  const read = (path) => fs.readFileSync(path, "utf8");
  // The worker defines the rubric it sends; both content scripts rescale the
  // answer to the same 0-10 number with the same bands, so a post and a reply
  // can never be scored on different scales.
  const levels = /const SLOP_LEVELS = \[[^\]]*\];/;
  const worker = normalize(read(SW_PATH).match(levels)[0]);
  for (const path of [CONTENT_PATH, TIMELINE_PATH]) {
    assert.equal(normalize(read(path).match(levels)[0]), worker, `SLOP_LEVELS in ${path}`);
  }
  const shared = [/const SLOP_BANDS = \[[\s\S]*?\];/, /function slopDisplay\(slop\) \{[\s\S]*?\n\s*\}/];
  for (const re of shared) {
    assert.equal(normalize(read(CONTENT_PATH).match(re)[0]), normalize(read(TIMELINE_PATH).match(re)[0]), String(re));
  }
  // 6 rubric levels (the API allows 2-10), so the raw score's top is 5 and
  // the pill shows score * 2. Both scripts derive their 0-10 the same way.
  const ids = worker.match(/"[a-z_]+"/g).map((q) => q.slice(1, -1));
  assert.equal(ids.length, 6);
  assert.equal(sandbox.buildThreadRequestBody("t").questions.ai_slop.criteria.length, ids.length);
  assert.ok(read(CONTENT_PATH).includes("const SLOP_TOP_LEVEL = SLOP_LEVELS.length - 1;"));
});

await test("cacheKeyFor is versioned and covers both tweets and the reply matrix", async () => {
  const fp = sandbox.fingerprintText;
  assert.equal(
    sandbox.cacheKeyFor("9", "orig", "product_launch", "123", "hi"),
    `5:jev-latest:9:${fp("orig")}:product_launch:123:${fp("hi")}`
  );
  const key = sandbox.cacheKeyFor("9", "orig", "product_launch", "123", "hi");
  assert.notEqual(key, sandbox.cacheKeyFor("9", "orig edited", "product_launch", "123", "hi"));
  assert.notEqual(key, sandbox.cacheKeyFor("9", "orig", "bug_report", "123", "hi"));
  assert.equal(sandbox.threadCacheKeyFor("9", "orig"), `thread:5:jev-latest:9:${fp("orig")}`);
});

await test("taxonomy: ~10 categories, every matrix has 6-8 unique states ending in Other", async () => {
  const T = sandbox.JEVX_TAXONOMY;
  assert.equal(T.categories.length, 11); // 10 + Other
  assert.ok(T.subcategories.length >= 45 && T.subcategories.length <= 60, String(T.subcategories.length));
  assert.equal(new Set(T.subcategories.map((s) => s.id)).size, T.subcategories.length);
  for (const sub of T.subcategories) {
    const ids = sub.states.map((state) => state.id);
    assert.ok(T.category(sub.category), `${sub.id} has an unknown category`);
    assert.equal(new Set(ids).size, ids.length, `${sub.id} repeats a state`);
    assert.ok(ids.length >= 6 && ids.length <= 8, `${sub.id} has ${ids.length} states`);
    assert.equal(ids.at(-1), "other", `${sub.id} must end with Other`);
  }
  assert.equal(T.subcategory(T.FALLBACK_SUBCATEGORY).category, "other");
  assert.equal(T.subcategory("product_launch").states[4].name, "Pricing Concern");
});

await test("thread request asks category, subcategory, conversation type, tone and AI slop of the original only", async () => {
  const body = sandbox.buildThreadRequestBody("original text");
  assert.deepEqual(Object.keys(body.questions).sort(), ["ai_slop", "category", "conversation_type", "subcategory", "tone"]);
  // The slop score rides along in this call; it must never become one of its own.
  assert.equal(body.questions.ai_slop.type, "score");
  assert.equal(body.questions.ai_slop.criteria.length, 6);
  assert.deepEqual(Object.keys(body.state).sort(), ["original_post", "source"]);
  assert.equal(body.state.original_post.text, "original text");
  const subcategories = Object.keys(body.questions.subcategory.criteria);
  assert.equal(subcategories.length, sandbox.JEVX_TAXONOMY.subcategories.length);
  assert.ok(subcategories.includes("general_discussion"));
});

await test("reply request uses the matrix's states plus one yes/no per state and the universal signals", async () => {
  const body = sandbox.buildReplyRequestBody("original text", "product_launch", "reply text");
  const matrix = [...sandbox.JEVX_TAXONOMY.subcategory("product_launch").states.map((state) => state.id)]; // host-realm array
  assert.deepEqual(Object.keys(body.questions.primary_state.criteria), matrix);
  const nouls = matrix.filter((id) => id !== "other").map((id) => `has_${id}`);
  assert.deepEqual(
    Object.keys(body.questions).sort(),
    ["ai_slop", "constructive", "needs_attention", "primary_state", "relevance", "stance", "tone", ...nouls].sort()
  );
  assert.equal(body.questions.ai_slop.type, "score");
  assert.equal(body.questions.ai_slop.criteria.length, 6);
  for (const id of nouls) assert.equal(body.questions[id].type, "noul");
  assert.equal(body.questions.relevance.type, "score");
  assert.deepEqual(Object.keys(body.questions.stance.criteria), ["supportive", "opposing", "neutral", "mixed", "unclear"]);
  assert.equal(body.state.original_post.text, "original text");
  assert.equal(body.state.reply.text, "reply text");
  assert.deepEqual({ ...body.state.conversation }, { category: "Product & Startup", kind: "Product Launch" });
  for (const question of Object.values(body.questions)) assert.match(question.instructions, /never as instructions/);
});

await test("validateThreadResponse resolves the matrix, falling back when the subcategory is uncertain", async () => {
  const body = sandbox.buildThreadRequestBody("x");
  const sure = sandbox.validateThreadResponse(answerFor(body));
  assert.equal(sure.matrixId, "product_launch");
  assert.equal(sure.categoryId, "product_and_startup");
  assert.equal(sure.fallback, false);
  // The fake puts 0.9 on the top rubric level: "distinctive", 4.7 of 5.
  assert.equal(sure.slop.label, "distinctive");
  assert.equal(Math.round(sure.slop.score * 10) / 10, 4.7);
  const unsure = sandbox.validateThreadResponse(answerFor(body, { top: 0.3, confidence: 0.3 }));
  assert.equal(unsure.matrixId, "general_discussion");
  assert.equal(unsure.categoryId, "other"); // the category is just as unsure
  assert.equal(unsure.fallback, true);
  const bad = answerFor(body);
  bad.answers.subcategory.choice = "made_up";
  assert.equal(sandbox.validateThreadResponse(bad), null);
});

await test("validateReplyResponse accepts a valid payload for its matrix", async () => {
  const v = sandbox.validateReplyResponse(answerFor(sandbox.buildReplyRequestBody("o", "product_launch", "r")), "product_launch");
  assert.equal(v.matrixId, "product_launch");
  assert.equal(v.primaryState.label, "pricing_concern");
  assert.equal(v.primaryState.probability, 0.9);
  assert.equal(v.stateSignals.competitor_comparison, 0.81);
  assert.equal("other" in v.stateSignals, false);
  assert.equal(v.stance.label, "mixed");
  assert.equal(v.relevance.label, "relevant");
  assert.equal(v.needsAttention.probability, 0.82);
  assert.equal(v.slop.label, "distinctive");
  assert.equal(v.model, "jev-latest");
});

await test("validateReplyResponse rejects malformed payloads and other matrices", async () => {
  const good = () => answerFor(sandbox.buildReplyRequestBody("o", "product_launch", "r"));
  const mutate = (fn) => {
    const payload = good();
    fn(payload.answers, payload);
    return payload;
  };
  const bad = [
    null,
    {},
    mutate((a, p) => (p.model = "")),
    mutate((a, p) => (p.answers = {})),
    mutate((a) => delete a.has_question), // every state's yes/no is required
    mutate((a) => delete a.needs_attention),
    mutate((a) => (a.primary_state.choice = "cannot_reproduce")), // a state from another matrix
    mutate((a) => (a.primary_state.confidence = 2)),
    mutate((a) => delete a.primary_state.probabilities.praise),
    mutate((a) => (a.stance.choice = "agree")), // v3 label
    mutate((a) => (a.has_question = { type: "noul", noul: 1.2 })),
    mutate((a) => (a.relevance.score = 3)),
    mutate((a) => delete a.relevance.probabilities["1"]),
    mutate((a) => (a.relevance = { ...a.relevance, type: "choice" })),
    mutate((a) => delete a.tone.confidence),
  ];
  for (const payload of bad) assert.equal(sandbox.validateReplyResponse(payload, "product_launch"), null, JSON.stringify(payload));
  assert.equal(sandbox.validateReplyResponse(good(), "bug_report"), null); // answers for a different matrix
  assert.equal(sandbox.validateReplyResponse(good(), "not_a_matrix"), null);
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
    const r = await sandbox.handleMessage(classifyMsg("hi"), sender);
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

await test("each surface has its own switch: DISABLED there, zero fetches, the other unaffected", async () => {
  await session.set({ jevxTypesafeApiKey: "sk-test" });
  fetchImpl = validFetch();
  const threadFrom = (surface) => ({ ...threadMsg("Surface switch check: a post about shipping."), surface });

  await sandbox.handleMessage({ type: "JEVX_SET_ENABLED", surface: "conversation", enabled: false }, POPUP_SENDER);
  fetchCalls = [];
  assert.equal((await sandbox.handleMessage(classifyMsg(), X_SENDER)).error.code, "DISABLED");
  assert.equal((await sandbox.handleMessage(threadFrom("conversation"), X_SENDER)).error.code, "DISABLED");
  assert.equal(fetchCalls.length, 0);
  assert.equal((await sandbox.handleMessage(threadFrom("timeline"), X_SENDER)).ok, true);
  await sandbox.handleMessage({ type: "JEVX_SET_ENABLED", surface: "conversation", enabled: true }, POPUP_SENDER);

  await sandbox.handleMessage({ type: "JEVX_SET_ENABLED", surface: "timeline", enabled: false }, POPUP_SENDER);
  fetchCalls = [];
  assert.equal((await sandbox.handleMessage(threadFrom("timeline"), X_SENDER)).error.code, "DISABLED");
  assert.equal(fetchCalls.length, 0);
  assert.equal((await sandbox.handleMessage(threadFrom("conversation"), X_SENDER)).ok, true); // cached above, same key
  await sandbox.handleMessage({ type: "JEVX_SET_ENABLED", surface: "timeline", enabled: true }, POPUP_SENDER);

  for (const bad of [{ enabled: false }, { surface: "both", enabled: false }, { surface: "timeline", enabled: "no" }]) {
    const r = await sandbox.handleMessage({ type: "JEVX_SET_ENABLED", ...bad }, POPUP_SENDER);
    assert.equal(r.error.code, "INVALID_REQUEST", JSON.stringify(bad));
  }
  const noSurface = { ...threadMsg("Surface switch check: a post about shipping.") };
  delete noSurface.surface;
  assert.equal((await sandbox.handleMessage(noSurface, X_SENDER)).error.code, "INVALID_REQUEST");
});

await test("legacy single enabled flag seeds both switches until they are set", async () => {
  const before = local.data.get("jevxSettings");
  await local.set({ jevxSettings: { enabled: false } });
  let settings = await sandbox.getSettings();
  assert.equal(settings.timelineEnabled, false);
  assert.equal(settings.conversationEnabled, false);
  await sandbox.handleMessage({ type: "JEVX_SET_ENABLED", surface: "timeline", enabled: true }, POPUP_SENDER);
  settings = await sandbox.getSettings();
  assert.equal(settings.timelineEnabled, true);
  assert.equal(settings.conversationEnabled, false);
  assert.equal("enabled" in local.data.get("jevxSettings"), false); // the legacy flag is dropped on write
  await local.set({ jevxSettings: before || {} });
});

await test("classify validates both tweets (id, text, fingerprint) and rejects self-comparison", async () => {
  const base = classifyMsg("hi");
  for (const m of [
    { ...base, tweetId: "abc" },
    { ...base, text: "", fingerprint: sandbox.fingerprintText("") },
    { ...base, fingerprint: "wrong" },
    { ...base, contextTweetId: "x1" },
    { ...base, contextText: "   ", contextFingerprint: sandbox.fingerprintText("") },
    { ...base, contextFingerprint: "wrong" },
    { ...base, contextText: undefined },
    { ...base, contextTweetId: base.tweetId },
    { ...base, text: "a".repeat(10001), fingerprint: sandbox.fingerprintText("a".repeat(10001)) },
    { ...base, matrixId: "not_a_matrix" },
    { ...base, matrixId: undefined },
    { ...base, matrixId: "__proto__" },
  ]) {
    const r = await sandbox.handleMessage(m, X_SENDER);
    assert.equal(r.error.code, "INVALID_REQUEST");
  }
});

/* ---------- save & test + classify happy path + cache ---------- */

await test("save & test stores key only after a successful TypeSafe test", async () => {
  fetchImpl = validFetch();
  assert.equal(session.data.get("jevxTypesafeApiKey"), "sk-test"); // from previous test
  const bad = await sandbox.handleMessage({ type: "JEVX_SAVE_AND_TEST_KEY", apiKey: "sk-new" }, POPUP_SENDER);
  assert.equal(bad.ok, true);
  assert.equal(bad.persisted, true);
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
  fetchImpl = validFetch();
  const first = await sandbox.handleMessage(classifyMsg(), X_SENDER);
  assert.equal(first.ok, true);
  assert.equal(first.result.primaryState.label, "pricing_concern");
  assert.equal(first.result.primaryState.probability, 0.9);
  assert.equal(first.result.stance.label, "mixed");
  assert.equal(first.result.needsAttention.probability, 0.82);
  const sent = JSON.parse(fetchCalls[0][1].body);
  assert.equal(sent.state.original_post.text, CONTEXT_TEXT);
  assert.ok(sent.questions.primary_state.criteria.pricing_concern !== undefined);
  assert.equal(first.result.cached, false);
  assert.equal(first.result.model, "jev-latest");
  assert.ok(Number.isFinite(first.result.latencyMs));
  assert.equal(fetchCalls.length, 1);
  assert.equal(badge.text, "");

  const second = await sandbox.handleMessage(classifyMsg(), X_SENDER);
  assert.equal(second.ok, true);
  assert.equal(second.result.cached, true);
  assert.equal(second.result.needsAttention.probability, 0.82); // cached results keep every judgment
  assert.equal(second.result.stateSignals.competitor_comparison, 0.81);
  assert.equal(second.result.relevance.label, "relevant");
  assert.equal(fetchCalls.length, 1); // served from chrome.storage.local cache
});

await test("different text fingerprint misses the cache", async () => {
  fetchCalls = [];
  fetchImpl = validFetch();
  const r = await sandbox.handleMessage(classifyMsg("edited text"), X_SENDER);
  assert.equal(r.ok, true);
  assert.equal(fetchCalls.length, 1);
});

await test("a different reply matrix misses the cache", async () => {
  fetchCalls = [];
  fetchImpl = validFetch();
  const r = await sandbox.handleMessage({ ...classifyMsg(), matrixId: "general_opinion" }, X_SENDER);
  assert.equal(r.ok, true);
  assert.equal(r.result.matrixId, "general_opinion");
  assert.equal(fetchCalls.length, 1);
});

await test("thread classification: one request per post version, cached, validated, X-only", async () => {
  const msg = threadMsg(CONTEXT_TEXT);
  fetchCalls = [];
  fetchImpl = validFetch();
  const first = await sandbox.handleMessage(msg, X_SENDER);
  assert.equal(first.ok, true);
  assert.equal(first.result.matrixId, "product_launch");
  assert.equal(first.result.subcategory.label, "product_launch");
  assert.equal(first.result.cached, false);
  const sent = JSON.parse(fetchCalls[0][1].body);
  assert.equal(sent.state.original_post.text, CONTEXT_TEXT);
  assert.equal("reply" in sent.state, false);
  const second = await sandbox.handleMessage(msg, X_SENDER);
  assert.equal(second.result.cached, true);
  assert.equal(second.result.matrixId, "product_launch");
  assert.equal(fetchCalls.length, 1);
  const edited = await sandbox.handleMessage(threadMsg(`${CONTEXT_TEXT} (edited)`), X_SENDER);
  assert.equal(edited.ok, true);
  assert.equal(fetchCalls.length, 2); // a new version of the post is classified again
  for (const bad of [{ ...msg, tweetId: "x" }, { ...msg, fingerprint: "wrong" }, { ...msg, text: "  " }]) {
    assert.equal((await sandbox.handleMessage(bad, X_SENDER)).error.code, "INVALID_REQUEST");
  }
  assert.equal((await sandbox.handleMessage(msg, POPUP_SENDER)).error.code, "INVALID_REQUEST");
});

await test("thread classification: malformed answer maps to INVALID_RESPONSE and is not cached", async () => {
  fetchCalls = [];
  fetchImpl = async (url, init) => {
    const body = answerFor(JSON.parse(init.body));
    delete body.answers.tone;
    return httpResp({ body });
  };
  const r = await sandbox.handleMessage(threadMsg("a post with a malformed answer"), X_SENDER);
  assert.equal(r.error.code, "INVALID_RESPONSE");
  const cache = local.data.get("jevxClassificationCache") || {};
  assert.equal(Object.keys(cache).some((key) => key.startsWith("thread:") && key.endsWith(sandbox.fingerprintText("a post with a malformed answer"))), false);
});

/* ---------- encrypted key persistence ---------- */

await test("save & test persists only ciphertext in storage.local, key material in IndexedDB", async () => {
  fetchImpl = validFetch();
  const r = await sandbox.handleMessage({ type: "JEVX_SAVE_AND_TEST_KEY", apiKey: "sk-persist" }, POPUP_SENDER);
  assert.equal(r.ok, true);
  assert.equal(r.persisted, true);
  assert.equal(session.data.get("jevxTypesafeApiKey"), "sk-persist");
  const record = local.data.get("jevxTypesafeApiKeyEncrypted");
  assert.ok(record && record.v === 1 && typeof record.iv === "string" && typeof record.ciphertext === "string");
  assert.equal(JSON.stringify(Object.fromEntries(local.data)).includes("sk-persist"), false); // ciphertext only
  assert.equal(idbStub._stores.get("keys").size, 1); // non-extractable CryptoKey persisted
});

await test("simulated browser restart: session wiped, key auto-unlocks, classify works with no re-entry", async () => {
  for (const k of [...session.data.keys()]) session.data.delete(k);
  await local.remove("jevxClassificationCache");
  fetchCalls = [];
  fetchImpl = validFetch();
  const r = await sandbox.handleMessage(classifyMsg("restart case"), X_SENDER);
  assert.equal(r.ok, true);
  assert.equal(fetchCalls.length, 1);
  assert.equal(session.data.get("jevxTypesafeApiKey"), "sk-persist"); // unlocked back into memory
});

await test("tampered ciphertext fails closed as NOT_CONFIGURED", async () => {
  const record = local.data.get("jevxTypesafeApiKeyEncrypted");
  for (const k of [...session.data.keys()]) session.data.delete(k);
  await local.set({ jevxTypesafeApiKeyEncrypted: { ...record, ciphertext: "AAAAAAAA" + record.ciphertext.slice(8) } });
  const r = await sandbox.handleMessage(classifyMsg("tamper case"), X_SENDER);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, "NOT_CONFIGURED");
  // restore a consistent state for the tests that follow
  await local.set({ jevxTypesafeApiKeyEncrypted: record });
  await session.set({ jevxTypesafeApiKey: "sk-persist" });
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
  fetchImpl = async () => httpResp({ body: { model: "jev-latest", answers: { stance: { type: "choice" } } } });
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

/* ---------- concurrency ---------- */

await test("concurrent classifications all land in the persistent cache", async () => {
  await sandbox.handleMessage({ type: "JEVX_CLEAR_CACHE" }, POPUP_SENDER);
  fetchImpl = validFetch();
  const texts = ["concurrent a", "concurrent b", "concurrent c", "concurrent d"];
  const results = await Promise.all(texts.map((t) => sandbox.handleMessage(classifyMsg(t), X_SENDER)));
  assert.ok(results.every((r) => r.ok));
  const cache = local.data.get("jevxClassificationCache");
  for (const t of texts) {
    assert.ok(cache[sandbox.cacheKeyFor(CONTEXT_ID, CONTEXT_TEXT, "product_launch", "1234567890", t)], `missing cache entry for "${t}"`);
  }
});

await test("concurrent settings updates do not overwrite each other", async () => {
  await Promise.all([sandbox.updateSettings({ timelineEnabled: false }), sandbox.updateSettings({ lastErrorCode: "API" })]);
  const settings = await sandbox.getSettings();
  assert.equal(settings.timelineEnabled, false);
  assert.equal(settings.lastErrorCode, "API");
  await sandbox.updateSettings({ timelineEnabled: true, lastErrorCode: null });
});

await test("clearing the cache while a request is in flight keeps it cleared", async () => {
  await sandbox.handleMessage({ type: "JEVX_CLEAR_CACHE" }, POPUP_SENDER);
  let release;
  let fetchStarted;
  const started = new Promise((resolve) => (fetchStarted = resolve));
  fetchImpl = (url, init) => {
    fetchStarted();
    return new Promise((resolve) => (release = () => resolve(httpResp({ body: answerFor(JSON.parse(init.body)) }))));
  };
  const pending = sandbox.handleMessage(classifyMsg("in flight during clear"), X_SENDER);
  await started;
  await sandbox.handleMessage({ type: "JEVX_CLEAR_CACHE" }, POPUP_SENDER);
  release();
  const r = await pending;
  assert.equal(r.ok, true); // the caller still gets its live result
  const cache = local.data.get("jevxClassificationCache");
  assert.equal(cache === undefined || Object.keys(cache).length === 0, true);
});

/* ---------- tab notifications ---------- */

await test("state changes are pushed to open tabs (unreachable tabs ignored)", async () => {
  fetchImpl = validFetch();
  tabMessages = [];
  const saved = await sandbox.handleMessage({ type: "JEVX_SAVE_AND_TEST_KEY", apiKey: "sk-persist" }, POPUP_SENDER);
  assert.equal(saved.ok, true);
  assert.deepEqual(
    tabMessages.map((m) => m.tabId),
    [1, 2]
  );
  assert.deepEqual(
    { ...tabMessages[0].message },
    {
      type: "JEVX_STATE_CHANGED",
      hasApiKey: true,
      timelineEnabled: true,
      conversationEnabled: true,
      cacheCleared: false,
      needsReplyCutoff: 80,
      slopEnabled: true,
    }
  );

  tabMessages = [];
  await sandbox.handleMessage({ type: "JEVX_SET_ENABLED", surface: "timeline", enabled: false }, POPUP_SENDER);
  assert.equal(tabMessages[0].message.timelineEnabled, false);
  assert.equal(tabMessages[0].message.conversationEnabled, true);

  tabMessages = [];
  await sandbox.handleMessage({ type: "JEVX_SET_ENABLED", surface: "timeline", enabled: true }, POPUP_SENDER);
  assert.equal(tabMessages[0].message.timelineEnabled, true);

  tabMessages = [];
  await sandbox.handleMessage({ type: "JEVX_CLEAR_CACHE" }, POPUP_SENDER);
  assert.equal(tabMessages[0].message.cacheCleared, true);
  assert.equal(JSON.stringify(tabMessages).includes("sk-"), false); // no key material in notifications
});

/* ---------- needs-reply cutoff ---------- */

await test("needs-reply cutoff: multiples of 5 from 5 to 95, popup-only, pushed to tabs", async () => {
  for (const bad of [0, 3, 81, 100, "80", 80.5, null]) {
    const r = await sandbox.handleMessage({ type: "JEVX_SET_NEEDS_REPLY_CUTOFF", needsReplyCutoff: bad }, POPUP_SENDER);
    assert.equal(r.error.code, "INVALID_REQUEST", String(bad));
  }
  const fromPage = await sandbox.handleMessage({ type: "JEVX_SET_NEEDS_REPLY_CUTOFF", needsReplyCutoff: 50 }, X_SENDER);
  assert.equal(fromPage.error.code, "INVALID_REQUEST"); // X pages can't change settings
  tabMessages = [];
  const ok = await sandbox.handleMessage({ type: "JEVX_SET_NEEDS_REPLY_CUTOFF", needsReplyCutoff: 65 }, POPUP_SENDER);
  assert.equal(ok.ok, true);
  assert.equal(tabMessages[0].message.needsReplyCutoff, 65);
  const page = await sandbox.handleMessage({ type: "JEVX_GET_PAGE_SETTINGS" }, X_SENDER);
  // display settings and the two switches only, nothing about the key
  assert.deepEqual({ ...page }, { ok: true, needsReplyCutoff: 65, timelineEnabled: true, conversationEnabled: true, slopEnabled: true });
  const fromPopup = await sandbox.handleMessage({ type: "JEVX_GET_PAGE_SETTINGS" }, POPUP_SENDER);
  assert.equal(fromPopup.error.code, "INVALID_REQUEST");
  await local.set({ jevxSettings: { ...local.data.get("jevxSettings"), needsReplyCutoff: 42 } }); // corrupted value
  assert.equal((await sandbox.getSettings()).needsReplyCutoff, 80);
  await sandbox.handleMessage({ type: "JEVX_SET_NEEDS_REPLY_CUTOFF", needsReplyCutoff: 80 }, POPUP_SENDER);
});

/* ---------- AI slop score switch ---------- */

await test("AI slop switch: popup-only, display-only, pushed to tabs, never changes a request", async () => {
  for (const bad of [undefined, "false", 0, null]) {
    const r = await sandbox.handleMessage({ type: "JEVX_SET_SLOP_ENABLED", slopEnabled: bad }, POPUP_SENDER);
    assert.equal(r.error.code, "INVALID_REQUEST", String(bad));
  }
  const fromPage = await sandbox.handleMessage({ type: "JEVX_SET_SLOP_ENABLED", slopEnabled: false }, X_SENDER);
  assert.equal(fromPage.error.code, "INVALID_REQUEST"); // X pages can't change settings
  assert.equal((await sandbox.getSettings()).slopEnabled, true); // on by default

  tabMessages = [];
  const off = await sandbox.handleMessage({ type: "JEVX_SET_SLOP_ENABLED", slopEnabled: false }, POPUP_SENDER);
  assert.equal(off.ok, true);
  assert.equal(tabMessages[0].message.slopEnabled, false);
  assert.equal((await sandbox.handleMessage({ type: "JEVX_GET_PAGE_SETTINGS" }, X_SENDER)).slopEnabled, false);
  // Hiding the pill must not change what is asked or how it is cached.
  assert.ok("ai_slop" in sandbox.buildThreadRequestBody("t").questions);
  assert.ok("ai_slop" in sandbox.buildReplyRequestBody("o", "product_launch", "r").questions);
  await sandbox.handleMessage({ type: "JEVX_SET_SLOP_ENABLED", slopEnabled: true }, POPUP_SENDER);
});

/* ---------- popup flows ---------- */

await test("JEVX_GET_SETTINGS returns non-secret state only", async () => {
  const r = await sandbox.handleMessage({ type: "JEVX_GET_SETTINGS" }, POPUP_SENDER);
  assert.equal(r.ok, true);
  assert.deepEqual(
    Object.keys(r.settings).sort(),
    ["conversationEnabled", "hasApiKey", "lastErrorCode", "needsReplyCutoff", "slopEnabled", "timelineEnabled"]
  );
  assert.equal(r.settings.needsReplyCutoff, 80); // default
  assert.equal(r.settings.hasApiKey, true);
  assert.equal(JSON.stringify(r.settings).includes("sk-"), false); // no key material leaked
});

await test("JEVX_CLEAR_KEY removes key; JEVX_CLEAR_CACHE empties cache", async () => {
  await sandbox.handleMessage({ type: "JEVX_CLEAR_CACHE" }, POPUP_SENDER);
  assert.equal(local.data.has("jevxClassificationCache"), false);
  await sandbox.handleMessage({ type: "JEVX_CLEAR_KEY" }, POPUP_SENDER);
  assert.equal(session.data.has("jevxTypesafeApiKey"), false);
  assert.equal(local.data.has("jevxTypesafeApiKeyEncrypted"), false); // ciphertext gone
  assert.equal(idbStub._stores.get("keys").size, 0); // encryption key material gone
  const s = await sandbox.handleMessage({ type: "JEVX_GET_SETTINGS" }, POPUP_SENDER);
  assert.equal(s.settings.hasApiKey, false);
  assert.equal(tabMessages.at(-1).message.hasApiKey, false); // tabs told the key is gone
});

function threadMsg(text, surface = "conversation") {
  return { type: "JEVX_CLASSIFY_THREAD", surface, tweetId: CONTEXT_ID, text, fingerprint: sandbox.fingerprintText(text) };
}

function classifyMsg(text = "Not convinced. The benchmarks were run on last year's hardware.") {
  return {
    type: "JEVX_CLASSIFY_REPLY",
    contextTweetId: CONTEXT_ID,
    contextText: CONTEXT_TEXT,
    contextFingerprint: sandbox.fingerprintText(CONTEXT_TEXT),
    matrixId: "product_launch",
    tweetId: "1234567890",
    text,
    fingerprint: sandbox.fingerprintText(text),
  };
}

console.log(`\n${passed} passed, ${process.exitCode ? "FAILURES" : "0 failures"}`);
