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

## Canon dialogue (word-for-word)

Turn on **Canon dialogue (wiki)** and set your main fandom wiki (e.g. `jujutsu-kaisen.fandom.com`). Every turn it:

1. Searches that wiki for the current scene and fetches the top pages plus any `/Quotes` subpages.
2. Pulls the canon lines the wiki records: `{{Quote}}` templates, Quotes sections, and quoted speech in summaries.
3. Injects them with a rule: if the scene matches a canon moment, characters must say those lines word-for-word.

Put the current chapter/episode in **Always include these pages** (or `/canonpin Chapter 12`) so that chapter's lines are always present.

Wikis only record memorable lines, not full scripts, and use one translation. For complete coverage, use the lorebook builder below and add lines you care about yourself.

Set the engine to **None** to use only the wiki (no web search, no API key).

## Crossover roster

For characters or groups from other series (e.g. Akemura Soga or the Shinuchi from Kagurabachi):

1. Enter the name, the wiki (`kagurabachi.fandom.com`), optional aliases (`Soga`), and click **Add from wiki**.
2. The extension pulls their infobox facts, intro, Appearance, Personality and Abilities/Powers (including `/Abilities` subpages) into a profile.
3. Whenever the name or an alias shows up in recent messages, the profile is injected with an instruction to follow it exactly. Tick **always** for a character you're playing.

Click the pen icon to read or fix a profile — whatever is there is exactly what the model sees.

## Canon dialogue lorebook builder

`tools/canon_dialogue_lorebook.py` builds one lorebook entry per chapter/episode with that chapter's recorded canon lines, ready for chapter pinning.

```
pip install requests mwparserfromhell
python tools/canon_dialogue_lorebook.py kagurabachi.fandom.com --category Chapters --title-regex "^Chapter \d+$"
```

- `key[0]` = entry title (`Chapter 12 (Dialogue)`), `key[1]` = page title, `uid` = `displayIndex`, natural order.
- Disabled by default so your pinning tool enables only the current chapter (`--enabled` to ship them on).
- `excludeRecursion` + `preventRecursion` on; group `Canon Dialogue`; order 1, @depth 2 (change with `--order/--position/--depth`).

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
