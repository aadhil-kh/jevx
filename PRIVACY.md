# Privacy Policy: jevx

_Last updated: 2026-09-19_

This extension reads visible website/user-generated content and sends tweet text to a third-party service to provide its feature. Even though the developer has no backend and receives none of the data, the extension transmits website/user-generated content to TypeSafe AI.

## What is read

- **What:** tweet texts, up to 10,000 characters each, in two modes:
  - **Timeline mode** (Home, Following, search results, profiles, lists, bookmarks — every X page except tweet-detail pages): **once per post**, the post's text, to label it with its category and subcategory and to score how much it reads as AI slop. For a quote post with its own commentary, the quoted post's text is included too, as context for classifying the outer post.
  - **Status (tweet-detail) pages**, two kinds of request (quoted tweets are excluded here):
    - **once per original post:** the original post's text, to classify what kind of post it is (category, subcategory, conversation type, tone, AI slop score) — the same request, and the same cached result, as timeline mode uses;
    - **once per reply:** the reply's text, **the original post's text**, and the names of the post's category and subcategory (for example "Product & Startup", "Product Launch"), so the original post's text is sent again with every reply.

  Tweet IDs are used locally and are not sent to TypeSafe.
- **Which tweets:** in timeline mode, each textual post once it is on screen **or within about 800 px above or below the visible area** — including posts you scroll past without reading. Promoted posts (ads) and media-only posts are not sent, nor are text-only posts shorter than 12 characters. For a post with an image, video or link card, only its text is sent, whatever its length; the media itself is never sent. On status pages: the original post as soon as its text is on the page, and each textual reply in that same near-viewport range. Replies near the viewport are sent even if you never scroll to them. While a filter hides replies, they take no space, so more replies come into that range (and X may load more of the conversation) than with no filter active. The original post's text is sent (as context) even if the original is scrolled off screen. Posts shown above the original (earlier posts in a thread), recommended posts below the replies ("Discover more"), and the original author's own replies are not sent. If the original post has no text, nothing is sent for that thread.
- **When:** only when that mode is switched on in the popup (timelines and tweet pages have separate switches), a TypeSafe API key is saved, and posts are being browsed on X. Timeline mode classifies as you scroll, so browsing X sends post texts steadily rather than only when you open a tweet.
- **Save & Test:** verifying a key sends one fixed example post and reply (not tweet content) to TypeSafe.
- **Why:** labeling each timeline post with its category, and, on tweet pages, choosing a set of reply labels that fits the conversation then classifying each reply against the original post: its main intent and any secondary intents from that set (for example Feature request, Pricing concern), its stance, tone, relevance and constructiveness, whether it needs the author's attention, and how much it reads as AI slop rather than genuine human writing.
- **Conversation Pulse, filters, the AI slop pill and expanded pill details:** computed entirely in the page from results already received. They send nothing and store nothing. The AI slop question is part of the two requests above, so switching its pill off in the popup changes only what is shown — the same text is sent and the same result is cached either way.
- **Recipient:** TypeSafe AI (`api.typesafe.ai`), over HTTPS.
- **Developer server:** none.
- **Developer telemetry/analytics:** none.
- **Developer data retention:** none. The developer never receives any data.

## What is stored

- **API key, how it is stored:** the TypeSafe API key is authentication information and is treated as sensitive. It is used only to authenticate to TypeSafe and is never sent to X or to the developer. It is saved in two parts, both inside your Chrome profile directory on disk:
  - an AES-GCM ciphertext of the key, in `chrome.storage.local`;
  - the AES key that decrypts it, stored as a non-extractable Web Crypto `CryptoKey` in the extension's IndexedDB.
- **What "non-extractable" means:** the Web Crypto API will not export the raw AES key bytes to JavaScript, including to this extension's own code. It is **not** a promise about where the bytes are kept: Chrome stores them in the profile's IndexedDB data, and the extension does not rely on, or claim, OS key-store (e.g. Keychain) protection.
- **What that protects against, and what it does not:** the plaintext key never appears in `chrome.storage.local`, so tools or people inspecting extension storage see only ciphertext. Because the decryption key sits in the same profile, anyone who can read the whole profile directory (for example, malware running as your user account, or a copied profile or backup) can in principle recover the API key. Treat this as keeping the key out of plain view, not as a vault.
- **At runtime:** after it is unlocked, the plaintext key is kept in `chrome.storage.session`, which Chrome holds in memory rather than writing to extension storage on disk. It is available only to trusted extension contexts (the service worker and popup), never to the X content script or the page. Like any in-memory data, it could still reach disk through OS swap, hibernation, or crash dumps; the extension cannot prevent that.
- **API key lifetime:** the key persists across Chrome restarts until it is cleared via the popup (**Clear key**) or the extension is uninstalled.
- **Settings:** the on/off switch for each mode (timelines, tweet pages), the "AI slop score" display switch, the default "Needs attention" cutoff, and the last error code, in `chrome.storage.local`. The two mode switches, the slop switch and the cutoff are the only settings X pages can read, and they can't change them. A per-thread cutoff chosen in the Pulse is kept in the page's memory only.
- **Classification cache:** in `chrome.storage.local`, kept for **up to 7 days** (at most 500 entries, oldest dropped first). A post entry holds the post's tweet ID, a fingerprint (non-cryptographic hash) of its text, its classification (category, subcategory, conversation type, tone, AI slop score) and the time it was cached; entries are created by timeline mode and by status pages alike (a quote post has separate entries for its two text versions). A reply entry holds the original post's tweet ID and text fingerprint, the reply-label set used, the reply's tweet ID and a fingerprint of its text, the classification result, and the time it was cached. It never stores tweet text or the API key, but the tweet IDs do reveal which tweets were classified in this browser during that period. Each open X tab also keeps its results in memory (the timeline caps this at 500 posts) until the tab is closed or reloaded.

## Deletion

- **Clear key** (popup) removes every copy of the API key: the in-memory plaintext, the encrypted-at-rest record, and the encryption key material itself.
- **Clear cached classifications** (popup) removes the persistent result cache and the in-memory results of open X tabs. Requests already in flight are not written back to the cache.
- Clearing extension storage or uninstalling the extension removes all applicable local extension data.

## Third-party handling

TypeSafe's own handling of requests is governed by TypeSafe's current policies and terms.

## Contact

This is an open-source demo extension. See the repository's README for source and license details.
