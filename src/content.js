/**
 * jevx: X content script.
 *
 * Owns: SPA route detection (status pages only), tweet discovery, the
 * MutationObserver/IntersectionObserver wiring, the bounded classification
 * queue, in-memory dedupe/cache, pill injection, and stale-response safety
 * checks.
 *
 * It never sees the TypeSafe API key. All classification goes through the
 * extension service worker via one-time messages, which answers with a
 * normalized result or a fixed error code.
 *
 * X is a single-page application: this script loads once on https://x.com/*
 * and activates/deactivates itself as the route changes, so the manifest does
 * not need a narrow match pattern (or the webNavigation permission).
 */

(() => {
  "use strict";

  if (window.__jevxLoaded) return;
  window.__jevxLoaded = true;

  /* ---------------------------------------------------------------- *
   * Constants
   * ---------------------------------------------------------------- */

  // Keep MODEL, CLASSIFIER_SCHEMA_VERSION, MAX_TEXT_CHARS and fingerprintText()
  // in sync with src/service-worker.js; together they form the shared cache
  // identity. Changing either side's values must happen on both sides.
  const MODEL = "jev-latest";
  const CLASSIFIER_SCHEMA_VERSION = 1;
  const MAX_TEXT_CHARS = 10000;

  const DEBUG = false;
  const ROUTE_CHECK_INTERVAL_MS = 500;
  const SCAN_DEBOUNCE_MS = 200;
  const STATUS_ROUTE_RE = /^\/[^/]+\/status\/(\d+)/;
  const MAX_CONCURRENCY = 4; // project-level choice; tune after observing latency/rate limits
  const INTERSECTION_ROOT_MARGIN = "800px 0px";
  const HALT_ERROR_CODES = new Set(["NOT_CONFIGURED", "DISABLED", "AUTH"]);
  const ACCEPTED_LABELS = new Set(["positive", "neutral", "negative"]);

  // Observed X frontend details, not an official X DOM contract. They are
  // centralized here so a frontend change only touches this block. Generated
  // class names (r-*, css-*) are deliberately avoided.
  const SELECTORS = {
    primaryColumn: '[data-testid="primaryColumn"]',
    sidebarColumn: '[data-testid="sidebarColumn"]',
    article: 'article[data-testid="tweet"]',
    tweetText: '[data-testid="tweetText"]',
    pill: '[data-jevx-pill="true"]',
  };

  const PILL_BASE_CLASS = "jevx-pill";
  const LOADING_CLASS = `${PILL_BASE_CLASS}--loading`;

  /* ---------------------------------------------------------------- *
   * State
   * ---------------------------------------------------------------- */

  let routeGeneration = 0;
  let activeStatusId = null;
  let halted = false;

  let mutationObserver = null;
  let mutationRoot = null;
  let intersectionObserver = null;
  let pendingArticles = new WeakMap(); // article -> {generation, tweetId, text, fingerprint, cacheKey}
  let scanScheduled = false;

  const queue = [];
  const queuedKeys = new Set();
  const inflightKeys = new Set();
  const memoryCache = new Map(); // cacheKey -> normalized result, for this document's lifetime

  /* ---------------------------------------------------------------- *
   * Utilities
   * ---------------------------------------------------------------- */

  function log(...args) {
    if (DEBUG) console.log("[jevx]", ...args);
  }

  function warnCode(code) {
    console.warn(`[jevx] TypeSafe error: ${code}`);
  }

  // Deterministic non-cryptographic FNV-1a hash. Cache fingerprint, not a
  // security primitive. Must stay identical to src/service-worker.js.
  function fingerprintText(text) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  }

  function cacheKeyFor(tweetId, text) {
    return `${CLASSIFIER_SCHEMA_VERSION}:${MODEL}:${tweetId}:${fingerprintText(text)}`;
  }

  function capitalize(label) {
    return label.charAt(0).toUpperCase() + label.slice(1);
  }

  /* ---------------------------------------------------------------- *
   * Route detection (SPA-aware)
   * ---------------------------------------------------------------- */

  function parseStatusId(pathname) {
    const match = STATUS_ROUTE_RE.exec(pathname);
    return match ? match[1] : null;
  }

  function checkRoute() {
    const statusId = parseStatusId(location.pathname);
    if (statusId) {
      if (statusId !== activeStatusId) activate(statusId);
      else ensureObservation(); // re-attach if X replaced the observed subtree
    } else if (activeStatusId !== null) {
      deactivate();
    }
  }

  function activate(statusId) {
    routeGeneration += 1;
    activeStatusId = statusId;
    halted = false;
    resetQueue();
    log("status route activated:", statusId);
    ensureObservation();
    scheduleScan();
  }

  function deactivate() {
    routeGeneration += 1; // invalidates any in-flight results
    activeStatusId = null;
    halted = false;
    resetQueue();
    if (mutationObserver) {
      mutationObserver.disconnect();
      mutationObserver = null;
      mutationRoot = null;
    }
    if (intersectionObserver) {
      intersectionObserver.disconnect();
      intersectionObserver = null;
    }
    pendingArticles = new WeakMap();
    log("status route deactivated");
  }

  function resetQueue() {
    queue.length = 0;
    queuedKeys.clear();
    // In-flight requests are allowed to finish; their results are dropped by
    // the generation check in applyResult().
  }

  /* ---------------------------------------------------------------- *
   * Observers
   * ---------------------------------------------------------------- */

  function ensureObservation() {
    if (!intersectionObserver) {
      intersectionObserver = new IntersectionObserver(onIntersect, {
        rootMargin: INTERSECTION_ROOT_MARGIN,
      });
    }
    const root = document.querySelector(SELECTORS.primaryColumn) || document.body;
    if (mutationObserver && mutationRoot === root && root.isConnected) return;
    if (mutationObserver) mutationObserver.disconnect();
    mutationRoot = root;
    mutationObserver = new MutationObserver(() => scheduleScan());
    mutationObserver.observe(root, { childList: true, subtree: true });
  }

  function scheduleScan() {
    if (activeStatusId === null || scanScheduled) return;
    scanScheduled = true;
    setTimeout(() => {
      scanScheduled = false;
      scanArticles();
    }, SCAN_DEBOUNCE_MS);
  }

  function scanArticles() {
    if (activeStatusId === null) return;
    const root = document.querySelector(SELECTORS.primaryColumn);
    if (!root) return;
    for (const article of root.querySelectorAll(SELECTORS.article)) {
      processArticle(article, routeGeneration);
    }
  }

  function onIntersect(entries) {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const article = entry.target;
      intersectionObserver.unobserve(article);
      const task = pendingArticles.get(article);
      pendingArticles.delete(article);
      if (!task) continue;
      if (activeStatusId === null || task.generation !== routeGeneration) continue;
      if (!article.isConnected) continue;
      if (extractTweetId(article) !== task.tweetId) continue; // node was recycled
      queueTweet(article, task, false);
    }
  }

  /* ---------------------------------------------------------------- *
   * Tweet discovery
   * ---------------------------------------------------------------- */

  function extractTweetId(article) {
    const time = article.querySelector("time");
    const primary = time ? time.closest("a") : null;
    const candidates = primary
      ? [primary, ...article.querySelectorAll('a[href*="/status/"]')]
      : article.querySelectorAll('a[href*="/status/"]');
    for (const anchor of candidates) {
      const match = /\/status\/(\d+)/.exec(anchor.getAttribute("href") || "");
      if (match) return match[1];
    }
    return null;
  }

  function extractTweetText(article) {
    // First tweetText descendant is the tweet's own text; quoted tweets nest
    // their own tweetText deeper and later in document order, so they are
    // naturally excluded. Never concatenate.
    const textEl = article.querySelector(SELECTORS.tweetText);
    if (!textEl) return null;
    const text = (textEl.innerText || "").trim();
    if (!text) return null;
    return text.slice(0, MAX_TEXT_CHARS);
  }

  function processArticle(article, generation) {
    if (article.closest(SELECTORS.sidebarColumn)) return;
    const tweetId = extractTweetId(article);
    if (!tweetId) return;

    const known = article.dataset.jevxTweetId;
    if (known === tweetId) {
      recoverPillIfMissing(article, tweetId);
      return;
    }
    if (known !== undefined) {
      // X recycled this node for a different tweet: drop the old pill and
      // element-specific state, then process the new identity normally.
      removePill(article);
    }

    const textEl = article.querySelector(SELECTORS.tweetText);
    if (!textEl) {
      // No text element at all (media-only or non-textual): skip in v1.
      article.dataset.jevxTweetId = tweetId;
      return;
    }
    const text = extractTweetText(article);
    if (!text) return; // text not rendered yet; a later scan retries

    article.dataset.jevxTweetId = tweetId;
    const fingerprint = fingerprintText(text);
    const cacheKey = cacheKeyFor(tweetId, text);

    const memo = memoryCache.get(cacheKey);
    if (memo) {
      ensureResultPill(article, memo);
      return;
    }

    if (tweetId === activeStatusId) {
      // The original tweet is queued immediately, regardless of intersection.
      queueTweet(article, { generation, tweetId, text, fingerprint, cacheKey }, true);
    } else {
      registerForIntersection(article, { generation, tweetId, text, fingerprint, cacheKey });
    }
  }

  // X re-renders can drop an injected pill while keeping the article node.
  // Re-inject from the in-memory cache (or restore a loading pill for work
  // still queued/in-flight) without triggering a second classification.
  function recoverPillIfMissing(article, tweetId) {
    if (article.querySelector(SELECTORS.pill)) return;
    const text = extractTweetText(article);
    if (!text) return;
    const cacheKey = cacheKeyFor(tweetId, text);
    const memo = memoryCache.get(cacheKey);
    if (memo) {
      ensureResultPill(article, memo);
      return;
    }
    if (queuedKeys.has(cacheKey) || inflightKeys.has(cacheKey)) {
      ensureLoadingPill(article);
    }
  }

  function registerForIntersection(article, task) {
    if (!intersectionObserver) return;
    pendingArticles.set(article, task);
    intersectionObserver.observe(article);
  }

  /* ---------------------------------------------------------------- *
   * Queue + concurrency
   * ---------------------------------------------------------------- */

  function queueTweet(article, task, priority) {
    if (halted) return;
    if (queuedKeys.has(task.cacheKey) || inflightKeys.has(task.cacheKey)) return;
    queuedKeys.add(task.cacheKey);
    if (priority) queue.unshift({ ...task, article });
    else queue.push({ ...task, article });
    ensureLoadingPill(article);
    log("queued tweet:", task.tweetId);
    pump();
  }

  function pump() {
    while (!halted && inflightKeys.size < MAX_CONCURRENCY && queue.length > 0) {
      const task = queue.shift();
      queuedKeys.delete(task.cacheKey);
      if (task.generation !== routeGeneration) continue; // stale from a previous route
      if (!task.article.isConnected) continue;
      dispatchTask(task);
    }
  }

  function dispatchTask(task) {
    inflightKeys.add(task.cacheKey);
    let settled = false;
    const finish = (response) => {
      if (settled) return;
      settled = true;
      inflightKeys.delete(task.cacheKey);
      handleResponse(task, response);
      pump();
    };
    if (!chrome.runtime || !chrome.runtime.id) {
      finish(null); // extension context was invalidated (e.g. reloaded)
      return;
    }
    try {
      chrome.runtime.sendMessage(
        {
          type: "JEVX_CLASSIFY_SENTIMENT",
          tweetId: task.tweetId,
          text: task.text,
          fingerprint: task.fingerprint,
        },
        (response) => {
          if (chrome.runtime.lastError) return finish(null);
          finish(response);
        }
      );
    } catch (e) {
      finish(null);
    }
  }

  function handleResponse(task, response) {
    if (!response || !response.ok) {
      const code = (response && response.error && response.error.code) || "NETWORK";
      warnCode(code);
      handleFailure(task, code);
      return;
    }
    const result = response.result;
    if (!isValidResult(result)) {
      warnCode("INVALID_RESPONSE");
      handleFailure(task, "INVALID_RESPONSE");
      return;
    }
    memoryCache.set(task.cacheKey, result);
    log("classification complete:", result.label, `${result.latencyMs}ms`);
    applyResult(task, result);
  }

  function isValidResult(result) {
    return (
      !!result &&
      ACCEPTED_LABELS.has(result.label) &&
      typeof result.probability === "number" &&
      Number.isFinite(result.probability) &&
      result.probability >= 0 &&
      result.probability <= 1
    );
  }

  function handleFailure(task, code) {
    // Fail quietly: remove this tweet's ANALYZING pill, no error banner.
    removeLoadingPill(task.article);
    if (HALT_ERROR_CODES.has(code)) haltQueue();
  }

  function haltQueue() {
    halted = true;
    for (const task of queue) removeLoadingPill(task.article);
    queue.length = 0;
    queuedKeys.clear();
  }

  // Final stale-state gate before touching the DOM: the route generation must
  // still match, the article must still be connected, and the article must
  // still represent the same tweet (X virtualization can recycle nodes).
  function applyResult(task, result) {
    if (task.generation !== routeGeneration) return;
    if (!task.article.isConnected) return;
    if (extractTweetId(task.article) !== task.tweetId) return;
    ensureResultPill(task.article, result);
  }

  /* ---------------------------------------------------------------- *
   * Pill injection (idempotent, textContent only, never innerHTML)
   * ---------------------------------------------------------------- */

  function ensurePillElement(article) {
    let pill = article.querySelector(SELECTORS.pill);
    if (!pill) {
      const textEl = article.querySelector(SELECTORS.tweetText);
      if (!textEl) return null;
      pill = document.createElement("span");
      pill.dataset.jevxPill = "true";
      pill.setAttribute("dir", "ltr"); // tweet text may be RTL; the pill is not
      textEl.insertAdjacentElement("afterend", pill);
    }
    return pill;
  }

  function ensureLoadingPill(article) {
    const pill = ensurePillElement(article);
    if (!pill) return;
    pill.className = `${PILL_BASE_CLASS} ${LOADING_CLASS}`;
    pill.textContent = "JEV · ANALYZING…";
    pill.title = "Waiting for a TypeSafe Jev classification…";
  }

  function ensureResultPill(article, result) {
    const pill = ensurePillElement(article);
    if (!pill) return;
    pill.className = `${PILL_BASE_CLASS} ${PILL_BASE_CLASS}--${result.label}`;
    // The visible percent is the chosen option's probability, NOT TypeSafe's
    // separate `confidence` statistic.
    pill.textContent = `JEV · ${result.label.toUpperCase()} ${Math.round(result.probability * 100)}%`;
    pill.title = buildTooltip(result);
  }

  function buildTooltip(result) {
    const probabilities = result.probabilities || {};
    const pct = (label) => `${capitalize(label)} ${Math.round((probabilities[label] || 0) * 100)}%`;
    const confidence = Number.isFinite(result.confidence) ? result.confidence.toFixed(2) : "n/a";
    return [
      `${pct("positive")} · ${pct("neutral")} · ${pct("negative")}`,
      `Jev confidence: ${confidence} · ${Math.round(result.latencyMs || 0)} ms · ${result.cached ? "cached" : "live"}`,
      `Model: ${result.model || MODEL}`,
    ].join("\n");
  }

  function removeLoadingPill(article) {
    const pill = article && article.querySelector(SELECTORS.pill);
    if (pill && pill.classList.contains(LOADING_CLASS)) pill.remove();
  }

  function removePill(article) {
    const pill = article.querySelector(SELECTORS.pill);
    if (pill) pill.remove();
  }

  /* ---------------------------------------------------------------- *
   * Boot
   * ---------------------------------------------------------------- */

  checkRoute();
  setInterval(checkRoute, ROUTE_CHECK_INTERVAL_MS);
})();
