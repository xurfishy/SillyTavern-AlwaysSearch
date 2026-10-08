/**
 * Canon wiki helpers for Always Search.
 *
 * Talks to Fandom / MediaWiki wikis through their public API (anonymous CORS via
 * origin=*), so it works in plain SillyTavern and in TauriTavern without any
 * server plugin or API key.
 */

/* ------------------------------------------------------------------ */
/* MediaWiki API                                                       */
/* ------------------------------------------------------------------ */

/** Turn "kagurabachi.fandom.com", a full page URL, or an api.php URL into an api.php endpoint. */
export function apiEndpoint(wiki) {
    let w = String(wiki || '').trim();
    if (!w) return '';
    if (!/^https?:\/\//i.test(w)) w = 'https://' + w;
    let url;
    try { url = new URL(w); } catch { return ''; }
    if (/\/api\.php$/i.test(url.pathname)) return `${url.origin}${url.pathname}`;
    if (/fandom\.com$/i.test(url.hostname)) {
        // Language wikis live under a path prefix, e.g. naruto.fandom.com/es/wiki/...
        const lang = url.pathname.match(/^\/([a-z]{2,3}(?:-[a-z]+)?)\/wiki\//i)?.[1];
        return `${url.origin}${lang ? '/' + lang : ''}/api.php`;
    }
    if (url.pathname.startsWith('/w/') || url.pathname.startsWith('/wiki/')) return `${url.origin}/w/api.php`;
    return `${url.origin}/api.php`;
}

export function wikiLabel(wiki) {
    try {
        const host = new URL(apiEndpoint(wiki)).hostname;
        return host.replace(/\.fandom\.com$/i, '').replace(/^www\./, '');
    } catch { return String(wiki); }
}

export function pageUrl(wiki, title) {
    const api = apiEndpoint(wiki);
    return api.replace(/\/(w\/)?api\.php$/i, '/wiki/') + encodeURIComponent(String(title).replace(/ /g, '_'));
}

async function mwApi(wiki, params) {
    const api = apiEndpoint(wiki);
    if (!api) throw new Error(`Invalid wiki: ${wiki}`);
    const qs = new URLSearchParams({ format: 'json', formatversion: '2', origin: '*', ...params });
    const res = await fetch(`${api}?${qs}`, { headers: { 'Api-User-Agent': 'AlwaysSearch-SillyTavern/1.1' } });
    if (!res.ok) throw new Error(`${wikiLabel(wiki)} wiki API returned ${res.status}`);
    const data = await res.json();
    if (data?.error) throw new Error(`${wikiLabel(wiki)} wiki: ${data.error.info || data.error.code}`);
    return data;
}

/** Full-text search; returns page titles. */
export async function searchWiki(wiki, query, limit = 3) {
    if (!query) return [];
    const data = await mwApi(wiki, {
        action: 'query', list: 'search', srsearch: query, srlimit: String(limit), srnamespace: '0',
    });
    return (data?.query?.search ?? []).map(x => x.title);
}

/** Fetch raw wikitext for up to 50 titles in one request. Missing pages are skipped. Follows redirects. */
export async function fetchWikitext(wiki, titles) {
    const list = [...new Set(titles.filter(Boolean))].slice(0, 50);
    if (!list.length) return {};
    const data = await mwApi(wiki, {
        action: 'query', prop: 'revisions', rvprop: 'content', rvslots: 'main',
        redirects: '1', titles: list.join('|'),
    });
    const out = {};
    // Map redirected/normalized titles back to what was asked for
    const alias = {};
    for (const n of data?.query?.normalized ?? []) alias[n.to] = n.from;
    for (const r of data?.query?.redirects ?? []) alias[r.to] = alias[r.from] ?? r.from;
    for (const p of data?.query?.pages ?? []) {
        if (p.missing || p.invalid) continue;
        const text = p.revisions?.[0]?.slots?.main?.content ?? p.revisions?.[0]?.content;
        if (typeof text === 'string') out[p.title] = { text, requested: alias[p.title] ?? p.title };
    }
    return out;
}

/* ------------------------------------------------------------------ */
/* Wikitext → plain text                                               */
/* ------------------------------------------------------------------ */

const QUOTE_TEMPLATE = /^(c?quote|quotation|dialogue|dialog|quotebox|quote ?box|blockquote|q)$/i;
const KEEP_FIRST = /^(nihongo|nihongo2|ruby|furigana|scroll(-\d+| box)?|tooltip|abbr|small|big|nowrap|spoiler|translation|tl|j|lang|text)$/i;
const KEEP_LAST = /^(colou?r|font ?colou?r|fc|highlight|bgcolor)$/i;

function splitParams(inner) {
    // Top-level split on "|" (links are already flattened before templates run)
    const parts = inner.split('|');
    const name = parts.shift().trim();
    const positional = [];
    const named = {};
    for (const p of parts) {
        const m = p.match(/^\s*([\w .-]{1,40}?)\s*=([\s\S]*)$/);
        if (m) named[m[1].trim().toLowerCase()] = m[2].trim();
        else positional.push(p.trim());
    }
    return { name, positional, named };
}

function decodeEntities(s) {
    return s
        .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
        .replace(/&#0?39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&mdash;/g, '—').replace(/&ndash;/g, '–').replace(/&hellip;/g, '…')
        .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}

/**
 * Clean wikitext. Quote templates become `"line" — Speaker`, infobox params are
 * collected into `infobox`, everything else decorative is dropped.
 */
export function cleanWikitext(raw, pageTitle = '') {
    const infobox = {};
    let s = String(raw || '');

    s = s.replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<ref[^>]*\/>/gi, '')
        .replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, '')
        .replace(/<(gallery|tabber|references|noinclude|imagemap)[^>]*>[\s\S]*?<\/\1>/gi, '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/__[A-Z]+__/g, '')
        .replace(/\{\{\s*PAGENAME\s*\}\}/gi, pageTitle);

    // Links: interwiki/language links out, then flatten ordinary links innermost-first
    s = s.replace(/\[\[[a-z]{2,3}(-[a-z]+)?:[^\[\]]*\]\]/g, '');
    for (let i = 0; i < 6; i++) {
        const before = s;
        s = s.replace(/\[\[(?!\s*(?:File|Image|Category|Media)\s*:)([^\[\]|]*)\|([^\[\]]*)\]\]/gi, '$2')
            .replace(/\[\[(?!\s*(?:File|Image|Category|Media)\s*:)([^\[\]|]*)\]\]/gi, '$1')
            .replace(/\[\[\s*(?:File|Image|Category|Media)\s*:[^\[\]]*\]\]/gi, '');
        if (s === before) break;
    }
    s = s.replace(/\[https?:\/\/[^\s\]]+\s+([^\]]+)\]/g, '$1').replace(/\[https?:\/\/[^\s\]]+\]/g, '');

    // Templates, innermost first
    for (let i = 0; i < 40; i++) {
        const before = s;
        s = s.replace(/\{\{([^{}]*)\}\}/g, (_, inner) => {
            const { name, positional, named } = splitParams(inner);
            const key = name.replace(/_/g, ' ').trim();
            if (/infobox|^character$|^char box/i.test(key)) {
                for (const [k, v] of Object.entries(named)) {
                    const val = v.replace(/\s*\n\s*/g, ', ').replace(/\s+/g, ' ').replace(/^,\s*|,\s*$/g, '').trim();
                    if (val && !/image|caption|^title$|^name$|gallery|^jname$|^rname$|^ename$/i.test(k)) infobox[k] = val;
                }
                return '';
            }
            if (QUOTE_TEMPLATE.test(key)) {
                const text = positional[0] ?? named.text ?? named.quote ?? named['1'] ?? '';
                const who = positional[1] ?? named.speaker ?? named.character ?? named.author ?? named['2'] ?? '';
                const where = positional[2] ?? named.source ?? named.chapter ?? named.episode ?? '';
                if (!text.trim()) return '';
                return `\n"${text.trim().replace(/^["“]|["”]$/g, '')}"${who ? ' — ' + who.trim() : ''}${where ? ' (' + where.trim() + ')' : ''}\n`;
            }
            if (KEEP_FIRST.test(key)) return positional[0] ?? '';
            if (KEEP_LAST.test(key)) return positional[positional.length - 1] ?? '';
            if (/^pagename$/i.test(key)) return pageTitle;
            return '';
        });
        if (s === before) break;
    }

    // Tables (after templates so their braces don't confuse anything)
    for (let i = 0; i < 10; i++) {
        const before = s;
        s = s.replace(/\{\|[^{}]*?\|\}/g, '');
        if (s === before) break;
    }

    s = s.replace(/'{2,}/g, '')
        .replace(/<[^>]+>/g, '')
        .replace(/^[:;]+\s*/gm, '')
        .replace(/^\*+\s*/gm, '- ')
        .replace(/^#+\s*(?!\s)/gm, '- ');
    s = decodeEntities(s)
        .replace(/[ \t]+/g, ' ')
        .replace(/ *\n */g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

    return { text: s, infobox };
}

/** Split cleaned text into { intro, sections: [{ title, level, text }] }. */
export function toSections(text) {
    const sections = [];
    let intro = '';
    let cur = null;
    let parent = '';
    for (const line of text.split('\n')) {
        const m = line.match(/^(={2,6})\s*(.*?)\s*\1\s*$/);
        if (m) {
            if (m[1].length <= 2) parent = m[2];
            cur = { title: m[2], level: m[1].length, parent: m[1].length > 2 ? parent : '', text: '' };
            sections.push(cur);
        } else if (cur) {
            cur.text += line + '\n';
        } else {
            intro += line + '\n';
        }
    }
    for (const sct of sections) sct.text = sct.text.trim();
    return { intro: intro.trim(), sections };
}

export function parsePage(wikitext, title = '') {
    const { text, infobox } = cleanWikitext(wikitext, title);
    return { ...toSections(text), infobox };
}

/* ------------------------------------------------------------------ */
/* Canon dialogue extraction                                           */
/* ------------------------------------------------------------------ */

const QUOTE_RE = /["“「『]([^"“”「」『』\n]{6,600})["”」』]/;

/** Return canon lines from a parsed page: Quotes sections whole, plus quoted sentences elsewhere. */
export function extractDialogue(page) {
    const lines = [];
    const seen = new Set();
    const push = (l) => {
        const t = l.replace(/\s+/g, ' ').trim();
        if (t && !seen.has(t)) { seen.add(t); lines.push(t); }
    };

    for (const sct of page.sections) {
        if (/quote|dialogue|famous lines|catchphrase/i.test(sct.title)) {
            sct.text.split('\n').map(x => x.replace(/^-\s*/, '')).filter(x => x.length > 3).forEach(push);
        }
    }
    const skip = /quote|reference|gallery|navigation|external|trivia|see also|site navigation/i;
    for (const sct of [{ title: '', text: page.intro }, ...page.sections]) {
        if (skip.test(sct.title)) continue;
        // Sentences that contain quoted speech keep their attribution ("Gojo tells Yuji, ...")
        const sentences = sct.text.split(/(?<=[.!?…]["”」]?)\s+(?=[A-Z"“「])/);
        for (const sen of sentences) if (QUOTE_RE.test(sen)) push(sen);
    }
    return lines;
}

/* ------------------------------------------------------------------ */
/* Character / group profiles                                          */
/* ------------------------------------------------------------------ */

const PROFILE_SECTIONS = [
    [/appearance|physical|design/i, 'Appearance'],
    [/personality|character(istics)?$|traits|demeanou?r/i, 'Personality'],
    [/abilit|power|skill|technique|magic|cursed|fighting|combat|strength|arts|jutsu|quirk|spell|weapon|equipment|arsenal|enchanted|blade/i, 'Abilities'],
    [/^members?$|membership|roster|composition|organization|structure|ranks?/i, 'Members'],
    [/^overview$|^background$|^summary$/i, 'Overview'],
];
const INFOBOX_KEEP = /^(gender|sex|age|height|weight|hair|eyes?|eye ?colou?r|hair ?colou?r|status|affiliation|affiliations|occupation|rank|grade|race|species|ability|abilities|technique|weapon|weapons|leader|members|base|class|position|title|epithet|alias|aliases|nickname|relatives|partner)$/i;

/**
 * Build a compact profile: infobox facts, intro, then Appearance/Personality/
 * Abilities/Members sections (including a /Abilities subpage if the wiki splits it out).
 */
export async function buildProfile(wiki, title, budget = 2500) {
    const pages = await fetchWikitext(wiki, [title, `${title}/Abilities`, `${title}/Abilities and Powers`, `${title}/Powers and Abilities`]);
    const entries = Object.entries(pages);
    if (!entries.length) throw new Error(`"${title}" not found on ${wikiLabel(wiki)}`);
    const main = entries.find(([, v]) => v.requested === title) ?? entries[0];
    const mainTitle = main[0];
    const parsed = parsePage(main[1].text, mainTitle);
    const extra = entries.filter(([t]) => t !== mainTitle).map(([t, v]) => parsePage(v.text, t));

    const facts = Object.entries(parsed.infobox)
        .filter(([k]) => INFOBOX_KEEP.test(k))
        .map(([k, v]) => `${k}: ${v}`)
        .join('; ');

    const buckets = {};
    for (const p of [parsed, ...extra]) {
        const fromSub = p !== parsed;
        for (const sct of p.sections) {
            if (!sct.text) continue;
            for (const [re, label] of PROFILE_SECTIONS) {
                if (re.test(sct.title) || (sct.parent && re.test(sct.parent)) || (fromSub && label === 'Abilities' && !/trivia|reference|gallery/i.test(sct.title))) {
                    (buckets[label] ??= []).push(sct.level > 2 ? `${sct.title}: ${sct.text}` : sct.text);
                    break;
                }
            }
        }
        if (fromSub && p.intro) (buckets.Abilities ??= []).unshift(p.intro);
    }

    const parts = [];
    if (facts) parts.push(`Facts: ${facts}`);
    if (parsed.intro) parts.push(parsed.intro);
    const order = ['Appearance', 'Personality', 'Abilities', 'Members', 'Overview'];
    const present = order.filter(l => buckets[l]?.length);
    const head = parts.join('\n').slice(0, Math.floor(budget * 0.25));
    const share = Math.max(300, Math.floor((budget - head.length) / Math.max(1, present.length)));
    let body = head;
    for (const l of present) {
        const t = buckets[l].join('\n').replace(/\n{2,}/g, '\n').trim();
        body += `\n${l}: ${t.length > share ? trimToSentence(t.slice(0, share)) : t}`;
    }
    return { title: mainTitle, text: body.trim().slice(0, budget), url: pageUrl(wiki, mainTitle) };
}

function trimToSentence(t) {
    const cut = t.search(/[.!?…][^.!?…]*$/);
    return (cut > t.length * 0.5 ? t.slice(0, cut + 1) : t) + ' …';
}

/* ------------------------------------------------------------------ */
/* Per-turn canon dialogue lookup                                      */
/* ------------------------------------------------------------------ */

/**
 * Find canon dialogue for the current scene: the pinned page (e.g. "Chapter 12")
 * plus the top search hits for the query. Returns { text, sources }.
 */
export async function lookupCanonDialogue(wiki, { query, pinned = [], pages = 2, budget = 3000 }) {
    const hits = [];
    try {
        hits.push(...await searchWiki(wiki, query, pages));
    } catch (e) {
        console.warn('[AlwaysSearch] canon search failed', e);
    }
    if (!hits.length && query) {
        // Natural-language queries can miss; retry with just the proper nouns
        const names = (query.match(/\b[A-Z][a-zA-Z'’-]+(?:\s+[A-Z][a-zA-Z'’-]+)*/g) ?? []).slice(0, 3).join(' ');
        if (names && names !== query) {
            try { hits.push(...await searchWiki(wiki, names, pages)); } catch { /* ignore */ }
        }
    }
    const titles = [...new Set([...pinned.filter(Boolean), ...hits])];
    if (!titles.length) return { text: '', sources: [] };

    const fetched = await fetchWikitext(wiki, [...titles, ...titles.map(t => `${t}/Quotes`)]);
    const blocks = [];
    const sources = [];
    const per = Math.floor(budget / Math.max(1, titles.length));
    for (const t of titles) {
        const own = Object.entries(fetched).filter(([title, v]) => v.requested === t || title === t);
        const sub = Object.entries(fetched).filter(([, v]) => v.requested === `${t}/Quotes`);
        const lines = [];
        for (const [title, v] of [...own, ...sub]) lines.push(...extractDialogue(parsePage(v.text, title)));
        if (!lines.length) continue;
        const name = own[0]?.[0] ?? t;
        let block = '';
        for (const l of lines) {
            if (block.length + l.length > per) break;
            block += `- ${l}\n`;
        }
        if (block) {
            blocks.push(`## ${name}\n${block.trim()}`);
            sources.push({ title: `${name} (${wikiLabel(wiki)})`, url: pageUrl(wiki, name) });
        }
    }
    return { text: blocks.join('\n\n'), sources };
}

/** Roster entries whose name or alias appears in the text (or that are pinned "always"). */
export function matchRoster(roster, text) {
    const hay = ` ${String(text || '').toLowerCase()} `;
    return (roster || []).filter(r => {
        if (!r.enabled) return false;
        if (r.always) return true;
        const names = [r.name, ...(r.aliases || [])].map(x => String(x || '').trim().toLowerCase()).filter(x => x.length > 1);
        return names.some(n => {
            const esc = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            return new RegExp(`(^|[^\\p{L}\\p{N}])${esc}($|[^\\p{L}\\p{N}])`, 'u').test(hay);
        });
    });
}
