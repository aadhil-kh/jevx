# jevx

Chrome MV3 extension (no build, no dependencies) that classifies an X post into a category → subcategory (src/taxonomy.js), then labels each reply with TypeSafe Jev using that subcategory's reply states, plus a Conversation Pulse and filters. See README.md for architecture, PRIVACY.md for data handling.

- For anything touching the TypeSafe Jev API (requests, question definitions, response validation, how results are described), use the `jev-api` skill in `.claude/skills/jev-api/SKILL.md` as the reference.
- `src/service-worker.js` owns the API key, TypeSafe requests (questions included), storage and cache; `src/content.js` owns DOM discovery, the queue, reply pills, Pulse and filters on status routes; `src/timeline.js` owns the category pills on every other route, reusing the worker's thread request and cache key verbatim so both modes share cached classifications; `src/taxonomy.js` is the shared taxonomy; `popup/` is BYOK setup.
- Test: `node test/service-worker.test.mjs`. Keep its chrome/IndexedDB stubs faithful to the real APIs.
- Keep `MODEL`, `CLASSIFIER_SCHEMA_VERSION`, `MAX_TEXT_CHARS` and `fingerprintText()` identical in all three scripts, plus `cacheKeyFor()` in content.js and `threadCacheKeyFor()` in timeline.js (the test checks). Bump the schema version when a question or the taxonomy changes.
- Any change to what is sent, stored or how the key is protected must update PRIVACY.md, README.md and the popup text. Never overstate security guarantees.
