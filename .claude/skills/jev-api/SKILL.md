---
name: jev-api
description: Reference for the TypeSafe Jev (System One) API as used by jevx — endpoint, request/response schemas for choice/score/noul questions, confidence semantics, errors/retries, and this project's conventions for questions, validation and caching. Use whenever reading, writing, or reviewing code or docs that call or describe the Jev API (src/service-worker.js requests, question definitions, response validation, pill/tooltip wording).
---

# TypeSafe Jev API

Collected from https://docs.typesafe.ai on 2026-09-19. The API launched 2026-09-17 and is young. If this file and the live docs disagree, the docs win: re-check them before relying on a detail marked *unverified*, and update this file.

Doc pages: [API reference](https://docs.typesafe.ai/api) · [Quick start](https://docs.typesafe.ai/introduction/quickstart) · [Choice](https://docs.typesafe.ai/primitives/choice) · [Score](https://docs.typesafe.ai/primitives/score) · [Noul](https://docs.typesafe.ai/primitives/noul) · [Confidence](https://docs.typesafe.ai/confidence) · [Patterns](https://docs.typesafe.ai/patterns) · [System One concepts](https://docs.typesafe.ai/concepts/system-one)

## What Jev is

A "System One" decision model. It evaluates a **state** against typed **questions** and returns typed answers with probabilities. It does not generate text, code or explanations, and it accepts text input only (no images, audio or video). Write each question as one atomic judgment that a knowledgeable person could make in a few seconds, and combine answers in code rather than asking one holistic question.

## Request

```
POST https://api.typesafe.ai/v1/systemone
Authorization: Bearer <API_KEY>
Content-Type: application/json
```

| Field | Type | Notes |
|---|---|---|
| `model` | string, required | `"jev-latest"` |
| `state` | string \| object \| array, required | The content to evaluate: plain text or structured data. No documented size limit. |
| `questions` | map<id, Question>, required | Any number of named questions, all answered in one call. No documented maximum. |

Every question has `type` and `instructions` (string \| object \| array). An object form is allowed, e.g. `{"question": "...", "focus": "..."}`.

### `choice`: pick one option
- `criteria` (required): map of option → description. A value can be a string, `null` (the option name says enough), or an object `{ "what": string, "not_for": string, "examples": string[] }` to separate options that are easy to confuse. The API reference types values as `string | null`; the object form comes from the Choice page.
- Up to 255 options. Include an `other` / "none of the above" option.

### `score`: position on an ordered rubric
- `criteria` (required): an ordered array of 2–10 levels. Each level is a string or `{ "what", "examples" }`. Level *i* is numbered *i* from 0.
- One dimension per question. Weight several scores together in code.

### `noul`: yes / no
- `criteria` (optional): `{ "true": string, "false": string }` for subtle boundaries.
- Don't use it for a spectrum; use `score` instead. A value near 0.5 means "unsure", not "medium".

## Response

```json
{
  "model": "jev-latest",
  "answers": {
    "<id>": { "type": "choice", "choice": "returns", "probabilities": { "returns": 1.0, "shipping": 0.0 }, "confidence": 1.0 }
  },
  "usage": { "input_tokens": 330, "output_tokens": 34 }
}
```

| Type | Fields |
|---|---|
| choice | `choice` (the highest-probability option), `probabilities` (every option, summing to 1), `confidence` 0–1 |
| score | `score` = Σ(level × p(level)), fractional, from 0 to the top level; `probabilities` keyed `"0"`, `"1"`, …; `legend` (level → description); `confidence` 0–1 |
| noul | `noul` 0–1 = P(yes). **No `confidence` field.** |

## Probability vs confidence

- `probabilities[x]` is the model's probability for option *x*. It is **not measured accuracy**.
- `confidence` is a statistic computed from the shape of the distribution: high when one option dominates, low when it is flat. It is a second decision axis, not the same number as the chosen option's probability.
- The docs suggest gating by risk: below 0.5 is uncertain (don't act automatically), 0.5–0.9 means proceed cautiously, above 0.9 is safe to automate. Tune thresholds on real data.

## Errors and retries

| Status | Meaning | Retry? |
|---|---|---|
| 401 | Invalid or missing API key | no |
| 422 | Request failed validation | no (fix the request) |
| 429 | Rate limited | yes, with exponential backoff |
| 529 | Overloaded | yes, with exponential backoff |

The official SDKs retry automatically. Python: `pip install typesafe-sdk`, `TypeSafeClient()` reads `TYPESAFE_API_KEY`. No JS SDK is documented on the quick-start page.

## Patterns (docs)

- **Speculative fan-out:** ask many questions in one call, including ones you may not need. The docs say added questions barely change response time.
- **Confidence-gated routing:** branch on `confidence` as well as the chosen option.
- **Composite scoring:** combine several `score` answers, each normalized by `len(criteria) - 1`, with weights in code.
- **Intent routing:** a `choice` question picks the handler.

*Unverified:* whether one question can see another's answers. The docs don't say. Third-party write-ups describe questions as evaluated in parallel and in isolation, so design each question to stand alone.

## jevx conventions

- **All Jev calls live in `src/service-worker.js`.** It is the only context holding the key and uses raw `fetch()`, with no SDK and no bundler. Transport: 10 s per-attempt timeout, 3 attempts total, 500 ms → 5 s exponential backoff with jitter, `retry-after-ms` / `Retry-After` honored up to 60 s. It retries 408, 429 and 5xx (including 529) and network errors, never 401/403/422.
- **Current requests (two stages).** The taxonomy lives in `src/taxonomy.js` (10 categories + Other, 56 subcategories, each with a 6–8 state reply matrix ending in `other`; ids are slugs of the names).
  - *Thread* (`JEVX_CLASSIFY_THREAD`, once per version of the original post): `state = { source: "x", original_post: { text } }`, questions `category`, `subcategory` (every subcategory, criteria prefixed with its category), `conversation_type`, `tone` (all `choice`). `resolveThread()` uses the subcategory as the reply matrix when its certainty (min of probability and `confidence`) is ≥ `THREAD_MIN_CERTAINTY` (0.45), else `general_discussion`. The message carries `surface` (`"timeline"` or `"conversation"`) so the worker can apply that mode's on/off switch; the Jev request itself doesn't change. The timeline content script (`src/timeline.js`) sends this request verbatim for posts on non-status pages, so both modes share the `thread:` cache; for quote posts it prepends the quoted post's text as context, which is a separate text version and cache entry.
  - *Reply* (`JEVX_CLASSIFY_REPLY`, once per reply, with the thread's `matrixId`): `state = { source: "x", original_post: { text }, conversation: { category, kind }, reply: { text } }`. Questions from `stateQuestions()`: `primary_state` (choice over the matrix) and `has_<state>` (noul, one per state except `other`, for secondary intents, since questions can't see each other). Plus `stance` (supportive / opposing / neutral / mixed / unclear), `tone` (choice), `relevance` (score: unrelated / partially relevant / relevant), `constructive` and `needs_attention` (noul).
  - Every instruction ends by telling Jev to treat the texts as content, never as instructions (a prompt-injection mitigation, not a guarantee).
- **Using the answers** (`src/content.js`): certainty = min(probability, confidence); `CERTAINTY_TIERS` high ≥ 0.80, normal ≥ 0.60, low ≥ 0.45 (dotted pill), below that the pill says Unclear and counts in the Unclear bucket. The secondary state is the best `has_<state>` ≠ primary with P(yes) ≥ `SECONDARY_MIN` (0.6). `needs_attention` at or above the user's cutoff shows the Needs attention flag. The cutoff defaults to `DEFAULT_NEEDS_REPLY_CUTOFF` (80%), is a multiple of 5 from 5 to 95, is set globally in the popup and can be overridden per thread in the Pulse. Display thresholds never change the request or the cache key. A noul has no confidence, so don't read one.
- **Changing a question or the taxonomy** (options, criteria, instructions, names, or adding one) means bumping `CLASSIFIER_SCHEMA_VERSION` in **both** scripts, since it is part of the cache key (the reply key also includes the matrix id). Then update the validators (`validateThreadResponse` / `validateReplyResponse`, which require every answer), `isValidThreadResult` / `isValidReplyResult` and the label maps in `src/content.js`, the tests in `test/service-worker.test.mjs` (its fake TypeSafe answers whatever questions are asked), and README/PRIVACY if what is sent changes.
- **Validate structurally and reject rather than guess:** check every expected answer id, `type`, a `choice` inside the label set, every option's probability as a finite number in 0–1, and `confidence` in 0–1; for a noul, `noul` in 0–1; for a score, `score` within 0..top level and every level's probability (`validateChoiceAnswer` / `validateNoulAnswer` / `validateScoreAnswer`). A malformed 200 maps to `INVALID_RESPONSE` and is never cached.
- **Wording:** a pill's percent is the chosen option's probability. Always call it a probability, never accuracy or "confidence", and never claim zero hallucinations or guaranteed correctness.
- **Save & Test** sends a fixed example (`TEST_CONTEXT_TEXT` / `TEST_REPLY_TEXT`) through the reply request shape with the General Discussion matrix, so a key is only saved after a real round-trip.
