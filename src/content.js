/**
 * jevx: X content script.
 *
 * Owns: SPA route detection (status pages only), conversation discovery
 * (which articles are the original post, its replies, the original author's
 * own replies, promoted posts, thread ancestors, or unrelated
 * recommendations), the MutationObserver/IntersectionObserver
 * wiring, the bounded classification queue, in-memory dedupe/cache, reply
 * pills, the Conversation Pulse and filters under the original post, and
 * reacting to state changes pushed by the service worker.
 *
 * The original post is classified once (category, subcategory, conversation
 * type, tone, AI-slop score); its subcategory picks the reply matrix from
 * src/taxonomy.js (loaded before this script). Each reply is then classified
 * once against that matrix (primary state, per-state yes/no, stance, tone,
 * relevance, constructiveness, needs attention, AI-slop score). The Pulse and
 * the filters are computed locally from results already on hand; they never
 * trigger requests.
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

  // Keep MODEL, CLASSIFIER_SCHEMA_VERSION, MAX_TEXT_CHARS, fingerprintText()
  // and cacheKeyFor() in sync with src/service-worker.js; together they form
  // the shared cache identity. Changing either side must change both.
  const MODEL = "jev-latest";
  const CLASSIFIER_SCHEMA_VERSION = 5;
  const MAX_TEXT_CHARS = 10000;

  const DEBUG = false;
  const ROUTE_CHECK_INTERVAL_MS = 500;
  const SCAN_DEBOUNCE_MS = 200;
  const STATUS_ROUTE_RE = /^\/[^/]+\/status\/(\d+)/;
  const MAX_CONCURRENCY = 4; // project-level choice; tune after observing latency/rate limits
  const INTERSECTION_ROOT_MARGIN = "800px 0px";
  const HALT_ERROR_CODES = new Set(["NOT_CONFIGURED", "DISABLED", "AUTH"]);
  const RETRYABLE_ERROR_CODES = new Set(["NETWORK", "TIMEOUT", "RATE_LIMIT", "OVERLOADED", "API"]);
  // Page-level retries for transient failures, after the service worker's own
  // per-request retries are exhausted. One entry per retry.
  const PAGE_RETRY_DELAYS_MS = [15000, 60000];
  // How long to wait before asking again if the page settings request fails.
  const SETTINGS_RETRY_MS = 5000;

  const TAXONOMY = globalThis.JEVX_TAXONOMY;
  const UNCLEAR = "unclear"; // the Pulse bucket for replies Jev is unsure about

  // Universal reply signals. Keep the label sets in sync with
  // src/service-worker.js.
  const STANCE_NAMES = { supportive: "Supportive", opposing: "Opposing", neutral: "Neutral", mixed: "Mixed", unclear: "Unclear" };
  const TONE_NAMES = { friendly: "Friendly", neutral: "Neutral", critical: "Critical", hostile: "Hostile", humorous: "Humorous", constructive: "Constructive" };
  const RELEVANCE_NAMES = { unrelated: "Unrelated", partially_relevant: "Partially relevant", relevant: "Relevant" };
  const RELEVANCE_LEVELS = ["unrelated", "partially_relevant", "relevant"];
  const CONVERSATION_TYPE_NAMES = { discussion: "Discussion", debate: "Debate", feedback: "Feedback", question: "Question", announcement: "Announcement", story: "Story", humor: "Humor", other: "Other" };
  const THREAD_TONE_NAMES = { informative: "Informative", promotional: "Promotional", enthusiastic: "Enthusiastic", opinionated: "Opinionated", critical: "Critical", humorous: "Humorous", personal: "Personal", other: "Other" };

  // Certainty of a choice = the smaller of the chosen option's probability
  // and Jev's confidence statistic, so a flat distribution or a weak top
  // option both count as unsure. Tiers, display-only (no schema bump):
  // high >= 0.80, normal >= 0.60, low >= 0.45, otherwise Unclear.
  const CERTAINTY_TIERS = [
    [0.8, "high"],
    [0.6, "normal"],
    [0.45, "low"],
  ];
  // A second state is shown when its own yes/no probability reaches this.
  const SECONDARY_MIN = 0.6;

  // AI-slop score. Jev answers an ordered rubric (0 = slop, SLOP_TOP_LEVEL =
  // clearly human and substantive) inside the thread and reply requests that
  // are sent anyway; everything below is display-only, like the certainty
  // tiers, and never changes a request or a cache key. Keep the level ids in
  // step with SLOP_LEVELS in src/service-worker.js (changing the rubric
  // there is a schema bump; changing only the bands here is not), and keep
  // this block identical to the one in src/timeline.js.
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

  // A matrix's states take categorical color slots 1–7 in matrix order
  // (content.css); Other is gray and Unclear gray-striped. Matrices have at
  // most 7 states besides Other, so hues are never cycled.
  const MAX_COLOR_SLOTS = 7;

  // "Needs attention" cutoff, in percent: a multiple of 5 from 5 to 95. The
  // default is a user setting (popup); the Pulse can override it per thread.
  // Keep in sync with src/service-worker.js.
  const DEFAULT_NEEDS_REPLY_CUTOFF = 80;
  const CUTOFF_CHOICES = Array.from({ length: 19 }, (_, i) => 5 + i * 5);
  const isValidCutoff = (value) => CUTOFF_CHOICES.includes(value);

  // Observed X frontend details, not an official X DOM contract. They are
  // centralized here so a frontend change only touches this block. Generated
  // class names (r-*, css-*) are deliberately avoided.
  const SELECTORS = {
    primaryColumn: '[data-testid="primaryColumn"]',
    sidebarColumn: '[data-testid="sidebarColumn"]',
    article: 'article[data-testid="tweet"]',
    tweetText: '[data-testid="tweetText"]',
    // A timeline cell holding a section heading instead of a tweet. After
    // the original post, the first one ("Discover more") ends the replies;
    // everything below it is recommended, unrelated content.
    timelineCell: '[data-testid="cellInnerDiv"]',
    sectionHeading: 'h2, [role="heading"]',
    // A post's own timestamp links to its status page. Promoted posts show an
    // "Ad" label instead, so they have none (quoted posts' timestamps are not
    // links). placementTracking can wrap a promoted post, but X also uses it
    // around video and GIF players inside ordinary posts, so it only counts
    // as an ad marker when it encloses the whole article.
    ownTimestamp: 'a[href*="/status/"] time',
    promotedMarker: '[data-testid="placementTracking"]',
    // The "More" (…) button in a post's header. The Needs reply flag goes at
    // the start of the header's action group, left of the Grok button.
    caret: '[data-testid="caret"]',
    pill: '[data-jevx-pill="true"]',
    flag: '[data-jevx-flag="true"]',
    pulse: '[data-jevx-pulse="true"]',
  };

  const PILL_BASE_CLASS = "jevx-pill";
  const LOADING_CLASS = `${PILL_BASE_CLASS}--loading`;

  // Filtered-out replies are collapsed out of the layout, not detached: X's
  // React tree and virtualized list own these nodes. The attribute goes on
  // the reply's timeline cell so X's separators collapse with it.
  const HIDE_ATTR = "data-jevx-hide"; // "animating" | "hidden"
  const HIDE_DURATION_MS = 420;
  const HIDE_EASING = "cubic-bezier(0.4, 0, 0.2, 1)";
  const HIDE_FADE_END = 0.4; // fraction of the animation spent fading out
  const HIDE_COLLAPSE_START = 0.3; // fraction at which the gap starts closing
  // Hides/reveals caused by results arriving (not by a filter click) wait
  // this long so replies resolving close together collapse as one block.
  const HIDE_BATCH_MS = 300;

  /* ---------------------------------------------------------------- *
   * State
   *
   * Per-article state tracks identity (tweet id) and content (text
   * fingerprints of the reply and the original post) separately from
   * processing state, which is keyed by cacheKey: the result, queue/in-flight
   * status, and failures all belong to an (original, reply) text pair, not
   * to the DOM node X happens to render it in. Every scan reconciles each
   * article against that state, so re-renders, recycled nodes, late or
   * edited text, failed requests, and a resumed queue all converge on the
   * same path.
   *
   * Conversation membership and the Pulse counts are keyed by tweet id, not
   * by DOM node, so X's virtualized scrolling and re-renders can neither
   * double-count a reply nor forget one that scrolled out of the DOM.
   * ---------------------------------------------------------------- */

  let activeStatusId = null;
  let halted = false;
  // The popup's "tweet pages" switch: null until the service worker answers,
  // so nothing is sent or rendered while it is unknown or off.
  let modeEnabled = null;
  let settingsLoading = false;
  let settingsRetryAt = 0;
  let cacheEpoch = 0; // bumped when the user clears cached classifications

  // The original post, once seen: {status: "ready", tweetId, text, fingerprint}
  // or {status: "no_text", tweetId} for media-only posts. null until seen.
  let context = null;
  // The original post's classification, for the current context only:
  // {status: "pending"} while requested, {status: "ready", result}, or
  // {status: "fallback"} once it failed for good (replies then use the
  // General Discussion matrix). null until requested.
  let thread = null;
  let threadInflight = false;
  const threadCache = new Map(); // `${tweetId}:${fingerprint}` -> thread result, for this document's lifetime
  // Filters: any number of reply states (a reply matches if its primary or
  // secondary state is one of them), and independently, Needs attention.
  let selectedStates = new Set();
  let needsOnly = false;
  let expandedIds = new Set(); // reply tweet ids whose pill details are open
  let ancestorIds = new Set(); // thread posts shown above the original
  let replyIds = new Set();
  let unrelatedIds = new Set(); // "Discover more" recommendations below the replies
  let conversationEndSeen = false;
  let originalAuthor = null; // lowercased handle, once the original has been seen
  const pulseEntries = new Map(); // reply tweet id -> {primary, secondary, stance, needs}, for the current context only
  let globalCutoff = DEFAULT_NEEDS_REPLY_CUTOFF; // from the extension settings
  let slopEnabled = true; // the popup's "AI slop score" switch (display only)
  let threadCutoff = null; // this thread's override from the Pulse, or null
  // Pulse disclosure, kept for the session so a rebuilt Pulse opens the same way.
  let pulseDetailsOpen = false;
  let pulseChipsExpanded = false; // show the chips that match no reply yet
  let pulseSeq = 0;

  let mutationObserver = null;
  let mutationRoot = null;
  let intersectionObserver = null;
  let articleStates = new WeakMap(); // reply article -> {tweetId, text, fingerprint, cacheKey}
  let observedArticles = new WeakSet(); // replies waiting to become near-visible
  let scanScheduled = false;

  // Reply visibility under a filter, per hide target (timeline cell).
  const visibilityRequests = new Map(); // target -> hide?, collected during one scan
  const deferredVisibility = new Map(); // target -> hide?, waiting to animate
  let visibilityTimer = null;
  let seenTargets = new WeakSet(); // targets shown on screen at least once (new ones never animate)
  let visibilityAnims = new WeakMap(); // target -> {hide, animation} while animating

  const queue = [];
  const queuedKeys = new Set();
  const inflightKeys = new Set();
  const memoryCache = new Map(); // cacheKey -> normalized result, for this document's lifetime
  const failures = new Map(); // cacheKey -> {code, count, retryAt}

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

  // A reply's result is only valid relative to one version of the original
  // post and one reply matrix, so the key covers both tweets' ids and text
  // fingerprints and the matrix (subcategory) id.
  function cacheKeyFor(contextTweetId, contextText, matrixId, tweetId, text) {
    return `${CLASSIFIER_SCHEMA_VERSION}:${MODEL}:${contextTweetId}:${fingerprintText(contextText)}:${matrixId}:${tweetId}:${fingerprintText(text)}`;
  }

  const percent = (probability) => Math.round(probability * 100);

  // The 0-10 score the pill shows, its color band and the rubric level Jev
  // landed on. Identical to the helper in src/timeline.js.
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

  // Is there a score worth showing for this result?
  const hasSlop = (result) => slopEnabled && !!result && !!result.slop && result.slop.confidence >= SLOP_MIN_CONFIDENCE;

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

  // The score pill: a gauge and the number, its band in a data attribute so
  // the color lives in content.css. `extraClass` places it in the Pulse head.
  function slopPillElement(extraClass) {
    const pill = document.createElement("span");
    pill.className = `${PILL_BASE_CLASS} ${PILL_BASE_CLASS}--slop${extraClass ? ` ${extraClass}` : ""}`;
    pill.setAttribute("dir", "ltr");
    const text = document.createElement("span");
    text.className = `${PILL_BASE_CLASS}__text`;
    pill.append(slopIcon(), text);
    return pill;
  }

  // Idempotent: a no-op write would fire the MutationObserver.
  function updateSlopPill(pill, slop, subject) {
    const display = slopDisplay(slop);
    if (pill.dataset.jevxBand !== display.band) pill.dataset.jevxBand = display.band;
    setText(pill.querySelector(`.${PILL_BASE_CLASS}__text`), String(display.value));
    const title = slopTitle(slop, display, subject);
    if (pill.title !== title) pill.title = title;
    return pill;
  }

  // a precedes b in document order.
  const isBefore = (a, b) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

  function setText(el, text) {
    if (el.textContent !== text) el.textContent = text;
  }

  /* ---------------------------------------------------------------- *
   * Route detection (SPA-aware)
   * ---------------------------------------------------------------- */

  function parseStatusId(pathname) {
    const match = STATUS_ROUTE_RE.exec(pathname);
    return match ? match[1] : null;
  }

  function checkRoute() {
    if (modeEnabled !== true) {
      if (modeEnabled === null) loadPageSettings();
      if (activeStatusId !== null) deactivate(); // switched off: strip everything
      return;
    }
    const statusId = parseStatusId(location.pathname);
    if (statusId) {
      if (statusId !== activeStatusId) activate(statusId);
      else ensureObservation(); // re-attach if X replaced the observed subtree
    } else if (activeStatusId !== null) {
      deactivate();
    }
  }

  function activate(statusId) {
    activeStatusId = statusId;
    halted = false;
    resetQueue();
    resetConversation();
    log("status route activated:", statusId);
    ensureObservation();
    scheduleScan();
  }

  function deactivate() {
    activeStatusId = null;
    halted = false;
    resetQueue();
    resetConversation();
    if (mutationObserver) {
      mutationObserver.disconnect();
      mutationObserver = null;
      mutationRoot = null;
    }
    if (intersectionObserver) {
      intersectionObserver.disconnect();
      intersectionObserver = null;
    }
    log("status route deactivated");
  }

  function resetQueue() {
    for (const task of queue) removeLoadingPill(task.article);
    queue.length = 0;
    queuedKeys.clear();
    // In-flight requests are allowed to finish. Their results are only ever
    // rendered through reconcile(), which checks each article's current
    // identity and text, so a result can never land on a recycled node.
  }

  function resetConversation() {
    context = null;
    thread = null;
    selectedStates = new Set();
    needsOnly = false;
    expandedIds = new Set();
    ancestorIds = new Set();
    replyIds = new Set();
    unrelatedIds = new Set();
    conversationEndSeen = false;
    originalAuthor = null;
    threadCutoff = null;
    pulseEntries.clear();
    articleStates = new WeakMap();
    observedArticles = new WeakSet();
    if (intersectionObserver) intersectionObserver.disconnect();
    // X may reuse nodes across routes: strip everything this script added.
    for (const el of document.querySelectorAll(`${SELECTORS.pulse}, ${SELECTORS.pill}, ${SELECTORS.flag}`)) el.remove();
    resetVisibility();
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
    // characterData: tweet text can be filled in or edited in place.
    mutationObserver = new MutationObserver(() => scheduleScan());
    mutationObserver.observe(root, { childList: true, subtree: true, characterData: true });
  }

  function scheduleScan(delayMs = SCAN_DEBOUNCE_MS) {
    if (activeStatusId === null || scanScheduled) return;
    scanScheduled = true;
    setTimeout(() => {
      scanScheduled = false;
      scanArticles();
    }, delayMs);
  }

  // userAction: a filter or cutoff change, whose hides/reveals animate at once
  // instead of waiting for the batch window.
  function scanArticles(userAction = false) {
    if (activeStatusId === null) return;
    const root = document.querySelector(SELECTORS.primaryColumn);
    if (!root) return;
    syncTheme();
    reconcileArticles(root);
    commitVisibility(userAction);
  }

  // X has its own light / dim / dark themes, independent of the OS setting.
  // Chart colors are picked for the page's actual background.
  function syncTheme() {
    const match = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(getComputedStyle(document.body).backgroundColor);
    const dark = !!match && 0.2126 * match[1] + 0.7152 * match[2] + 0.0722 * match[3] < 128;
    const theme = dark ? "dark" : "light";
    if (document.documentElement.getAttribute("data-jevx-theme") !== theme) {
      document.documentElement.setAttribute("data-jevx-theme", theme);
    }
  }

  function reconcileArticles(root) {
    const articles = [...root.querySelectorAll(SELECTORS.article)].filter((a) => !a.closest(SELECTORS.sidebarColumn));
    const ids = articles.map(extractTweetId);
    const original = articles[ids.indexOf(activeStatusId)] || null;
    if (original) {
      updateContext(original);
      originalAuthor = authorOf(original) || originalAuthor;
    }
    ensureThread(); // the context outlives the original's DOM node, so retries still run after it scrolls away
    const end = findConversationEnd(root, original);
    if (end) conversationEndSeen = true;
    articles.forEach((article, i) => {
      const tweetId = ids[i];
      let role;
      if (tweetId === activeStatusId) role = "original";
      else if (isPromoted(article)) role = "ad"; // checked first: an ad may carry no usable tweet id
      else role = tweetId ? roleOf(article, tweetId, original, end) : "unrelated";
      if (role === "reply" && originalAuthor && authorOf(article) === originalAuthor) role = "author";
      processArticle(article, tweetId, role);
    });
    if (original) renderPulse(original);
  }

  function onIntersect(entries) {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const article = entry.target;
      intersectionObserver.unobserve(article);
      observedArticles.delete(article);
      const state = articleStates.get(article);
      if (!state || activeStatusId === null || !article.isConnected) continue;
      if (extractTweetId(article) !== state.tweetId) continue; // node was recycled; the next scan handles it
      queueTweet(article, state);
    }
  }

  /* ---------------------------------------------------------------- *
   * Conversation discovery
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

  // Handle from the post's own timestamp link (/<handle>/status/<id>),
  // lowercased because X handles are case-insensitive.
  function authorOf(article) {
    const time = article.querySelector(SELECTORS.ownTimestamp);
    const anchor = time ? time.closest("a") : null;
    const match = anchor ? /^\/([^/]+)\/status\/\d+/.exec(anchor.getAttribute("href") || "") : null;
    return match ? match[1].toLowerCase() : null;
  }

  // Not cached: a regular post rendered before its timestamp would briefly
  // look promoted, and the next scan corrects it. A promotedMarker inside the
  // article is a media player, not an ad (see SELECTORS).
  function isPromoted(article) {
    return !!article.closest(SELECTORS.promotedMarker) || !article.querySelector(SELECTORS.ownTimestamp);
  }

  function extractTweetText(article) {
    // First tweetText descendant is the tweet's own text; quoted tweets nest
    // their own tweetText deeper and later in document order, so they are
    // naturally excluded. Never concatenate.
    const textEl = article.querySelector(SELECTORS.tweetText);
    if (!textEl) return null;
    // Trimmed again after the cut: the worker fingerprints the trimmed text,
    // so a cut landing on whitespace would otherwise be rejected.
    const text = (textEl.innerText || "").trim().slice(0, MAX_TEXT_CHARS).trim();
    return text || null;
  }

  // Stance is only defined relative to the original post's text, so no
  // reply is classified until that text is known. A media-only original is
  // handled explicitly: no requests, and the Pulse says why.
  function updateContext(original) {
    let next;
    if (!original.querySelector(SELECTORS.tweetText)) {
      next = { status: "no_text", tweetId: activeStatusId };
    } else {
      const text = extractTweetText(original);
      if (!text) return; // text element present but not filled in yet
      next = { status: "ready", tweetId: activeStatusId, text, fingerprint: fingerprintText(text) };
    }
    if (context && context.status === next.status && context.fingerprint === next.fingerprint) return;
    context = next;
    thread = null;
    selectedStates = new Set(); // the next matrix may have different states
    pulseEntries.clear(); // results against a previous version of the post no longer apply
  }

  function findConversationEnd(root, original) {
    for (const cell of root.querySelectorAll(SELECTORS.timelineCell)) {
      if (cell.querySelector(SELECTORS.article) || !cell.querySelector(SELECTORS.sectionHeading)) continue;
      if (original && !isBefore(original, cell)) continue;
      return cell;
    }
    return null;
  }

  // Classifies an article as the original, a reply, a thread ancestor, or
  // unrelated. Position relative to the original and the end-of-replies
  // heading decides; once those anchors scroll out of the DOM, the ids
  // remembered while they were present decide.
  function roleOf(article, tweetId, original, end) {
    if (tweetId === activeStatusId) return "original";
    let role;
    if (original && isBefore(article, original)) role = "ancestor";
    else if (end && isBefore(end, article)) role = "unrelated";
    else if (original || end) role = "reply";
    else if (ancestorIds.has(tweetId)) role = "ancestor";
    else if (unrelatedIds.has(tweetId)) role = "unrelated";
    else if (replyIds.has(tweetId) || !conversationEndSeen) role = "reply";
    else role = "unrelated"; // new content below a replies section that already ended
    for (const [set, name] of [[ancestorIds, "ancestor"], [replyIds, "reply"], [unrelatedIds, "unrelated"]]) {
      if (name === role) set.add(tweetId);
      else set.delete(tweetId);
    }
    return role;
  }

  /* ---------------------------------------------------------------- *
   * Reply reconciliation
   * ---------------------------------------------------------------- */

  function forgetArticle(article) {
    articleStates.delete(article);
    if (observedArticles.has(article)) {
      observedArticles.delete(article);
      if (intersectionObserver) intersectionObserver.unobserve(article);
    }
    removePill(article);
    setHidden(article, false);
  }

  function processArticle(article, tweetId, role) {
    if (role !== "original") removePulse(article); // recycled node that used to be the original
    if (role === "ad" || role === "author") {
      // Never classified or counted (this also drops a count recorded before
      // the post was recognized). Ads match no filter, so any filter hides
      // them; the author's own replies always stay visible.
      forgetArticle(article);
      if (tweetId) pulseEntries.delete(tweetId);
      setHidden(article, role === "ad" && filterActive());
      return;
    }
    // Replies wait for the original post's classification, which picks the
    // matrix they are classified against.
    const matrixId = currentMatrixId();
    if (role !== "reply" || !context || context.status !== "ready" || !matrixId) {
      forgetArticle(article);
      return;
    }
    const text = extractTweetText(article);
    let state = articleStates.get(article);
    if (!text) {
      // Media-only reply, or text not rendered yet. Nothing is recorded, so
      // a later scan picks it up once text appears. It matches no filter, so
      // any filter hides it.
      if (state) forgetArticle(article);
      setHidden(article, filterActive());
      return;
    }

    const cacheKey = cacheKeyFor(context.tweetId, context.text, matrixId, tweetId, text);
    if (state && state.cacheKey !== cacheKey) {
      // Recycled node (different tweet) or edited text: the old pill and any
      // pending observation describe other content.
      if (state.tweetId === tweetId) pulseEntries.delete(tweetId);
      forgetArticle(article);
      state = undefined;
    }
    if (!state) {
      state = { tweetId, text, fingerprint: fingerprintText(text), matrixId, cacheKey };
      articleStates.set(article, state);
    }
    reconcile(article, state);
  }

  // Brings one reply's pill and visibility in line with the processing state of
  // its cacheKey, scheduling work only when nothing is done, pending or
  // blocked. Unclassified replies that may still get a result stay visible
  // under a filter: pending is not a mismatch.
  function reconcile(article, state) {
    const memo = memoryCache.get(state.cacheKey);
    if (memo) {
      const entry = pulseEntryFor(memo);
      ensureResultPill(article, state.tweetId, memo, entry);
      pulseEntries.set(state.tweetId, entry);
      setHidden(article, !matchesFilter(entry));
      return;
    }
    if (queuedKeys.has(state.cacheKey) || inflightKeys.has(state.cacheKey)) {
      ensureLoadingPill(article); // this or another node's request will resolve it
      setHidden(article, false);
      return;
    }
    removeLoadingPill(article);
    const failure = failures.get(state.cacheKey);
    setHidden(article, filterActive() && failedForGood(failure));
    if (halted || observedArticles.has(article)) return;
    if (!retryAllowed(failure)) return;
    if (intersectionObserver) {
      observedArticles.add(article);
      intersectionObserver.observe(article);
    }
  }

  function failedForGood(failure) {
    return !!failure && (!RETRYABLE_ERROR_CODES.has(failure.code) || failure.count > PAGE_RETRY_DELAYS_MS.length);
  }

  function retryAllowed(failure) {
    if (!failure) return true;
    return !failedForGood(failure) && Date.now() >= failure.retryAt;
  }

  /* ---------------------------------------------------------------- *
   * Filter visibility
   *
   * A reply that doesn't match the filter has its timeline cell collapsed
   * (display: none), so X's list closes the gap as if the cell were gone.
   * Scans only record the wanted state; commitVisibility() applies it after
   * the scan so every change from one filter click (or one batch of
   * results) animates together. Consecutive cells changing the same way
   * animate as one block: they fade out, then the block collapses like a
   * single element, bottom edge first. A cell that stays visible between
   * them splits the block. Reveals play the same animation in reverse.
   *
   * Nothing here mutates the DOM tree or inline styles: the state is an
   * attribute (not observed by the MutationObserver) and the motion is Web
   * Animations. Cells X renders for the first time, cells off screen, and
   * reduced-motion users get the final state immediately.
   * ---------------------------------------------------------------- */

  const hideTargetOf = (article) => article.closest(SELECTORS.timelineCell) || article;

  function setHidden(article, hide) {
    visibilityRequests.set(hideTargetOf(article), hide);
  }

  function effectivelyHidden(target) {
    const record = visibilityAnims.get(target);
    return record ? record.hide : target.getAttribute(HIDE_ATTR) === "hidden";
  }

  function applyVisibility(target, hide) {
    if (hide) target.setAttribute(HIDE_ATTR, "hidden");
    else target.removeAttribute(HIDE_ATTR);
  }

  const prefersReducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function commitVisibility(userAction) {
    for (const [target, hide] of visibilityRequests) {
      if (!seenTargets.has(target)) {
        // Newly rendered by X: it was never on screen in the other state.
        seenTargets.add(target);
        deferredVisibility.delete(target);
        if (hide !== effectivelyHidden(target)) applyVisibility(target, hide);
      } else if (hide === effectivelyHidden(target)) {
        deferredVisibility.delete(target);
      } else {
        deferredVisibility.set(target, hide);
      }
    }
    visibilityRequests.clear();
    if (deferredVisibility.size === 0) return;
    if (userAction) flushVisibility();
    else if (visibilityTimer === null) visibilityTimer = setTimeout(flushVisibility, HIDE_BATCH_MS);
  }

  function flushVisibility() {
    clearTimeout(visibilityTimer);
    visibilityTimer = null;
    const reduce = prefersReducedMotion();
    const changes = [];
    for (const [target, hide] of deferredVisibility) {
      if (!target.isConnected) continue;
      const record = visibilityAnims.get(target);
      if (record) {
        // Mid-animation and the wanted state flipped: play back from here.
        if (record.hide !== hide) {
          record.hide = hide;
          record.animation.reverse();
        }
      } else if (hide !== effectivelyHidden(target)) {
        if (reduce) applyVisibility(target, hide);
        else changes.push({ target, hide });
      }
    }
    deferredVisibility.clear();
    for (const run of groupRuns(changes)) animateRun(run.targets, run.hide);
  }

  // Splits changes into runs of adjacent cells changing the same way. Cells
  // already hidden don't separate a run; anything visible or changing
  // differently does.
  function groupRuns(changes) {
    changes.sort((a, b) => (isBefore(a.target, b.target) ? -1 : 1));
    const changing = new Set(changes.map((change) => change.target));
    const runs = [];
    let run = null;
    for (const { target, hide } of changes) {
      if (run && run.hide === hide && adjacent(run.targets[run.targets.length - 1], target, changing)) {
        run.targets.push(target);
      } else {
        run = { hide, targets: [target] };
        runs.push(run);
      }
    }
    return runs;
  }

  function adjacent(a, b, changing) {
    for (let el = a.nextElementSibling; el; el = el.nextElementSibling) {
      if (el === b) return true;
      if (changing.has(el) || visibilityAnims.has(el) || el.getAttribute(HIDE_ATTR) !== "hidden") return false;
    }
    return false;
  }

  function animateRun(targets, hide) {
    // "animating" undoes display: none (for reveals) and clips overflow, so
    // natural heights can be measured before anything is painted.
    for (const target of targets) target.setAttribute(HIDE_ATTR, "animating");
    const rects = targets.map((target) => target.getBoundingClientRect());
    const total = rects.reduce((sum, rect) => sum + rect.height, 0);
    const top = Math.min(...rects.map((rect) => rect.top));
    const bottom = Math.max(...rects.map((rect) => rect.bottom));
    if (total === 0 || bottom <= 0 || top >= window.innerHeight) {
      for (const target of targets) applyVisibility(target, hide);
      return;
    }
    let offset = 0;
    targets.forEach((target, i) => {
      const height = rects[i].height;
      const animation = target.animate(runKeyframes(offset, height, total), {
        duration: HIDE_DURATION_MS,
        easing: HIDE_EASING,
        fill: "both",
        direction: hide ? "normal" : "reverse",
      });
      offset += height;
      const record = { hide, animation };
      visibilityAnims.set(target, record);
      animation.addEventListener("finish", () => {
        if (visibilityAnims.get(target) !== record) return;
        visibilityAnims.delete(target);
        applyVisibility(target, record.hide);
        animation.cancel(); // the attribute now holds the final state
      });
    });
  }

  // Hide keyframes for one cell at `offset` px into a run `total` px tall.
  // All cells fade together; then the run's bottom edge sweeps up to its top
  // edge, each cell shrinking only while that edge crosses it, so the whole
  // run reads as one element closing. Offsets are in eased progress.
  function runKeyframes(offset, height, total) {
    const collapseAt = (fraction) => HIDE_COLLAPSE_START + (1 - HIDE_COLLAPSE_START) * fraction;
    const px = (value) => `${value}px`;
    return [
      { offset: 0, opacity: 1, height: px(height) },
      { offset: HIDE_FADE_END, opacity: 0 },
      { offset: collapseAt(1 - (offset + height) / total), height: px(height) },
      { offset: collapseAt(1 - offset / total), height: "0px" },
      { offset: 1, opacity: 0, height: "0px" },
    ].sort((a, b) => a.offset - b.offset);
  }

  function resetVisibility() {
    clearTimeout(visibilityTimer);
    visibilityTimer = null;
    visibilityRequests.clear();
    deferredVisibility.clear();
    for (const el of document.querySelectorAll(`[${HIDE_ATTR}]`)) {
      const record = visibilityAnims.get(el);
      if (record) record.animation.cancel();
      el.removeAttribute(HIDE_ATTR);
    }
    visibilityAnims = new WeakMap();
    seenTargets = new WeakSet();
  }

  /* ---------------------------------------------------------------- *
   * Queue + concurrency
   * ---------------------------------------------------------------- */

  function queueTweet(article, state) {
    if (halted) return; // resume() rescans and re-registers
    if (!context || context.status !== "ready") return;
    if (queuedKeys.has(state.cacheKey) || inflightKeys.has(state.cacheKey)) return;
    queuedKeys.add(state.cacheKey);
    queue.push({
      article,
      contextTweetId: context.tweetId,
      contextText: context.text,
      contextFingerprint: context.fingerprint,
      matrixId: state.matrixId,
      tweetId: state.tweetId,
      text: state.text,
      fingerprint: state.fingerprint,
      cacheKey: state.cacheKey,
    });
    ensureLoadingPill(article);
    log("queued reply:", state.tweetId);
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

  function dispatchTask(task) {
    inflightKeys.add(task.cacheKey);
    const epoch = cacheEpoch;
    let settled = false;
    const message = {
      type: "JEVX_CLASSIFY_REPLY",
      contextTweetId: task.contextTweetId,
      contextText: task.contextText,
      contextFingerprint: task.contextFingerprint,
      matrixId: task.matrixId,
      tweetId: task.tweetId,
      text: task.text,
      fingerprint: task.fingerprint,
    };
    sendToWorker(message, (response) => {
      if (settled) return;
      settled = true;
      inflightKeys.delete(task.cacheKey);
      // A result requested before "Clear cached classifications" is dropped;
      // reconciliation re-requests it if the reply is still on screen.
      if (epoch === cacheEpoch) handleResponse(task, response);
      scanArticles(); // renders this result (and any other node sharing its key) and updates the Pulse
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
    if (!isValidReplyResult(result, task.matrixId)) {
      warnCode("INVALID_RESPONSE");
      handleFailure(task.cacheKey, "INVALID_RESPONSE");
      return;
    }
    failures.delete(task.cacheKey);
    memoryCache.set(task.cacheKey, result);
    log("classification complete:", result.primaryState.label, `${result.latencyMs}ms`);
  }

  /* ---------------------------------------------------------------- *
   * Original-post classification (once per version of the post)
   * ---------------------------------------------------------------- */

  const threadKeyOf = (ctx) => `${ctx.tweetId}:${ctx.fingerprint}`;

  // The matrix replies are classified against, or null while unknown. A
  // thread whose classification failed for good uses General Discussion, so
  // reply analysis is never blocked on it.
  function currentMatrixId() {
    if (!thread) return null;
    if (thread.status === "ready") return thread.result.matrixId;
    if (thread.status === "fallback") return TAXONOMY.FALLBACK_SUBCATEGORY;
    return null;
  }

  function ensureThread() {
    if (!context || context.status !== "ready") return;
    const key = threadKeyOf(context);
    const known = threadCache.get(key);
    if (known) {
      if (!thread || thread.status !== "ready") thread = { status: "ready", result: known };
      return;
    }
    if (thread && thread.status === "fallback") return;
    const failure = failures.get(`thread:${key}`);
    if (failedForGood(failure)) {
      thread = { status: "fallback" };
      return;
    }
    thread = { status: "pending" };
    if (halted || threadInflight || !retryAllowed(failure)) return;
    threadInflight = true;
    const epoch = cacheEpoch;
    const { tweetId, text, fingerprint } = context;
    sendToWorker({ type: "JEVX_CLASSIFY_THREAD", surface: "conversation", tweetId, text, fingerprint }, (response) => {
      threadInflight = false;
      if (epoch === cacheEpoch) handleThreadResponse(key, response);
      scanArticles();
    });
  }

  function handleThreadResponse(key, response) {
    if (!response || !response.ok) {
      const code = (response && response.error && response.error.code) || "NETWORK";
      warnCode(code);
      handleFailure(`thread:${key}`, code);
      return;
    }
    if (!isValidThreadResult(response.result)) {
      warnCode("INVALID_RESPONSE");
      handleFailure(`thread:${key}`, "INVALID_RESPONSE");
      return;
    }
    failures.delete(`thread:${key}`);
    threadCache.set(key, response.result);
    log("thread classified:", response.result.matrixId);
  }

  /* ---------------------------------------------------------------- *
   * Result validation + interpretation
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

  function isValidThreadResult(result) {
    const subcategory = result && TAXONOMY.subcategory(result.matrixId);
    return (
      !!subcategory &&
      !!TAXONOMY.category(result.categoryId) &&
      typeof result.fallback === "boolean" &&
      isValidChoice(result.subcategory, TAXONOMY.subcategories.map((s) => s.id)) &&
      isValidChoice(result.conversationType, Object.keys(CONVERSATION_TYPE_NAMES)) &&
      isValidChoice(result.tone, Object.keys(THREAD_TONE_NAMES)) &&
      isValidScore(result.slop, SLOP_LEVELS)
    );
  }

  function isValidReplyResult(result, matrixId) {
    const subcategory = TAXONOMY.subcategory(matrixId);
    if (!result || !subcategory || result.matrixId !== matrixId) return false;
    const stateIds = subcategory.states.map((state) => state.id);
    const signals = result.stateSignals;
    return (
      isValidChoice(result.primaryState, stateIds) &&
      !!signals &&
      stateIds.every((id) => id === "other" || isUnitNumber(signals[id])) &&
      isValidChoice(result.stance, Object.keys(STANCE_NAMES)) &&
      isValidChoice(result.tone, Object.keys(TONE_NAMES)) &&
      !!result.relevance &&
      RELEVANCE_LEVELS.includes(result.relevance.label) &&
      isUnitNumber(result.relevance.confidence) &&
      !!result.constructive &&
      isUnitNumber(result.constructive.probability) &&
      !!result.needsAttention &&
      isUnitNumber(result.needsAttention.probability) &&
      isValidScore(result.slop, SLOP_LEVELS)
    );
  }

  function tierOf(choice) {
    const certainty = Math.min(choice.probability, choice.confidence);
    for (const [min, tier] of CERTAINTY_TIERS) if (certainty >= min) return tier;
    return UNCLEAR;
  }

  // The best other state whose own yes/no answer is likely enough, or null.
  function secondaryStateOf(result) {
    let best = null;
    for (const [id, probability] of Object.entries(result.stateSignals)) {
      if (id === result.primaryState.label || probability < SECONDARY_MIN) continue;
      if (!best || probability > best.probability) best = { id, probability };
    }
    return best;
  }

  // What the Pulse and the filters count for one reply.
  function pulseEntryFor(result) {
    const secondary = secondaryStateOf(result);
    return {
      primary: tierOf(result.primaryState) === UNCLEAR ? UNCLEAR : result.primaryState.label,
      secondary: secondary ? secondary.id : null,
      stance: tierOf(result.stance) === UNCLEAR ? UNCLEAR : result.stance.label,
      needs: result.needsAttention.probability,
    };
  }

  const currentCutoff = () => (threadCutoff !== null ? threadCutoff : globalCutoff);

  // Probabilities are compared with a small tolerance so 0.8 meets an 80% cutoff.
  const meetsCutoff = (probability) => probability >= currentCutoff() / 100 - 1e-9;

  const filterActive = () => selectedStates.size > 0 || needsOnly;

  const hasState = (entry, id) => entry.primary === id || entry.secondary === id;

  // The state filters combine with OR; Needs attention narrows them further.
  function matchesFilter(entry) {
    if (selectedStates.size > 0 && ![...selectedStates].some((id) => hasState(entry, id))) return false;
    return !needsOnly || meetsCutoff(entry.needs);
  }

  // Fail quietly (reconcile removes the ANALYZING pill, no error banner).
  // Halting codes stop the whole queue until the service worker says the
  // state changed; transient codes get a few delayed page-level retries on
  // top of the service worker's own retries; anything else is final for this
  // (original, reply) text pair, or for this version of the original post.
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

  /* ---------------------------------------------------------------- *
   * Service-worker state changes (key saved/cleared, a mode switched on
   * or off, cache cleared)
   * ---------------------------------------------------------------- */

  function clearPageCache() {
    cacheEpoch += 1;
    memoryCache.clear();
    failures.clear();
    threadCache.clear();
    thread = null;
    pulseEntries.clear();
    for (const pill of document.querySelectorAll(SELECTORS.pill)) {
      if (!pill.classList.contains(LOADING_CLASS)) pill.remove();
    }
    for (const flag of document.querySelectorAll(SELECTORS.flag)) flag.remove();
    articleStates = new WeakMap();
    if (intersectionObserver) intersectionObserver.disconnect();
    observedArticles = new WeakSet();
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
    scheduleScan(0); // re-render pills and the Pulse for the new state
  }

  /* ---------------------------------------------------------------- *
   * DOM writes (idempotent, textContent only, never innerHTML)
   *
   * Every scan reconciles every article, so these must not touch the DOM
   * when nothing changed: a no-op write would still fire the
   * MutationObserver and schedule another scan, forever.
   * ---------------------------------------------------------------- */

  function setPill(pill, className, text, title) {
    if (pill.className !== className) pill.className = className;
    setText(pill, text);
    if (pill.title !== title) pill.title = title;
  }

  // The per-reply container: a loading pill while analyzing, then the state
  // pill (a button that expands the details). Clicks and keys stay inside
  // it, since X opens the post on a click anywhere in the article.
  function ensurePillElement(article) {
    let pill = article.querySelector(SELECTORS.pill);
    if (!pill) {
      const textEl = article.querySelector(SELECTORS.tweetText);
      if (!textEl) return null;
      pill = document.createElement("span");
      pill.dataset.jevxPill = "true";
      pill.setAttribute("dir", "ltr"); // tweet text may be RTL; the pill is not
      pill.addEventListener("click", onPillClick);
      for (const type of ["keydown", "keyup", "keypress"]) pill.addEventListener(type, (event) => event.stopPropagation());
      textEl.insertAdjacentElement("afterend", pill);
    }
    return pill;
  }

  function onPillClick(event) {
    event.stopPropagation();
    const container = event.currentTarget;
    if (!event.target.closest(".jevx-pill--state")) return;
    event.preventDefault();
    const tweetId = container.dataset.jevxTweet;
    if (!tweetId) return;
    if (expandedIds.has(tweetId)) expandedIds.delete(tweetId);
    else expandedIds.add(tweetId);
    scanArticles();
  }

  function ensureLoadingPill(article) {
    const pill = ensurePillElement(article);
    if (!pill) return;
    delete pill.dataset.jevxSig;
    setPill(pill, `${PILL_BASE_CLASS} ${LOADING_CLASS}`, "Analyzing…", "Waiting for a TypeSafe Jev classification…");
    setFlag(article, pill, false);
  }

  // "Pricing Concern" -> "Pricing concern"; keeps "Prefers A", "TV".
  function sentenceCase(name) {
    return name
      .split(" ")
      .map((word, i) => (i === 0 || word.length === 1 || word === word.toUpperCase() ? word : word.toLowerCase()))
      .join(" ");
  }

  function stateName(matrixId, id) {
    if (id === UNCLEAR) return "Unclear";
    const state = TAXONOMY.subcategory(matrixId).states.find((s) => s.id === id);
    return state ? sentenceCase(state.name) : id;
  }

  // Color slot of a state: its position in the matrix (Other and Unclear
  // have their own neutral swatches).
  function slotOf(matrixId, id) {
    if (id === UNCLEAR || id === "other") return id;
    const states = TAXONOMY.subcategory(matrixId).states.filter((s) => s.id !== "other");
    const index = states.findIndex((s) => s.id === id);
    return index >= 0 && index < MAX_COLOR_SLOTS ? `s${index + 1}` : "other";
  }

  function swatch(matrixId, id) {
    const el = document.createElement("span");
    el.className = `jevx-swatch jevx-swatch--${slotOf(matrixId, id)}`;
    el.setAttribute("aria-hidden", "true");
    return el;
  }

  // The pill shows the primary state and its probability (not measured
  // accuracy, not Jev's confidence statistic). Low certainty gets a dotted
  // border; below the low tier the pill says Unclear instead of forcing a
  // label. Expanded, it adds the secondary state and the universal signals.
  function ensureResultPill(article, tweetId, result, entry) {
    const pill = ensurePillElement(article);
    if (!pill) return;
    const { matrixId, primaryState } = result;
    const tier = tierOf(primaryState);
    const secondary = secondaryStateOf(result);
    const expanded = expandedIds.has(tweetId);
    const label = `${stateName(matrixId, entry.primary)} · ${percent(primaryState.probability)}%`;
    const details = expanded ? detailLines(result, entry, secondary) : [];
    const slop = hasSlop(result) ? slopDisplay(result.slop) : null;
    const signature = JSON.stringify([matrixId, entry.primary, tier, label, expanded, details, slop]);
    if (pill.className !== "jevx-reply") pill.className = "jevx-reply";
    if (pill.dataset.jevxTweet !== tweetId) pill.dataset.jevxTweet = tweetId;
    if (pill.title) pill.title = "";
    if (pill.dataset.jevxSig !== signature) {
      pill.dataset.jevxSig = signature;
      const button = document.createElement("button");
      button.type = "button";
      button.className = `${PILL_BASE_CLASS} jevx-pill--state jevx-pill--${tier}`;
      button.setAttribute("aria-expanded", String(expanded));
      button.append(swatch(matrixId, entry.primary), document.createTextNode(label));
      const children = [button];
      // The score sits right of the state pill; the details panel below
      // takes the whole row (flex-basis: 100%), so it stays last.
      if (slop) children.push(updateSlopPill(slopPillElement(), result.slop, "the reply"));
      if (expanded) {
        const panel = document.createElement("span");
        panel.className = "jevx-details";
        for (const line of details) {
          const row = document.createElement("span");
          row.className = "jevx-details__row";
          if (line.state) row.append(swatch(matrixId, line.state));
          row.append(document.createTextNode(line.text));
          panel.append(row);
        }
        children.push(panel);
      }
      pill.replaceChildren(...children);
    }
    const button = pill.firstElementChild;
    const title = buildTooltip(result, tier, secondary);
    if (button.title !== title) button.title = title;
    setFlag(article, pill, meetsCutoff(result.needsAttention.probability), result);
  }

  function detailLines(result, entry, secondary) {
    const { matrixId, stance, tone, relevance, constructive } = result;
    const lines = [];
    if (secondary) lines.push({ state: secondary.id, text: `${stateName(matrixId, secondary.id)} · ${percent(secondary.probability)}%` });
    lines.push({
      text:
        entry.stance === UNCLEAR
          ? `Unclear stance · ${percent(stance.probability)}%`
          : `${STANCE_NAMES[stance.label]} stance · ${percent(stance.probability)}%`,
    });
    lines.push({ text: `${TONE_NAMES[tone.label]} tone · ${RELEVANCE_NAMES[relevance.label]}` });
    lines.push({ text: `${constructive.probability >= 0.5 ? "Constructive" : "Not constructive"} · ${percent(constructive.probability)}%` });
    return lines;
  }

  // Where the flag goes: before the first control of the header's action
  // group (Grok, then More), found by climbing from the More button until
  // the ancestor holds more than one button. Falls back to after the state
  // pill when X's header isn't recognized.
  function flagAnchor(article) {
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

  function setFlag(article, pill, show, result) {
    let flag = article.querySelector(SELECTORS.flag);
    if (!show) {
      if (flag) flag.remove();
      return;
    }
    if (!flag) {
      flag = document.createElement("span");
      flag.dataset.jevxFlag = "true";
      flag.setAttribute("dir", "ltr");
      const anchor = flagAnchor(article);
      if (anchor) anchor.insertAdjacentElement("beforebegin", flag);
      else pill.insertAdjacentElement("afterend", flag);
    }
    setPill(
      flag,
      `${PILL_BASE_CLASS} ${PILL_BASE_CLASS}--needs-reply`,
      "Needs attention",
      `Worth responding to: ${percent(result.needsAttention.probability)}% probability it contains a meaningful question, criticism, bug report, or request (cutoff ${currentCutoff()}%).`
    );
  }

  // The top options of a choice, most likely first.
  function formatTop(choice, nameOf, count = 3) {
    return Object.entries(choice.probabilities)
      .sort((a, b) => b[1] - a[1])
      .slice(0, count)
      .map(([label, probability]) => `${nameOf(label)} ${percent(probability)}%`)
      .join(" · ");
  }

  function buildTooltip(result, tier, secondary) {
    const { matrixId, primaryState, stance, tone, relevance } = result;
    const also = Object.entries(result.stateSignals)
      .filter(([id, probability]) => id !== primaryState.label && probability >= 0.5)
      .sort((a, b) => b[1] - a[1])
      .map(([id, probability]) => `${stateName(matrixId, id)} ${percent(probability)}%`);
    const certainty = Math.min(primaryState.probability, primaryState.confidence).toFixed(2);
    return [
      `Main intent: ${formatTop(primaryState, (id) => stateName(matrixId, id))}`,
      tier === UNCLEAR
        ? `Jev is unsure (certainty ${certainty} < ${CERTAINTY_TIERS[CERTAINTY_TIERS.length - 1][0]}), so this counts as Unclear.`
        : `${percent(primaryState.probability)}% is the model's probability for this option, not measured accuracy. Certainty: ${tier} (${certainty}).`,
      also.length > 0 ? `Also present (yes/no): ${also.join(" · ")}` : "No other intent is likely.",
      secondary ? `Secondary: ${stateName(matrixId, secondary.id)}` : null,
      `Stance: ${formatTop(stance, (id) => STANCE_NAMES[id])}`,
      `Tone: ${formatTop(tone, (id) => TONE_NAMES[id], 2)} · ${RELEVANCE_NAMES[relevance.label]} (${relevance.score.toFixed(1)} of 2)`,
      `Constructive: ${percent(result.constructive.probability)}% · Needs attention: ${percent(result.needsAttention.probability)}% (flagged at ${currentCutoff()}%+)`,
      `${Math.round(result.latencyMs || 0)} ms · ${result.cached ? "cached" : "live"} · Model: ${result.model || MODEL}`,
      "Click to show or hide details.",
    ]
      .filter(Boolean)
      .join("\n");
  }

  function removeLoadingPill(article) {
    const pill = article && article.querySelector(SELECTORS.pill);
    if (pill && pill.classList.contains(LOADING_CLASS)) pill.remove();
  }

  function removePill(article) {
    for (const el of article.querySelectorAll(`${SELECTORS.pill}, ${SELECTORS.flag}`)) el.remove();
  }

  function removePulse(article) {
    const pulse = article.querySelector(SELECTORS.pulse);
    if (pulse) pulse.remove();
  }

  /* ---------------------------------------------------------------- *
   * Conversation Pulse + filters
   *
   * Aggregated from pulseEntries (unique reply ids with a result against the
   * current original post): excludes the original itself, the original
   * author's own replies, promoted posts, thread ancestors, unrelated
   * recommendations, and pending or failed replies. The breakdown counts
   * each reply once, by its primary state. The filter chips are built from
   * the thread's reply matrix; a chip matches a reply whose primary OR
   * secondary state it names, several chips combine with OR, and the Needs
   * attention toggle narrows any of them. Filtering only re-reconciles what
   * is already on the page; it never sends a request.
   * ---------------------------------------------------------------- */

  // Whole percentages that always total 100 (largest remainder).
  function toPercentages(counts, keys, total) {
    const exact = keys.map((key) => ((counts[key] || 0) * 100) / total);
    const rounded = exact.map(Math.floor);
    let missing = 100 - rounded.reduce((a, b) => a + b, 0);
    const byRemainder = exact.map((value, i) => [value - rounded[i], i]).sort((a, b) => b[0] - a[0]);
    for (const [, i] of byRemainder) {
      if (missing <= 0) break;
      rounded[i] += 1;
      missing -= 1;
    }
    return Object.fromEntries(keys.map((key, i) => [key, rounded[i]]));
  }

  function onFilterClick(filter) {
    if (filter === "all") {
      if (selectedStates.size === 0) return;
      selectedStates = new Set();
    } else if (filter === "needs") {
      needsOnly = !needsOnly;
    } else {
      const matrixId = currentMatrixId();
      if (!matrixId || !TAXONOMY.subcategory(matrixId).states.some((state) => state.id === filter)) return;
      if (selectedStates.has(filter)) selectedStates.delete(filter);
      else selectedStates.add(filter);
    }
    scanArticles(true); // synchronous: the page starts updating in the same frame
  }

  // Display-only: re-evaluates results already on hand, never sends requests.
  function setThreadCutoff(value) {
    if (!isValidCutoff(value)) return;
    threadCutoff = value === globalCutoff ? null : value;
    scanArticles(true);
  }

  function element(tag, className) {
    const el = document.createElement(tag);
    el.className = className;
    return el;
  }

  // A chip's label and count live in their own spans so renders only touch text.
  function chipButton(filter, title, className = "jevx-filter") {
    const button = element("button", className);
    button.type = "button";
    button.dataset.filter = filter;
    button.title = title;
    button.append(element("span", "jevx-filter__label"), element("span", "jevx-filter__count"));
    return button;
  }

  function chevron() {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "jevx-chevron");
    svg.setAttribute("viewBox", "0 0 12 12");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", "M3 4.5 6 7.5 9 4.5");
    svg.append(path);
    return svg;
  }

  /*
   * Layout: a one-line head (brand, post type, reply count, Details toggle),
   * the breakdown bar and legend, and the filter row. Post details, stance,
   * the per-thread cutoff and the caveat sit in a collapsible panel.
   */
  function buildPulse() {
    const pulse = element("div", "jevx-pulse");
    pulse.dataset.jevxPulse = "true";
    pulse.setAttribute("role", "region");
    pulse.setAttribute("aria-label", "Jev conversation pulse");
    pulse.setAttribute("dir", "ltr");
    const detailsId = `jevx-pulse-details-${++pulseSeq}`;

    const head = element("div", "jevx-pulse__head");
    const brand = element("span", "jevx-pulse__brand");
    brand.textContent = "Jev";
    const type = element("span", "jevx-pulse__type");
    // The original post's AI-slop score, right of the post-type pill.
    const slop = slopPillElement("jevx-pulse__slop");
    const summary = element("p", "jevx-pulse__summary");
    summary.setAttribute("aria-live", "polite");
    const toggle = element("button", "jevx-pulse__toggle");
    toggle.type = "button";
    toggle.dataset.action = "details";
    toggle.setAttribute("aria-controls", detailsId);
    toggle.append(document.createTextNode("Details"), chevron());
    head.append(brand, type, slop, summary, toggle);

    const bar = element("div", "jevx-pulse__bar");
    bar.setAttribute("aria-hidden", "true"); // the legend below carries the same numbers as text
    const legend = element("ul", "jevx-legend");
    legend.setAttribute("aria-label", "Replies by main intent");

    const controls = element("div", "jevx-pulse__controls");
    const filters = element("div", "jevx-filters");
    filters.setAttribute("role", "group");
    filters.setAttribute("aria-label", "Show replies by intent");
    // The Needs attention toggle: independent of the intent chips, and
    // combinable with them. Its cutoff is in the details panel.
    const needs = chipButton("needs", "", "jevx-filter jevx-filter--toggle");
    controls.append(filters, needs);

    // Collapsible panel. The outer grid animates its row from 0fr to 1fr;
    // the clip hides the overflow while it does.
    const details = element("div", "jevx-pulse__details");
    details.id = detailsId;
    const clip = element("div", "jevx-pulse__clip");
    const panel = element("div", "jevx-pulse__panel");
    const facts = element("dl", "jevx-facts");
    const row = element("div", "jevx-pulse__row");
    const stance = element("p", "jevx-pulse__stance");
    const stanceLabel = element("span", "jevx-pulse__label");
    stanceLabel.textContent = "Stance";
    stance.append(stanceLabel, element("span", "jevx-pulse__stance-values"));
    const cutoff = element("label", "jevx-cutoff");
    const cutoffText = document.createElement("span");
    cutoffText.textContent = "Needs attention at ≥";
    const select = element("select", "jevx-cutoff__select");
    select.title = "Needs attention cutoff for this thread. The default is set in the jevx popup.";
    for (const value of CUTOFF_CHOICES) {
      const option = document.createElement("option");
      option.value = String(value);
      option.textContent = `${value}%`;
      select.append(option);
    }
    select.addEventListener("change", () => setThreadCutoff(Number(select.value)));
    cutoff.append(cutoffText, select);
    row.append(stance, cutoff);
    const note = element("p", "jevx-pulse__note");
    panel.append(facts, row, note);
    clip.append(panel);
    details.append(clip);

    pulse.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-filter], button[data-action]");
      if (!button) return;
      if (button.dataset.action === "details") {
        pulseDetailsOpen = !pulseDetailsOpen;
        applyPulseDisclosure(pulse);
      } else if (button.dataset.action === "more") {
        pulseChipsExpanded = !pulseChipsExpanded;
        applyPulseDisclosure(pulse);
      } else {
        onFilterClick(button.dataset.filter);
      }
    });
    // Keep clicks and keys inside the Pulse: X handles clicks on articles and
    // has global keyboard shortcuts that would otherwise also fire.
    for (const type of ["click", "keydown", "keyup", "keypress"]) {
      pulse.addEventListener(type, (event) => event.stopPropagation());
    }
    pulse.append(head, bar, legend, controls, details);
    applyPulseDisclosure(pulse);
    return pulse;
  }

  // Details panel and the tucked-away chips. Chips that match no reply yet
  // (and aren't selected) are marked data-jevx-empty by renderPulse; they
  // show only while the chip row is expanded.
  function applyPulseDisclosure(pulse) {
    const state = pulseDetailsOpen ? "open" : "closed";
    if (pulse.dataset.jevxDetails !== state) pulse.dataset.jevxDetails = state;
    const toggle = pulse.querySelector(".jevx-pulse__toggle");
    if (toggle.getAttribute("aria-expanded") !== String(pulseDetailsOpen)) {
      toggle.setAttribute("aria-expanded", String(pulseDetailsOpen));
    }
    const details = pulse.querySelector(".jevx-pulse__details");
    if (details.inert === pulseDetailsOpen) details.inert = !pulseDetailsOpen; // closed: out of the tab order and the a11y tree

    const filters = pulse.querySelector(".jevx-filters");
    const more = filters.querySelector("button[data-action='more']");
    if (!more) return;
    const tucked = filters.querySelectorAll("button[data-jevx-empty]").length;
    const expanded = pulseChipsExpanded && tucked > 0;
    if (filters.hasAttribute("data-jevx-expanded") !== expanded) filters.toggleAttribute("data-jevx-expanded", expanded);
    setHiddenAttr(more, tucked === 0);
    setText(more, expanded ? "Fewer" : `+${tucked} more`);
    more.title = expanded ? "Hide the intents no reply matches yet" : "Intents no reply matches yet";
    if (more.getAttribute("aria-expanded") !== String(expanded)) more.setAttribute("aria-expanded", String(expanded));
  }

  const setHiddenAttr = (el, hidden) => {
    if (el.hidden !== hidden) el.hidden = hidden;
  };

  // Rebuilds an element's children only when what they show changed.
  function rebuildIfChanged(el, signature, build) {
    if (el.dataset.jevxSig === signature) return;
    el.dataset.jevxSig = signature;
    el.replaceChildren(...build());
  }

  function renderPulse(original) {
    if (!context) return;
    let pulse = original.querySelector(SELECTORS.pulse);
    if (!pulse) {
      pulse = buildPulse();
      const textEl = original.querySelector(SELECTORS.tweetText);
      if (textEl) textEl.insertAdjacentElement("afterend", pulse);
      else (original.firstElementChild || original).append(pulse);
    }
    const part = (name) => pulse.querySelector(`.jevx-${name}`);
    const type = part("pulse__type");
    const slop = part("pulse__slop");
    const summary = part("pulse__summary");
    const toggle = part("pulse__toggle");
    const bar = part("pulse__bar");
    const legend = part("legend");
    const controls = part("pulse__controls");
    const filters = part("filters");
    const details = part("pulse__details");
    const facts = part("facts");
    const stanceLine = part("pulse__stance");
    const note = part("pulse__note");
    const cutoff = part("cutoff");

    const matrixId = currentMatrixId();
    const idle = context.status === "no_text" || !matrixId;
    pulse.toggleAttribute("data-jevx-idle", idle);
    for (const el of [type, slop, toggle, controls, details]) setHiddenAttr(el, idle);
    if (idle) {
      if (context.status === "no_text") {
        setText(summary, "Replies can't be analyzed: this post has no text to compare them against.");
      } else {
        setText(summary, halted ? "Paused: check the jevx popup." : "Reading the post…");
      }
      summary.removeAttribute("title");
      for (const el of [bar, legend]) setHiddenAttr(el, true);
      return;
    }

    const subcategory = TAXONOMY.subcategory(matrixId);
    const threadResult = thread.status === "ready" ? thread.result : null;
    const category = TAXONOMY.category(threadResult ? threadResult.categoryId : subcategory.category);
    const fallback = !!(threadResult && threadResult.fallback);
    setText(type, fallback ? category.name : subcategory.name);
    type.title = fallback
      ? `${category.name}: post type unclear, replies use the ${subcategory.name} states`
      : `${category.name} › ${subcategory.name}`;

    const showSlop = hasSlop(threadResult);
    setHiddenAttr(slop, !showSlop);
    if (showSlop) updateSlopPill(slop, threadResult.slop, "the post");

    const postType = !threadResult
      ? `Unavailable, using ${subcategory.name} states`
      : fallback
        ? `Unclear, using ${subcategory.name} states`
        : subcategory.name;
    const factRows = [
      ["Category", category.name],
      ["Post type", postType],
      ...(threadResult
        ? [
            ["Conversation", CONVERSATION_TYPE_NAMES[threadResult.conversationType.label]],
            ["Tone", THREAD_TONE_NAMES[threadResult.tone.label]],
          ]
        : []),
      ...(showSlop
        ? [["AI slop score", `${slopDisplay(threadResult.slop).value} of 10 · ${slopDisplay(threadResult.slop).name}`]]
        : []),
    ];
    rebuildIfChanged(facts, JSON.stringify(factRows), () =>
      factRows.map(([label, value]) => {
        const item = element("div", "jevx-facts__item");
        const dt = document.createElement("dt");
        dt.textContent = label;
        const dd = document.createElement("dd");
        dd.textContent = value;
        item.append(dt, dd);
        return item;
      })
    );

    const buckets = [...subcategory.states.map((state) => state.id), UNCLEAR];
    const counts = {};
    const stanceCounts = {};
    const chipCounts = {};
    let needsCount = 0;
    for (const entry of pulseEntries.values()) {
      counts[entry.primary] = (counts[entry.primary] || 0) + 1;
      stanceCounts[entry.stance] = (stanceCounts[entry.stance] || 0) + 1;
      for (const id of new Set([entry.primary, entry.secondary])) if (id) chipCounts[id] = (chipCounts[id] || 0) + 1;
      if (meetsCutoff(entry.needs)) needsCount += 1;
    }
    const total = pulseEntries.size;
    const pending = queuedKeys.size + inflightKeys.size;
    const progress = halted ? "Paused" : pending > 0 ? `${pending} analyzing` : null;
    const summaryText = [
      total > 0 ? `${total} ${total === 1 ? "reply" : "replies"} analyzed` : pending > 0 ? "Analyzing replies…" : "No replies analyzed yet",
      total > 0 || halted ? progress : null,
    ]
      .filter(Boolean)
      .join(" · ");
    setText(summary, summaryText);
    if (halted) summary.title = "Paused: check the jevx popup.";
    else summary.removeAttribute("title");

    const pct = total > 0 ? toPercentages(counts, buckets, total) : {};
    const shown = buckets.filter((id) => counts[id] > 0);
    rebuildIfChanged(bar, JSON.stringify([matrixId, shown.map((id) => [id, pct[id]])]), () =>
      shown.map((id) => {
        const segment = element("span", `jevx-pulse__segment jevx-swatch--${slotOf(matrixId, id)}`);
        segment.style.width = `${pct[id]}%`;
        return segment;
      })
    );
    rebuildIfChanged(legend, JSON.stringify([matrixId, shown.map((id) => [id, pct[id]])]), () =>
      shown.map((id) => {
        const item = element("li", "jevx-legend__item");
        const value = element("b", "jevx-legend__pct");
        value.textContent = `${pct[id]}%`;
        const label = document.createElement("span");
        label.append(value, ` ${stateName(matrixId, id)}`);
        item.append(swatch(matrixId, id), label);
        return item;
      })
    );
    const stanceKeys = Object.keys(STANCE_NAMES);
    const stancePct = total > 0 ? toPercentages(stanceCounts, stanceKeys, total) : {};
    setText(
      stanceLine.lastElementChild,
      stanceKeys
        .filter((id) => stanceCounts[id] > 0)
        .map((id) => `${STANCE_NAMES[id]} ${stancePct[id]}%`)
        .join(" · ")
    );
    for (const el of [bar, legend, stanceLine]) setHiddenAttr(el, total === 0);

    let noteText = "Based on replies analyzed so far, not the whole conversation.";
    if (halted) noteText += " Paused: check the jevx popup.";
    else if (pending > 0) noteText += ` ${pending} analyzing.`;
    setText(note, noteText);

    const select = cutoff.querySelector("select");
    const selected = String(currentCutoff());
    if (select.value !== selected) select.value = selected; // a property, not a DOM mutation

    // A chip for every state of the matrix except Other, then the toggle for
    // the chips that match no reply yet.
    const chipIds = subcategory.states.map((state) => state.id).filter((id) => id !== "other");
    rebuildIfChanged(filters, matrixId, () => {
      const more = element("button", "jevx-filter jevx-filter--more");
      more.type = "button";
      more.dataset.action = "more";
      return [
        chipButton("all", "Replies of every kind"),
        ...chipIds.map((id) => {
          const chip = chipButton(id, "Main or secondary intent. Select several to combine them.");
          chip.prepend(swatch(matrixId, id));
          return chip;
        }),
        more,
      ];
    });
    for (const button of pulse.querySelectorAll("button[data-filter]")) {
      const filter = button.dataset.filter;
      let label;
      let count;
      let pressed;
      if (filter === "all") {
        label = "All";
        count = total;
        pressed = selectedStates.size === 0;
      } else if (filter === "needs") {
        label = "Needs attention";
        count = needsCount;
        pressed = needsOnly;
        button.title = `Only replies at or above the ${currentCutoff()}% Needs attention cutoff. Combines with the intent filters.`;
      } else {
        label = stateName(matrixId, filter);
        count = chipCounts[filter] || 0;
        pressed = selectedStates.has(filter);
        button.toggleAttribute("data-jevx-empty", count === 0 && !pressed);
      }
      setText(button.querySelector(".jevx-filter__label"), label);
      setText(button.querySelector(".jevx-filter__count"), String(count));
      if (button.getAttribute("aria-pressed") !== String(pressed)) button.setAttribute("aria-pressed", String(pressed));
    }
    applyPulseDisclosure(pulse);
  }

  /* ---------------------------------------------------------------- *
   * Boot
   * ---------------------------------------------------------------- */

  function applyPageSettings(settings) {
    if (isValidCutoff(settings.needsReplyCutoff)) globalCutoff = settings.needsReplyCutoff;
    if (typeof settings.conversationEnabled === "boolean") modeEnabled = settings.conversationEnabled;
    // Display-only: nothing is re-requested, the next scan adds or drops the
    // score pills on replies that are already classified.
    if (typeof settings.slopEnabled === "boolean") slopEnabled = settings.slopEnabled;
  }

  // The on/off switch and the default cutoff live in extension storage,
  // which X pages can't read. Retried while unanswered: until then this
  // mode stays inactive.
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
      scheduleScan(0);
    });
  }

  chrome.runtime.onMessage.addListener(onServiceWorkerMessage);
  checkRoute();
  setInterval(checkRoute, ROUTE_CHECK_INTERVAL_MS);
})();
