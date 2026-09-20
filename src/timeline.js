/**
 * jevx: X timeline content script.
 *
 * Owns: category and AI-slop pills on posts outside tweet-detail pages —
 * Home, Following, search results, profiles, lists, bookmarks. Each textual
 * post on or near the screen is classified once, with the exact
 * JEVX_CLASSIFY_THREAD request conversation mode uses for an original post,
 * and its subcategory becomes one small pill in the post's header,
 * immediately left of the Grok button, with the 0-10 AI-slop score right of
 * it. No loading state, no filters, no reply analysis; a post Jev is unsure
 * about gets no pill at all.
 *
 * Because the request and its cache key are identical to conversation
 * mode's, a post classified here is served from the same caches when its
 * detail page is opened, so that thread's reply matrix is already known —
 * no second request. Quote posts are the one exception: this script adds
 * the quoted post's text as context, which is a different version of the
 * text and therefore a separate cache entry.
 *
 * Shares the page with src/content.js (both run in this extension's single
 * isolated world): that script activates on /status/ routes only, this one
 * activates everywhere else, and each deactivates on the other's routes.
 * It never sees the TypeSafe API key; classification goes through the
 * extension service worker via one-time messages.
 *
 * X is a single-page application: this script loads once on
 * https://x.com/* and activates/deactivates itself as the route changes.
 * X's DOM details are observed frontend behavior, not a contract; they are
 * centralized in SELECTORS below and generated class names are avoided.
 */

