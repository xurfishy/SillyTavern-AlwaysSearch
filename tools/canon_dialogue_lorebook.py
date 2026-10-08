#!/usr/bin/env python3
"""
canon_dialogue_lorebook.py — build a per-chapter/episode "Canon Dialogue" lorebook
from a Fandom (or any MediaWiki) wiki, in SillyTavern native format.

For every page in a category (e.g. Category:Chapters), it collects the canon lines
the wiki records — {{Quote}} templates, "Quotes" sections, and sentences in the
summary that contain quoted speech — and writes one entry per chapter.

Entries follow the usual spec:
  * key[0] == canonical entry title ("Chapter 12 (Dialogue)"), key[1] == page title
  * uid == displayIndex, natural chapter order
  * disabled by default, so a canon-pinning tool (or you) enables only the current
    chapter; use --enabled to ship them enabled instead
  * excludeRecursion / preventRecursion on, so dialogue never cross-fires lore

Usage:
  python canon_dialogue_lorebook.py kagurabachi.fandom.com --category Chapters
  python canon_dialogue_lorebook.py jujutsu-kaisen.fandom.com --category Episodes \\
      --title-regex "^Episode \\d+" --out "JJK Anime Dialogue.json"

Requires: pip install requests mwparserfromhell
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import time
from urllib.parse import urlparse

import mwparserfromhell
import requests

UA = "CanonDialogueLorebook/1.0 (personal SillyTavern lorebook builder)"

QUOTE_TPL = re.compile(r"^(c?quote|quotation|dialogue|dialog|quote ?box|blockquote|q)$", re.I)
KEEP_FIRST = re.compile(r"^(nihongo2?|ruby|furigana|scroll(-\d+| box)?|tooltip|abbr|small|big|nowrap|spoiler|translation|tl|j|lang|text)$", re.I)
KEEP_LAST = re.compile(r"^(colou?r|font ?colou?r|fc|highlight|bgcolor)$", re.I)
QUOTE_RE = re.compile(r'["“「『]([^"“”「」『』\n]{6,600})["”」』]')
DIALOGUE_SECTIONS = re.compile(r"quote|dialogue|famous lines|catchphrase", re.I)
SKIP_SECTIONS = re.compile(r"reference|gallery|navigation|external|trivia|see also|credits|characters in order|cast", re.I)


# --------------------------------------------------------------------------- API

def api_endpoint(wiki: str) -> str:
    w = wiki.strip()
    if not re.match(r"^https?://", w, re.I):
        w = "https://" + w
    u = urlparse(w)
    if u.path.endswith("api.php"):
        return f"{u.scheme}://{u.netloc}{u.path}"
    if u.netloc.endswith("fandom.com"):
        m = re.match(r"^/([a-z]{2,3}(?:-[a-z]+)?)/wiki/", u.path, re.I)
        return f"{u.scheme}://{u.netloc}{'/' + m.group(1) if m else ''}/api.php"
    if u.path.startswith("/w/") or u.path.startswith("/wiki/"):
        return f"{u.scheme}://{u.netloc}/w/api.php"
    return f"{u.scheme}://{u.netloc}/api.php"


class Wiki:
    def __init__(self, wiki: str, delay: float = 0.5):
        self.api = api_endpoint(wiki)
        self.s = requests.Session()
        self.s.headers["User-Agent"] = UA
        self.delay = delay

    def get(self, **params):
        params = {"format": "json", "formatversion": "2", "maxlag": "5", **params}
        for attempt in range(5):
            r = self.s.get(self.api, params=params, timeout=60)
            if r.status_code in (429, 503) or "maxlag" in r.text[:200]:
                time.sleep(2 ** attempt)
                continue
            r.raise_for_status()
            data = r.json()
            if "error" in data:
                raise RuntimeError(data["error"].get("info", data["error"]))
            time.sleep(self.delay)
            return data
        raise RuntimeError("wiki API kept rate-limiting; try a larger --delay")

    def category_members(self, category: str) -> list[str]:
        cat = category if category.lower().startswith("category:") else f"Category:{category}"
        out, cont = [], {}
        while True:
            d = self.get(action="query", list="categorymembers", cmtitle=cat,
                         cmlimit="500", cmnamespace="0", **cont)
            out += [m["title"] for m in d["query"]["categorymembers"]]
            if "continue" not in d:
                return out
            cont = {"cmcontinue": d["continue"]["cmcontinue"]}

    def wikitext(self, titles: list[str]) -> dict[str, str]:
        out = {}
        for i in range(0, len(titles), 50):
            batch = titles[i:i + 50]
            d = self.get(action="query", prop="revisions", rvprop="content", rvslots="main",
                         redirects="1", titles="|".join(batch))
            for p in d["query"].get("pages", []):
                if p.get("missing") or p.get("invalid"):
                    continue
                rev = p.get("revisions", [{}])[0]
                text = rev.get("slots", {}).get("main", {}).get("content") or rev.get("content")
                if text:
                    out[p["title"]] = text
            print(f"  fetched {min(i + 50, len(titles))}/{len(titles)}", file=sys.stderr)
        return out


# ---------------------------------------------------------------------- parsing

def _params(tpl):
    pos, named = [], {}
    for p in tpl.params:
        if p.showkey:
            named[str(p.name).strip().lower()] = str(p.value).strip()
        else:
            pos.append(str(p.value).strip())
    return pos, named


def _render_templates(code, title: str):
    """Replace templates in place, innermost first, so nested ones resolve."""
    for tpl in reversed(code.filter_templates(recursive=True)):
        try:
            name = str(tpl.name).strip().replace("_", " ")
        except ValueError:
            continue
        pos, named = _params(tpl)
        if QUOTE_TPL.match(name):
            text = pos[0] if pos else named.get("text") or named.get("quote") or named.get("1", "")
            who = (pos[1] if len(pos) > 1 else "") or named.get("speaker") or named.get("character") or named.get("author") or named.get("2", "")
            where = (pos[2] if len(pos) > 2 else "") or named.get("source") or named.get("chapter") or named.get("episode", "")
            text = mwparserfromhell.parse(text).strip_code().strip().strip('"“”')
            rep = f'\n"{text}"' + (f" — {mwparserfromhell.parse(who).strip_code().strip()}" if who else "") + \
                  (f" ({mwparserfromhell.parse(where).strip_code().strip()})" if where else "") + "\n" if text else ""
        elif KEEP_FIRST.match(name):
            rep = pos[0] if pos else ""
        elif KEEP_LAST.match(name):
            rep = pos[-1] if pos else ""
        elif name.lower() == "pagename":
            rep = title
        else:
            rep = ""
        try:
            code.replace(tpl, rep)
        except ValueError:
            pass  # already removed with a parent


def _clean(code_text: str, title: str) -> str:
    code = mwparserfromhell.parse(code_text)
    _render_templates(code, title)
    text = code.strip_code(normalize=True, collapse=True)
    text = re.sub(r"<[^>]+>", "", text)
    text = re.sub(r"^[:;*#]+\s*", "", text, flags=re.M)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def extract_dialogue(wikitext: str, title: str) -> list[str]:
    raw = re.sub(r"<ref[^>]*/>|<ref[^>]*>.*?</ref>|<!--.*?-->", "", wikitext, flags=re.S)
    code = mwparserfromhell.parse(raw)
    lines, seen = [], set()

    def push(s: str):
        s = re.sub(r"\s+", " ", s).strip(" -")
        if s and s not in seen:
            seen.add(s)
            lines.append(s)

    for sec in code.get_sections(levels=[2], include_lead=True):
        heads = sec.filter_headings(recursive=False)
        head = str(heads[0].title).strip() if heads else ""
        if heads:
            sec.remove(heads[0])
        if SKIP_SECTIONS.search(head):
            continue
        text = _clean(str(sec), title)
        if DIALOGUE_SECTIONS.search(head):
            for ln in text.split("\n"):
                if len(ln.strip()) > 3:
                    push(ln)
            continue
        for sentence in re.split(r'(?:(?<=[.!?…])|(?<=[.!?…]["”」]))\s+(?=[A-Z"“「])', text):
            if QUOTE_RE.search(sentence):
                push(sentence)
    return lines


# --------------------------------------------------------------------- lorebook

def natural_key(t: str):
    return [int(x) if x.isdigit() else x.lower() for x in re.split(r"(\d+)", t)]


def make_entry(uid: int, title: str, lines: list[str], args) -> dict:
    name = f"{title} (Dialogue)"
    content = f"[Canon Dialogue: {title} — speak these lines word-for-word when this moment happens]\n" + \
              "\n".join(f"- {l}" for l in lines)
    return {
        "uid": uid,
        "key": [name, title],
        "keysecondary": [],
        "comment": name,
        "content": content,
        "constant": False,
        "vectorized": False,
        "selective": True,
        "selectiveLogic": 0,
        "addMemo": True,
        "order": args.order,
        "position": args.position,
        "disable": not args.enabled,
        "excludeRecursion": True,
        "preventRecursion": True,
        "delayUntilRecursion": False,
        "probability": 100,
        "useProbability": True,
        "depth": args.depth,
        "group": "Canon Dialogue",
        "groupOverride": False,
        "groupWeight": 100,
        "scanDepth": None,
        "caseSensitive": None,
        "matchWholeWords": None,
        "useGroupScoring": None,
        "automationId": "",
        "role": 0,
        "sticky": 0,
        "cooldown": 0,
        "delay": 0,
        "displayIndex": uid,
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("wiki", help="e.g. kagurabachi.fandom.com")
    ap.add_argument("--category", default="Chapters", help="category holding chapter/episode pages (default: Chapters)")
    ap.add_argument("--title-regex", default=None, help="only keep titles matching this regex, e.g. '^Chapter \\d+$'")
    ap.add_argument("--out", default=None, help="output file (default: <wiki> Canon Dialogue.json)")
    ap.add_argument("--enabled", action="store_true", help="ship entries enabled (default: disabled, for canon pinning)")
    ap.add_argument("--order", type=int, default=1, help="insertion order (default 1, just after order-0 hubs)")
    ap.add_argument("--position", type=int, default=4, help="0 before char, 1 after char, 4 @depth (default 4)")
    ap.add_argument("--depth", type=int, default=2, help="depth when position is @depth (default 2)")
    ap.add_argument("--min-lines", type=int, default=1, help="skip chapters with fewer canon lines than this")
    ap.add_argument("--delay", type=float, default=0.5, help="seconds between API calls")
    args = ap.parse_args()

    wiki = Wiki(args.wiki, args.delay)
    print(f"Listing Category:{args.category.removeprefix('Category:')} on {wiki.api}", file=sys.stderr)
    titles = wiki.category_members(args.category)
    if args.title_regex:
        rx = re.compile(args.title_regex)
        titles = [t for t in titles if rx.search(t)]
    titles.sort(key=natural_key)
    if not titles:
        sys.exit("No pages found. Check --category (open the wiki's chapter list page and look at its categories).")

    texts = wiki.wikitext(titles)
    entries, empty = {}, []
    for title in titles:
        if title not in texts:
            continue
        lines = extract_dialogue(texts[title], title)
        if len(lines) < args.min_lines:
            empty.append(title)
            continue
        uid = len(entries)
        entries[str(uid)] = make_entry(uid, title, lines, args)

    host = urlparse(wiki.api).netloc.replace(".fandom.com", "")
    out = args.out or f"{host} Canon Dialogue.json"
    with open(out, "w", encoding="utf-8") as f:
        json.dump({"entries": entries}, f, ensure_ascii=False, indent=2)

    total = sum(e["content"].count("\n") for e in entries.values())
    print(f"Wrote {out}: {len(entries)} entries, {total} lines. "
          f"{len(empty)} pages had no recorded dialogue.", file=sys.stderr)


if __name__ == "__main__":
    main()
