# Always Search for SillyTavern

Runs a web search before **every** AI response and injects the results into the prompt. No trigger words, no function calling — it just always searches.

## How it works

1. You send a message (or swipe/regenerate/continue).
2. **Smart mode:** your connected model writes a short search query from the last few messages. **Raw mode:** your last message is used as the query.
3. The query is sent through SillyTavern's built-in search endpoints.
4. Results (snippets, optionally full page text, plus source links) are injected into the prompt.
5. The reply appears with a small 🔎 line underneath showing the query and sources.

## Install

**Option A — from a folder:** copy the `SillyTavern-AlwaysSearch` folder to
`SillyTavern/public/scripts/extensions/third-party/SillyTavern-AlwaysSearch`, then restart or reload SillyTavern.

**Option B — from Git:** push this folder to a GitHub repo, then in SillyTavern go to Extensions → Install extension and paste the repo URL.

## TauriTavern

Install it the same way: Extensions → Install extension → paste the repo URL.

TauriTavern's built-in backend only supports **SearXNG** search, so:

- **SearXNG (most reliable):** set your instance URL. TauriTavern will ask once to approve that endpoint.
- **Tavily / Serper / Z.AI / SerpApi:** the extension calls the provider's API directly with your key (stored in extension settings). This depends on the provider allowing requests from the app. If you get a "blocked … CORS" error, switch to SearXNG.
- "Read top pages in full" isn't available on TauriTavern (no page-visit route); snippets still work.

## Setup

1. Extensions panel → **Always Search**.
2. Pick an engine. **Tavily** is the easiest: free tier, one key. Get a key at tavily.com and paste it in.
   - SearXNG needs no key but needs a running instance (e.g. `docker run -p 8888:8080 searxng/searxng`; enable the HTML format, which is on by default).
3. Click **Test search** to confirm it works.
4. Chat normally.

If you also have the official **WebSearch** extension installed, disable it (or its triggers) so you don't get double injections.

## Tips

- **Always add to query:** put your franchise here, like `Jujutsu Kaisen wiki` or `site:jujutsu-kaisen.fandom.com`, to keep results canon.
- **Swipes reuse results** by default, so rerolling doesn't spend another search. Toggle "New search on swipe" to change that.
- **Smart mode** costs one small extra model call per turn. Use Raw mode for speed or if your API is pay-per-call.
- **Read top pages in full** gives much richer context but adds a few seconds.
- Slash command: `/alwayssearch on`, `/alwayssearch off`, `/alwayssearch toggle`.
- **Show last injection** shows exactly what was added to the prompt.

## Settings reference

| Setting | Default | Notes |
|---|---|---|
| Position / Depth / Role | In chat, depth 1, System | Depth 1 puts results right above your latest message |
| Snippet budget | 3000 chars | Snippet text only; page text has its own per-page budget |
| Template macros | `{{text}}` `{{query}}` `{{date}}` | Plus all normal ST macros |
| Query prompt macros | `{{transcript}}` | Plus `{{char}}`, `{{user}}`, etc. |