(() => {
  "use strict";

  if (window.__jevxTimelineLoaded) return;
  window.__jevxTimelineLoaded = true;

  /* ---------------------------------------------------------------- *
   * Constants
   * ---------------------------------------------------------------- */

  // Keep MODEL, CLASSIFIER_SCHEMA_VERSION, MAX_TEXT_CHARS, fingerprintText()
  // and threadCacheKeyFor() in sync with src/service-worker.js; together
  // they form the shared cache identity with conversation mode. Changing
  // either side must change both.
  const MODEL = "jev-latest";
  const CLASSIFIER_SCHEMA_VERSION = 5;
  const MAX_TEXT_CHARS = 10000;

  // Diagnostics, off by default: run localStorage.setItem("jevxDebug", "1")
  // in X's console and reload to log activity and mark each post that gets
  // no pill with the reason, as data-jevx-skip on its article.
  const DEBUG = (() => {
    try {
      return localStorage.getItem("jevxDebug") === "1";
    } catch (e) {
      return false;
    }
  })();
  const ROUTE_CHECK_INTERVAL_MS = 500;
  const SCAN_DEBOUNCE_MS = 200;
  const STATUS_ROUTE_RE = /^\/[^/]+\/status\/(\d+)/;
  const MAX_CONCURRENCY = 4; // same budget as conversation mode; the two are never active at once
  const INTERSECTION_ROOT_MARGIN = "800px 0px";
  const HALT_ERROR_CODES = new Set(["NOT_CONFIGURED", "DISABLED", "AUTH"]);
  const RETRYABLE_ERROR_CODES = new Set(["NETWORK", "TIMEOUT", "RATE_LIMIT", "OVERLOADED", "API"]);
  // Page-level retries for transient failures, after the service worker's own
  // per-request retries are exhausted. One entry per retry.
  const PAGE_RETRY_DELAYS_MS = [15000, 60000];
  // How long to wait before asking again if the page settings request fails.
  const SETTINGS_RETRY_MS = 5000;

  // Below this certainty (the smaller of the chosen subcategory's probability
  // and Jev's confidence statistic) a post gets no pill: absence is less
  // distracting than an uncertain label. Display-only, like the certainty
  // tiers in src/content.js; changing it never sends requests.
  const TIMELINE_MIN_CERTAINTY = 0.6;
  // Text shorter than this is skipped without a request ("lol", "🔥"): too
  // little to classify and not worth a paid call. Posts with media are
  // exempt: Jev can't see the image or video, so their text, however short,
  // is all there is to classify (and an unsure answer shows no pill).
  const TIMELINE_MIN_TEXT_CHARS = 12;
  // This tab's in-memory result cap; anything trimmed is still served by the
  // service worker's persistent cache, with no API call.
  const MEMORY_CACHE_MAX = 500;

  // AI-slop score. Jev answers an ordered rubric (0 = slop, SLOP_TOP_LEVEL =
  // clearly human and substantive) inside the thread request that is sent
  // anyway; everything below is display-only, like the certainty tiers, and
  // never changes a request or a cache key. Keep the level ids in step with
  // SLOP_LEVELS in src/service-worker.js (changing the rubric there is a
  // schema bump; changing only the bands here is not), and keep this block
  // identical to the one in src/content.js.
  const SLOP_LEVELS = ["slop", "formulaic", "generic", "mixed", "human", "distinctive"];
  const SLOP_TOP_LEVEL = SLOP_LEVELS.length - 1;
  const SLOP_LEVEL_NAMES = {
    slop: "AI slop or bot output",
    formulaic: "Machine-flavoured",
    generic: "Generic, low effort",
    mixed: "Mixed",
    human: "Human and specific",
    distinctive: "Clearly human and substantive",
  };
  // Bands on the rounded 0-10 score: 0-4 reads as slop, 5-6 in between,
  // 7-10 reads as genuine human writing.
  const SLOP_BANDS = [
    [7, "high"],
    [5, "mid"],
    [0, "low"],
  ];
  // A flat rubric distribution means Jev has no opinion: show no score at
  // all rather than a number that means nothing.
  const SLOP_MIN_CONFIDENCE = 0.45;

  const TAXONOMY = globalThis.JEVX_TAXONOMY;

  // Observed X frontend details, not an official X DOM contract (the same
  // block as in src/content.js, plus the timeline's anchors). Generated
  // class names (r-*, css-*) are deliberately avoided.
  const SELECTORS = {
    primaryColumn: '[data-testid="primaryColumn"]',
    sidebarColumn: '[data-testid="sidebarColumn"]',
    article: 'article[data-testid="tweet"]',
    tweetText: '[data-testid="tweetText"]',
    // The quoted post inside a quote post: the test id where X sets one,
    // otherwise a nested clickable card (div, role=link) holding an author
    // name or post text of its own.
    quoteTweet: '[data-testid="quoteTweet"]',
    quoteCard: 'div[role="link"]',
    userName: '[data-testid="User-Name"]',
    // Images, videos/GIFs and link cards: text alongside them is sent even
    // when short (see TIMELINE_MIN_TEXT_CHARS).
    media: '[data-testid="tweetPhoto"], [data-testid="videoPlayer"], [data-testid="videoComponent"], [data-testid="card.wrapper"]',
    // A post's own timestamp links to its status page. Promoted posts show
    // an "Ad" label instead, so they have none. placementTracking can wrap a
    // promoted post, but X also puts it around video and GIF players inside
    // ordinary posts, so it only marks an ad when it
    // encloses the whole article.
    ownTimestamp: 'a[href*="/status/"] time',
    promotedMarker: '[data-testid="placementTracking"]',
    // The header controls the pill anchors to. Grok is matched by accessible
    // name: X localizes labels but keeps the product name. The "More" (…)
    // button's action group is the structural fallback.
    grokButton: 'button[aria-label*="grok" i], [role="button"][aria-label*="grok" i]',
    caret: '[data-testid="caret"]',
    // The category pill, the AI-slop pill right of it, and both at once.
    pill: '[data-jevx-timeline="true"]',
    slopPill: '[data-jevx-timeline="slop"]',
    anyPill: "[data-jevx-timeline]",
  };

  const PILL_BASE_CLASS = "jevx-pill";

  /* ---------------------------------------------------------------- *
   * State
   *
   * Per-article state tracks identity (tweet id) and the exact text sent,
   * keyed by the same thread cache key the service worker uses, so results
   * belong to a version of a post, not to the DOM node X happens to render
   * it in. Every scan reconciles each article against that state, so
   * re-renders, recycled nodes and late or edited text all converge.
   *
   * memoryCache and failures survive route changes for the document's
   * lifetime: going Home → search → Home must not re-ask Jev.
   * ---------------------------------------------------------------- */

  let timelineActive = false;
  let halted = false;
  // The popup's "timelines" switch: null until the service worker answers,
  // so nothing is sent or rendered while it is unknown or off.
  let modeEnabled = null;
  let settingsLoading = false;
  let settingsRetryAt = 0;
  let slopEnabled = true; // the popup's "AI slop score" switch (display only)
  let cacheEpoch = 0; // bumped when the user clears cached classifications

  let mutationObserver = null;
  let mutationRoot = null;
  let intersectionObserver = null;
  let articleStates = new WeakMap(); // article -> {tweetId, text, cacheKey}
  let observedArticles = new Set(); // articles waiting to become near-visible
  let scanScheduled = false;

  const queue = [];
  const queuedKeys = new Set();
  const inflightKeys = new Set();
  const memoryCache = new Map(); // cacheKey -> normalized thread result
  const failures = new Map(); // cacheKey -> {code, count, retryAt}

  /* ---------------------------------------------------------------- *
   * Utilities
   * ---------------------------------------------------------------- */

  function log(...args) {
    if (DEBUG) console.log("[jevx timeline]", ...args);
  }

  function warnCode(code) {
    console.warn(`[jevx timeline] TypeSafe error: ${code}`);
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

  // The original post's own classification, one per version of its text.
  // Must stay identical to src/service-worker.js.
  function threadCacheKeyFor(tweetId, text) {
    return `thread:${CLASSIFIER_SCHEMA_VERSION}:${MODEL}:${tweetId}:${fingerprintText(text)}`;
  }

  const percent = (probability) => Math.round(probability * 100);

  // The 0-10 score the pill shows, its color band and the rubric level Jev
  // landed on. Identical to the helper in src/content.js.
  function slopDisplay(slop) {
    const value = Math.round((slop.score / SLOP_TOP_LEVEL) * 10);
    const band = SLOP_BANDS.find(([min]) => value >= min)[1];
    return { value, band, name: SLOP_LEVEL_NAMES[slop.label] || slop.label };
  }

  function slopTitle(slop, display, subject) {
    return [
      `AI slop score ${display.value} of 10 - ${display.name}`,
      `10 = ${subject} reads as clearly human and substantive; 0 = AI slop or bot output.`,
      `Jev's rubric level ${slop.score.toFixed(1)} of ${SLOP_TOP_LEVEL}, certainty ${slop.confidence.toFixed(2)} (the model's own statistic, not measured accuracy).`,
    ].join("\n");
  }

  // A small speedometer, drawn inline so it takes the pill's color in both
  // themes: a half-circle dial with the needle at the good end.
  function slopIcon() {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "jevx-slop-icon");
    svg.setAttribute("viewBox", "0 0 12 12");
    svg.setAttribute("aria-hidden", "true");
    const arc = document.createElementNS("http://www.w3.org/2000/svg", "path");
    arc.setAttribute("d", "M1.5 9A4.5 4.5 0 0 1 10.5 9");
    const needle = document.createElementNS("http://www.w3.org/2000/svg", "path");
    needle.setAttribute("d", "M6 9 8.9 6.1");
    svg.append(arc, needle);
    return svg;
  }

  // One message to the service worker; `done` gets its response, or null if
  // the extension context is gone or the message failed.
  function sendToWorker(message, done) {
    if (!chrome.runtime || !chrome.runtime.id) {
      done(null); // extension context was invalidated (e.g. reloaded)
      return;
    }
    try {
      chrome.runtime.sendMessage(message, (response) => done(chrome.runtime.lastError ? null : response));
    } catch (e) {
      done(null);
    }
  }

  // X has its own light / dim / dark themes, independent of the OS setting;
  // conversation mode only syncs this on status pages, so the timeline does
  // its own. Same detection as src/content.js.
  function syncTheme() {
    const match = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(getComputedStyle(document.body).backgroundColor);
    const dark = !!match && 0.2126 * match[1] + 0.7152 * match[2] + 0.0722 * match[3] < 128;
    const theme = dark ? "dark" : "light";
    if (document.documentElement.getAttribute("data-jevx-theme") !== theme) {
      document.documentElement.setAttribute("data-jevx-theme", theme);
    }
  }

  /* ---------------------------------------------------------------- *
   * Route detection (SPA-aware)
   * ---------------------------------------------------------------- */

  function checkRoute() {
    if (modeEnabled !== true || STATUS_ROUTE_RE.test(location.pathname)) {
      if (modeEnabled === null) loadPageSettings();
      // Switched off, or a status page (conversation mode owns those).
      if (timelineActive) deactivate();
      return;
    }
    if (!timelineActive) activate();
    else ensureObservation(); // re-attach if X replaced the observed subtree
  }

  function activate() {
    timelineActive = true;
    halted = false;
    resetQueue();
    log("timeline activated:", location.pathname);
    ensureObservation();
    scheduleScan(0);
  }

  function deactivate() {
    timelineActive = false;
    halted = false;
    resetQueue();
    if (mutationObserver) {
      mutationObserver.disconnect();
      mutationObserver = null;
      mutationRoot = null;
    }
    if (intersectionObserver) intersectionObserver.disconnect();
    observedArticles.clear();
    articleStates = new WeakMap();
    // X may reuse nodes across routes: strip everything this script added.
    for (const pill of document.querySelectorAll(SELECTORS.anyPill)) pill.remove();
    if (DEBUG) for (const el of document.querySelectorAll("[data-jevx-skip]")) el.removeAttribute("data-jevx-skip");
    log("timeline deactivated");
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
    // characterData: post text can be filled in or edited in place.
    mutationObserver = new MutationObserver(() => scheduleScan());
    mutationObserver.observe(root, { childList: true, subtree: true, characterData: true });
  }

  function scheduleScan(delayMs = SCAN_DEBOUNCE_MS) {
    if (!timelineActive || scanScheduled) return;
    scanScheduled = true;
    setTimeout(() => {
      scanScheduled = false;
      scanArticles();
    }, delayMs);
  }

  function scanArticles() {
    if (!timelineActive) return;
    const root = document.querySelector(SELECTORS.primaryColumn);
    if (!root) return;
    syncTheme();
    sweepObservations();
    for (const article of root.querySelectorAll(SELECTORS.article)) {
      if (article.closest(SELECTORS.sidebarColumn)) continue;
      processArticle(article);
    }
  }

  // IntersectionObserver holds strong references to its targets, and X
  // recycles timeline nodes aggressively while scrolling; observations of
  // nodes that have left the DOM are dropped here instead of accumulating.
  function sweepObservations() {
    for (const article of observedArticles) {
      if (article.isConnected) continue;
      observedArticles.delete(article);
      if (intersectionObserver) intersectionObserver.unobserve(article);
    }
  }

  function onIntersect(entries) {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const article = entry.target;
      intersectionObserver.unobserve(article);
      observedArticles.delete(article);
      const state = articleStates.get(article);
      if (!state || !timelineActive || !article.isConnected) continue;
      if (extractTweetId(article) !== state.tweetId) continue; // node was recycled; the next scan handles it
      queueTweet(article, state);
    }
  }

  /* ---------------------------------------------------------------- *
   * Extraction
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

  // Not cached: a regular post rendered before its timestamp would briefly
  // look promoted, and the next scan corrects it. A promotedMarker inside the
  // article is a media player, not an ad (see SELECTORS).
  function isPromoted(article) {
    return !!article.closest(SELECTORS.promotedMarker) || !article.querySelector(SELECTORS.ownTimestamp);
  }

  function quoteCardOf(article) {
    const tagged = article.querySelector(SELECTORS.quoteTweet);
    if (tagged) return tagged;
    for (const card of article.querySelectorAll(SELECTORS.quoteCard)) {
      if (card.querySelector(`${SELECTORS.userName}, ${SELECTORS.tweetText}`)) return card;
    }
    return null;
  }

  // innerText trimmed, cut to MAX_TEXT_CHARS and trimmed again: the worker
  // fingerprints the trimmed text, so a cut landing on whitespace would
  // otherwise be rejected. Same normalization as src/content.js.
  const clip = (text) => text.trim().slice(0, MAX_TEXT_CHARS).trim();

  // The post's own text, with the quoted post's text as context when there
  // is one: the commentary alone ("This is exactly the problem") is too
  // little to classify. The combined text is a different version than
  // conversation mode extracts (the commentary alone), so quote posts have
  // separate cache entries in the two modes; a quote with no commentary of
  // its own uses the quoted text alone, which does match conversation
  // mode's extraction (its first tweetText is the quoted one). For plain
  // posts the extraction is byte-identical to conversation mode's, which is
  // what makes the shared cache work — so no extra normalization here.
  function extractTimelineText(article) {
    const quote = quoteCardOf(article);
    let own = null;
    let quoted = null;
    for (const el of article.querySelectorAll(SELECTORS.tweetText)) {
      const text = (el.innerText || "").trim();
      if (!text) continue;
      if (quote && quote.contains(el)) {
        if (quoted === null) quoted = text;
      } else if (own === null) {
        own = text;
      }
    }
    if (own === null) return quoted ? clip(quoted) : null;
    if (quoted === null) return clip(own);
    return clip(`Author commentary:\n${own}\n\nQuoted post:\n${quoted}`);
  }

  /* ---------------------------------------------------------------- *
   * Reconciliation
   * ---------------------------------------------------------------- */

  function forgetArticle(article) {
    articleStates.delete(article);
    if (observedArticles.has(article)) {
      observedArticles.delete(article);
      if (intersectionObserver) intersectionObserver.unobserve(article);
    }
    removePills(article);
  }

  // Debug only: why this post has no pill (null once it has one).
  function markSkip(article, reason) {
    if (!DEBUG) return;
    if (reason === null) article.removeAttribute("data-jevx-skip");
    else if (article.getAttribute("data-jevx-skip") !== reason) article.setAttribute("data-jevx-skip", reason);
  }

  function processArticle(article) {
    const tweetId = extractTweetId(article);
    let state = articleStates.get(article);
    if (state && state.tweetId !== tweetId) {
      forgetArticle(article); // recycled node now showing another post
      state = null;
    }
    if (!tweetId || isPromoted(article)) {
      forgetArticle(article); // ads are never classified
      markSkip(article, isPromoted(article) ? "promoted" : "no-tweet-id");
      return;
    }
    const text = extractTimelineText(article);
    const minChars = article.querySelector(SELECTORS.media) ? 1 : TIMELINE_MIN_TEXT_CHARS;
    if (!text || text.length < minChars) {
      forgetArticle(article); // media-only or contextless; a later scan picks up text that appears
      markSkip(article, text ? "short-text" : "no-text");
      return;
    }
    if (state && state.text !== text) {
      forgetArticle(article); // edited post (or its quote): a new version to classify
      state = null;
    }
    if (!state) {
      state = { tweetId, text, cacheKey: threadCacheKeyFor(tweetId, text) };
      articleStates.set(article, state);
    }
    reconcile(article, state);
  }

  // Brings one article's pill in line with the processing state of its
  // cache key, scheduling work only when nothing is done, pending or
  // blocked. The timeline shows no loading state: it looks untouched until
  // a pill fades in.
  function reconcile(article, state) {
    const result = memoryCache.get(state.cacheKey);
    if (result) {
      renderPills(article, state, result);
      return;
    }
    removePills(article);
    if (DEBUG) {
      const failure = failures.get(state.cacheKey);
      markSkip(article, halted ? "halted" : failure ? `failed:${failure.code}` : "pending");
    }
    if (queuedKeys.has(state.cacheKey) || inflightKeys.has(state.cacheKey)) return;
    if (halted || observedArticles.has(article)) return;
    if (!retryAllowed(failures.get(state.cacheKey))) return;
    if (!intersectionObserver) return;
    observedArticles.add(article);
    intersectionObserver.observe(article);
  }

  /* ---------------------------------------------------------------- *
   * Queue + concurrency
   * ---------------------------------------------------------------- */

  function queueTweet(article, state) {
    if (halted) return; // resume() rescans and re-registers
    if (queuedKeys.has(state.cacheKey) || inflightKeys.has(state.cacheKey)) return;
    queuedKeys.add(state.cacheKey);
    queue.push({ article, tweetId: state.tweetId, text: state.text, cacheKey: state.cacheKey });
    log("queued post:", state.tweetId);
    pump();
  }

  function pump() {
    while (!halted && inflightKeys.size < MAX_CONCURRENCY && queue.length > 0) {
      const task = queue.shift();
      queuedKeys.delete(task.cacheKey);
      const state = articleStates.get(task.article);
      if (!task.article.isConnected || !state || state.cacheKey !== task.cacheKey) continue; // stale
      dispatchTask(task);
    }
  }

  function dispatchTask(task) {
    inflightKeys.add(task.cacheKey);
    const epoch = cacheEpoch;
    let settled = false;
    const message = {
      type: "JEVX_CLASSIFY_THREAD",
      surface: "timeline",
      tweetId: task.tweetId,
      text: task.text,
      fingerprint: fingerprintText(task.text),
    };
    sendToWorker(message, (response) => {
      if (settled) return;
      settled = true;
      inflightKeys.delete(task.cacheKey);
      // A result requested before "Clear cached classifications" is dropped;
      // reconciliation re-requests it if the post is still on screen.
      if (epoch === cacheEpoch) handleResponse(task, response);
      scanArticles(); // renders this result on every node showing the post
      pump();
    });
  }

  function handleResponse(task, response) {
    if (!response || !response.ok) {
      const code = (response && response.error && response.error.code) || "NETWORK";
      warnCode(code);
      handleFailure(task.cacheKey, code);
      return;
    }
    const result = response.result;
    if (!isValidTimelineResult(result)) {
      warnCode("INVALID_RESPONSE");
      handleFailure(task.cacheKey, "INVALID_RESPONSE");
      return;
    }
    failures.delete(task.cacheKey);
    rememberResult(task.cacheKey, result);
    log("post classified:", result.subcategory.label, result.cached ? "(cached)" : "");
  }

  function rememberResult(cacheKey, result) {
    memoryCache.set(cacheKey, result);
    if (memoryCache.size > MEMORY_CACHE_MAX) {
      for (const oldest of memoryCache.keys()) {
        memoryCache.delete(oldest);
        if (memoryCache.size <= MEMORY_CACHE_MAX) break;
      }
    }
  }

  /* ---------------------------------------------------------------- *
   * Result validation
   * ---------------------------------------------------------------- */

  const isUnitNumber = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;

  function isValidChoice(choice, labels) {
    return (
      !!choice &&
      labels.includes(choice.label) &&
      isUnitNumber(choice.probability) &&
      isUnitNumber(choice.confidence) &&
      !!choice.probabilities &&
      labels.every((label) => isUnitNumber(choice.probabilities[label]))
    );
  }

  function isValidScore(score, levels) {
    return (
      !!score &&
      levels.includes(score.label) &&
      typeof score.score === "number" &&
      Number.isFinite(score.score) &&
      score.score >= 0 &&
      score.score <= levels.length - 1 &&
      isUnitNumber(score.confidence)
    );
  }

  // The timeline renders the subcategory (with its parent category in the
  // tooltip) and the AI-slop score, so that is what is validated here;
  // conversation mode additionally checks the answers it uses.
  function isValidTimelineResult(result) {
    return (
      !!result &&
      typeof result.fallback === "boolean" &&
      !!TAXONOMY.subcategory(result.matrixId) &&
      !!TAXONOMY.category(result.categoryId) &&
      isValidChoice(result.subcategory, TAXONOMY.subcategories.map((s) => s.id)) &&
      isValidScore(result.slop, SLOP_LEVELS)
    );
  }

  /* ---------------------------------------------------------------- *
   * DOM writes (idempotent, textContent only, never innerHTML)
   *
   * Scans reconcile every article, so a no-op write must not touch the DOM:
   * it would fire the MutationObserver and schedule another scan, forever.
   * ---------------------------------------------------------------- */

  // Where the pill goes: immediately left of the Grok button, found by its
  // accessible name; otherwise at the start of the header's action group
  // (found by climbing from the More button until an ancestor holds more
  // than one button — the group X renders as [Grok, More]); otherwise just
  // before More itself. If none of X's header controls are recognized, no
  // pill is rendered: a misplaced pill is worse than none.
  function pillAnchor(article) {
    const grok = article.querySelector(SELECTORS.grokButton);
    if (grok) return grok;
    const caret = article.querySelector(SELECTORS.caret);
    if (!caret) return null;
    let node = caret;
    for (let depth = 0; depth < 4 && node.parentElement && node.parentElement !== article; depth += 1) {
      const parent = node.parentElement;
      if (parent.querySelectorAll('button, [role="button"]').length > 1) {
        return parent.firstElementChild;
      }
      node = parent;
    }
    return caret;
  }

  // Up to two pills per post, the AI-slop score always rightmost: category
  // first, then the score immediately left of the Grok button. Each is
  // inserted relative to the other when it is already there, so whichever
  // is rebuilt first keeps the order.
  function renderPills(article, state, result) {
    const placed = renderCategoryPill(article, state, result);
    const slopPlaced = renderSlopPill(article, state, result);
    if (!placed && !slopPlaced) return;
    markSkip(article, null);
  }

  // One neutral pill per post: the subcategory's name. The parent category,
  // the probability (not measured accuracy) and the cache state sit in the
  // title. Below TIMELINE_MIN_CERTAINTY nothing is rendered at all.
  // Returns whether the post now has a category pill.
  function renderCategoryPill(article, state, result) {
    const choice = result.subcategory;
    if (Math.min(choice.probability, choice.confidence) < TIMELINE_MIN_CERTAINTY) {
      removeCategoryPill(article); // uncertain: no pill rather than a guessed label
      markSkip(article, `uncertain:${choice.label}`);
      return false;
    }
    const subcategory = TAXONOMY.subcategory(choice.label);
    const category = TAXONOMY.category(subcategory.category);
    const signature = `${state.cacheKey}:${subcategory.id}`;
    let pill = article.querySelector(SELECTORS.pill);
    if (pill && (!pill.isConnected || pill.dataset.jevxSig !== signature)) {
      pill.remove();
      pill = null;
    }
    if (pill) return true;
    // Left of the slop pill when that one is already placed, otherwise at
    // the header anchor.
    const slop = article.querySelector(SELECTORS.slopPill);
    const anchor = slop || pillAnchor(article);
    if (!anchor) {
      markSkip(article, "no-anchor");
      return false;
    }
    pill = document.createElement("span");
    pill.dataset.jevxTimeline = "true";
    pill.dataset.jevxSig = signature;
    pill.setAttribute("dir", "ltr"); // post text may be RTL; the pill is not
    pill.className = `${PILL_BASE_CLASS} ${PILL_BASE_CLASS}--timeline`;
    const label = document.createElement("span");
    label.className = `${PILL_BASE_CLASS}__text`;
    label.textContent = subcategory.name;
    pill.append(label);
    pill.title = `${category.name} › ${subcategory.name}\n${percent(choice.probability)}% probability (not measured accuracy)`;
    anchor.insertAdjacentElement("beforebegin", pill);
    return true;
  }

  // The AI-slop score, right of the category pill and left of X's own
  // controls. Switched off in the popup, or answered with no opinion, it is
  // simply absent. Returns whether the post now has a score pill.
  function renderSlopPill(article, state, result) {
    if (!slopEnabled || result.slop.confidence < SLOP_MIN_CONFIDENCE) {
      removeSlopPill(article);
      return false;
    }
    const display = slopDisplay(result.slop);
    const signature = `${state.cacheKey}:${display.value}:${display.band}`;
    let pill = article.querySelector(SELECTORS.slopPill);
    if (pill && (!pill.isConnected || pill.dataset.jevxSig !== signature)) {
      pill.remove();
      pill = null;
    }
    if (pill) return true;
    // Right of the category pill when it is already placed, otherwise at the
    // header anchor (an uncertain category shows none).
    const category = article.querySelector(SELECTORS.pill);
    const anchor = category || pillAnchor(article);
    if (!anchor) {
      markSkip(article, "no-anchor");
      return false;
    }
    pill = document.createElement("span");
    pill.dataset.jevxTimeline = "slop";
    pill.dataset.jevxSig = signature;
    pill.dataset.jevxBand = display.band;
    pill.setAttribute("dir", "ltr");
    pill.className = `${PILL_BASE_CLASS} ${PILL_BASE_CLASS}--timeline ${PILL_BASE_CLASS}--slop`;
    pill.append(slopIcon(), document.createTextNode(String(display.value)));
    pill.title = slopTitle(result.slop, display, "the post");
    if (category) category.insertAdjacentElement("afterend", pill);
    else anchor.insertAdjacentElement("beforebegin", pill);
    return true;
  }

  function removeCategoryPill(article) {
    const pill = article && article.querySelector(SELECTORS.pill);
    if (pill) pill.remove();
  }

  function removeSlopPill(article) {
    const pill = article && article.querySelector(SELECTORS.slopPill);
    if (pill) pill.remove();
  }

  function removePills(article) {
    if (!article) return;
    for (const pill of article.querySelectorAll(SELECTORS.anyPill)) pill.remove();
  }

  /* ---------------------------------------------------------------- *
   * Failures
   *
   * Fail quietly (no pill, no error banner). Halting codes stop the whole
   * queue until the service worker says the state changed; transient codes
   * get a few delayed page-level retries on top of the service worker's own
   * retries; anything else is final for this version of the post.
   * ---------------------------------------------------------------- */

  function handleFailure(failureKey, code) {
    if (HALT_ERROR_CODES.has(code)) {
      haltQueue();
      return;
    }
    const previous = failures.get(failureKey);
    const count = previous ? previous.count + 1 : 1;
    const delay = PAGE_RETRY_DELAYS_MS[count - 1];
    failures.set(failureKey, { code, count, retryAt: Date.now() + (delay || 0) });
    if (RETRYABLE_ERROR_CODES.has(code) && delay !== undefined) {
      setTimeout(() => scheduleScan(0), delay);
    }
  }

  function failedForGood(failure) {
    return !!failure && (!RETRYABLE_ERROR_CODES.has(failure.code) || failure.count > PAGE_RETRY_DELAYS_MS.length);
  }

  function retryAllowed(failure) {
    if (!failure) return true;
    return !failedForGood(failure) && Date.now() >= failure.retryAt;
  }

  function haltQueue() {
    halted = true;
    resetQueue();
  }

  function resume() {
    if (!halted) return;
    halted = false;
    log("queue resumed");
    scheduleScan(0);
  }

  function resetQueue() {
    queue.length = 0;
    queuedKeys.clear();
    // In-flight requests are allowed to finish; their results only ever land
    // in memoryCache, and rendering goes through scans that check identity.
  }

  /* ---------------------------------------------------------------- *
   * Service-worker state changes (key saved/cleared, a mode switched on
   * or off, cache cleared)
   * ---------------------------------------------------------------- */

  function clearPageCache() {
    cacheEpoch += 1;
    memoryCache.clear();
    failures.clear();
    articleStates = new WeakMap();
    if (intersectionObserver) intersectionObserver.disconnect();
    observedArticles.clear();
    for (const pill of document.querySelectorAll(SELECTORS.anyPill)) pill.remove();
  }

  function onServiceWorkerMessage(message, sender) {
    // Only this extension's own service worker (no sender.tab) may drive state.
    if (sender.id !== chrome.runtime.id || sender.tab) return;
    if (!message || message.type !== "JEVX_STATE_CHANGED") return;
    if (message.cacheCleared === true) clearPageCache();
    applyPageSettings(message);
    if (message.hasApiKey === true) resume();
    else if (message.hasApiKey === false) haltQueue();
    checkRoute(); // activates or strips the page if the switch changed
    scheduleScan(0);
  }

  function applyPageSettings(settings) {
    if (typeof settings.timelineEnabled === "boolean") modeEnabled = settings.timelineEnabled;
    if (typeof settings.slopEnabled === "boolean" && settings.slopEnabled !== slopEnabled) {
      slopEnabled = settings.slopEnabled;
      // Display-only: nothing is re-requested, the next scan just adds or
      // drops the score pill on posts that are already classified.
      for (const pill of document.querySelectorAll(SELECTORS.slopPill)) pill.remove();
    }
  }

  // The on/off switch lives in extension storage, which X pages can't read.
  // Retried while unanswered: until then this mode stays inactive.
  function loadPageSettings() {
    if (settingsLoading || Date.now() < settingsRetryAt) return;
    settingsLoading = true;
    sendToWorker({ type: "JEVX_GET_PAGE_SETTINGS" }, (response) => {
      settingsLoading = false;
      if (!response || !response.ok) {
        settingsRetryAt = Date.now() + SETTINGS_RETRY_MS;
        return;
      }
      applyPageSettings(response);
      checkRoute();
    });
  }

  /* ---------------------------------------------------------------- *
   * Boot
   * ---------------------------------------------------------------- */

  chrome.runtime.onMessage.addListener(onServiceWorkerMessage);
  checkRoute();
  setInterval(checkRoute, ROUTE_CHECK_INTERVAL_MS);
})();
