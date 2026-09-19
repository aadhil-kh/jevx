# Privacy Policy: jevx

_Last updated: 2026-09-18_

This extension reads visible website/user-generated content and sends tweet text to a third-party service to provide its feature. Even though the developer has no backend and receives none of the data, the extension transmits website/user-generated content to TypeSafe AI.

## What is read

- **What:** visible textual tweets/replies on X status (tweet-detail) pages.
- **When:** only when the extension is enabled, a TypeSafe API key is configured for the current browser session, and an X status page is being viewed. No requests are made on Home, Search, Profile, or any other page.
- **Why:** sentiment classification (positive / neutral / negative).
- **Recipient:** TypeSafe AI (`api.typesafe.ai`), over HTTPS.
- **Developer server:** none.
- **Developer telemetry/analytics:** none.
- **Developer data retention:** none. The developer never receives any data.

## What is stored

- **Session data:** the TypeSafe API key is kept in `chrome.storage.session`. It is authentication information and is treated as sensitive user data. It is used only for TypeSafe authentication and is never sent to X or to the developer.
- **API key lifetime:** intentionally cleared when the Chrome session ends (full browser restart). `chrome.storage` is not an encrypted secret vault, and no stronger claim is made.
- **Persistent local data:** the enabled/disabled setting, small non-sensitive settings, and a small classification-result cache in `chrome.storage.local`.
- **Cache contents:** versioned identifiers/fingerprints and classification results only, never tweet text and never the API key.
- **API key exposure:** the key exists only in trusted extension contexts (service worker and popup). It never reaches the X content script, the page DOM, logs, or anywhere else.

## Deletion

- **Clear key** (popup) removes the stored API key.
- **Clear cached classifications** (popup) removes the result cache.
- Clearing extension storage or uninstalling the extension removes all applicable local extension data.

## Third-party handling

TypeSafe's own handling of requests is governed by TypeSafe's current policies and terms.

## Contact

This is an open-source demo extension. See the repository's README for source and license details.
