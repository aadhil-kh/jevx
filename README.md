# jevx

**Jev for X** is a Chrome extension that adds live semantic classification to X.

It categorizes posts in your timeline and understands replies in the context of the original post using [TypeSafe Jev](https://typesafe.ai).

## What it does

### Timeline categories

As you browse X, textual posts are automatically categorized with a small semantic label.

Examples:

- Technical Opinion
- Product Launch
- AI Model Release
- Technical Question
- Breaking News
- Career Advice

The label appears directly in the post header.

### Context-aware reply classification

On tweet detail pages, jevx first understands what kind of post you're reading.

It then chooses a reply taxonomy appropriate for that conversation.

For example:

**Product Launch**

- Praise
- Question
- Feature Request
- Pricing Concern
- Criticism
- Competitor Comparison

**Technical Opinion**

- Agree
- Disagree
- Counterargument
- Alternative
- Evidence
- Question

**Bug Report**

- Confirms Bug
- Cannot Reproduce
- Workaround
- Fix Suggestion
- Needs More Details

Replies are classified relative to the original post rather than in isolation.

### Conversation Pulse

jevx summarizes the replies analyzed so far into a compact Conversation Pulse.

It shows:

- reply-category distribution
- stance distribution
- replies analyzed
- semantic reply filters
- replies that may need the author's attention

Everything in the Pulse is computed locally from classifications already returned by Jev.

### Reply filters

Filter a conversation by semantic reply type.

For example:

- Questions
- Feature Requests
- Counterarguments
- Pricing Concerns
- Bug Reports

Multiple categories can be selected together.

You can also combine them with **Needs attention** to find replies that may be worth responding to.

## How it works

jevx uses a predefined:

```text
Category
  -> Subcategory
    -> Reply matrix
```

For example:

```text
Product & Startup
  -> Product Launch
    -> Praise
    -> Question
    -> Feature Request
    -> Pricing Concern
    -> Criticism
    -> Competitor Comparison
```

The taxonomy belongs to the extension.

Jev chooses between those predefined options instead of generating arbitrary labels.

For each original post, jevx determines:

- category
- subcategory
- conversation type
- tone

The result is cached and reused when possible.

Each reply is then analyzed against the reply matrix associated with that post type.

A reply can also include additional signals such as:

- stance
- tone
- relevance
- constructiveness
- whether it may need attention

## Install

jevx currently runs as an unpacked Chrome extension.

1. Clone or download this repository.
2. Open:

   ```text
   chrome://extensions
   ```

3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select the repository folder.
6. Open the jevx extension popup.
7. Enter your TypeSafe API key.
8. Click **Save & Test**.
9. Open [x.com](https://x.com).

No build step is required.

## TypeSafe API key

jevx uses a bring-your-own-key model.

You need a TypeSafe API key to use the extension.

The key is handled by the extension service worker and is not exposed to the X page.

There is no jevx backend.

```text
X page
  ↓
Chrome extension
  ↓
TypeSafe Jev
  ↓
Chrome extension
  ↓
UI
```

Tweet text is sent directly from the extension to TypeSafe for classification.

## Privacy

jevx has:

- no developer backend
- no analytics
- no telemetry
- no account system

Classification results are cached locally to reduce unnecessary API calls.

On timeline pages, only posts close to the viewport are analyzed.

On tweet detail pages, the original post and nearby textual replies are analyzed.

Media-only posts are not analyzed.

See [PRIVACY.md](PRIVACY.md) for the full details.

## Performance

Classification happens lazily as posts enter or approach the viewport.

jevx uses:

- `MutationObserver` to detect new X posts
- `IntersectionObserver` to avoid analyzing off-screen content
- bounded request concurrency
- local caching
- tweet-ID deduplication

X frequently re-renders posts while scrolling, so cached classifications are automatically restored without sending another request.

## Timeline and thread integration

Timeline classification and conversation analysis share the same post classification.

For example:

```text
Timeline
  ↓
Developer Tool Release
  ↓
Open post
  ↓
cached classification reused
  ↓
Developer Tool Release reply matrix
```

A post already classified in the timeline does not need to be classified again when its conversation is opened.

## Quote posts

For quote posts in the timeline, jevx uses both:

```text
author commentary
+
quoted post text
```

as classification context.

This helps Jev understand short comments such as:

```text
"This is exactly the problem."
```

when the meaning depends on the quoted post.

## Uncertainty

jevx does not assume every model judgment is correct.

Low-confidence classifications are either shown as uncertain or omitted depending on where they appear.

Percentages shown by the extension are model probabilities, not measured accuracy.

Typed output keeps labels predictable, but semantic classification can still be wrong, especially with:

- sarcasm
- ambiguous language
- adversarial text
- highly context-dependent replies

## Project structure

```text
src/
  taxonomy.js
  content.js
  timeline.js
  service-worker.js

popup/
  ...

test/
  service-worker.test.mjs

PRIVACY.md
manifest.json
```

### `src/taxonomy.js`

Defines the category to subcategory to reply-state taxonomy.

### `src/content.js`

Handles tweet detail pages:

- detects the original post
- analyzes replies
- renders reply labels
- renders Conversation Pulse
- handles reply filtering

### `src/timeline.js`

Handles non-detail X pages:

- Home
- Following
- Search
- Profiles
- Lists
- Bookmarks

It analyzes near-viewport posts and renders their subcategory labels.

### `src/service-worker.js`

Handles:

- TypeSafe API requests
- API-key access
- classification cache
- communication with X content scripts

## Development

There is no framework, bundler, or build step.

Edit the source files and reload the extension from:

```text
chrome://extensions
```

Run the service-worker tests with:

```sh
node test/service-worker.test.mjs
```

## Limitations

- jevx relies on X's current DOM structure rather than an official X API.
- X frontend changes may temporarily break post detection or UI placement.
- Only textual content is classified.
- The Conversation Pulse reflects replies analyzed so far, not necessarily every reply in the full thread.
- Nested replies are currently judged relative to the focused original post rather than their immediate parent reply.
- The built-in taxonomy is intentionally finite and will not perfectly describe every possible post.
- AI classifications can be incorrect.

## Tech

- Chrome Manifest V3
- Vanilla JavaScript
- TypeSafe Jev
- No framework
- No bundler
- No custom backend

## License

[MIT](LICENSE)