/**
 * Always Search — a SillyTavern extension that runs a web search before EVERY
 * AI response and injects the results into the prompt.
 *
 * Uses SillyTavern's built-in server search endpoints (/api/search/*), so no
 * server plugin is needed. API keys are stored in SillyTavern's secrets store.
 */

import { extractTextFromHTML, getStringHash } from '../../../utils.js';
import { SECRET_KEYS, secret_state, writeSecret } from '../../../secrets.js';
import { POPUP_TYPE, callGenericPopup } from '../../../popup.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandArgument } from '../../../slash-commands/SlashCommandArgument.js';

const MODULE = 'alwayssearch';
const PROMPT_KEY = '___AlwaysSearch___';
const LOG = (...a) => console.log('[AlwaysSearch]', ...a);

const ENGINES = {
    tavily: { label: 'Tavily (free tier, recommended)', secret: SECRET_KEYS.TAVILY },
    serper: { label: 'Serper (Google)', secret: SECRET_KEYS.SERPER },
    serpapi: { label: 'SerpApi (Google)', secret: SECRET_KEYS.SERPAPI },
    searxng: { label: 'SearXNG (self-hosted, no key)', secret: null },
    zai: { label: 'Z.AI', secret: SECRET_KEYS.ZAI },
    koboldcpp: { label: 'KoboldCpp built-in search', secret: null },
};

const DEFAULT_QUERY_PROMPT = `Below is the most recent part of a roleplay/chat.

{{transcript}}

Write ONE concise web search query (max 12 words) that would find real-world or canon facts useful for writing {{char}}'s next reply. Focus on names, places, techniques, events, or facts mentioned. Output ONLY the query text, nothing else.`;

const DEFAULT_TEMPLATE = `[Web search results for "{{query}}" (retrieved {{date}}). Use any relevant facts naturally; ignore anything irrelevant. Stay in character and do not mention searching.]
{{text}}`;

const defaultSettings = {
    enabled: true,
    engine: 'tavily',
    searxng_url: 'http://localhost:8888',
    query_mode: 'smart',          // 'smart' = model writes the query, 'last_user' = raw last user message
    context_messages: 6,
    query_prompt: DEFAULT_QUERY_PROMPT,
    query_suffix: '',              // e.g. "Jujutsu Kaisen wiki" — macros allowed
    budget: 3000,                  // max characters of snippets injected
    include_sources: true,
    visit_pages: false,
    visit_count: 2,
    visit_budget: 2000,
    research_on_swipe: false,
    search_on_impersonate: false,
    position: 1,                   // extension_prompt_types.IN_CHAT
    depth: 1,
    role: 0,                       // system
    template: DEFAULT_TEMPLATE,
    show_toast: true,
    show_badge: true,
    direct_keys: {},               // only used on hosts without server search routes (TauriTavern)
};

// In-memory cache: trigger key -> { query, text, sources }
const cache = new Map();
let pending = null;   // search info waiting to be attached to the next AI message
let lastResult = null;

function ctx() {
    return SillyTavern.getContext();
}

function settings() {
    const es = ctx().extensionSettings;
    es[MODULE] = Object.assign({}, defaultSettings, es[MODULE] || {});
    return es[MODULE];
}

function save() {
    ctx().saveSettingsDebounced();
}

/* ------------------------------------------------------------------ */
/* Search engines → { bits: string[], sources: {title,url}[] }         */
/* ------------------------------------------------------------------ */

const isTauriTavern = () => !!window.__TAURITAVERN__;

class UnsupportedRouteError extends Error {}

async function post(path, body) {
    const res = await fetch(path, {
        method: 'POST',
        headers: ctx().getRequestHeaders(),
        body: JSON.stringify(body),
    });
    if (!res.ok) {
        const t = await res.text().catch(() => '');
        if (res.status === 404) throw new UnsupportedRouteError(`${path} is not supported by this host`);
        throw new Error(`${path} failed (${res.status}) ${t.slice(0, 200)}`);
    }
    return res;
}

/**
 * Hosts like TauriTavern don't implement every /api/search/* route.
 * When the server route is missing, call the provider's API straight from the
 * app using a key kept in this extension's settings.
 */
async function serverOrDirect(engine, path, body, direct) {
    try {
        return await (await post(path, body)).json();
    } catch (e) {
        if (!(e instanceof UnsupportedRouteError)) throw e;
        const key = settings().direct_keys?.[engine];
        if (!key) throw new Error(`This app has no built-in ${engine} route. Paste your ${engine} key in Always Search and click Save key.`);
        try {
            const res = await direct(key);
            if (!res.ok) throw new Error(`${engine} API returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
            return await res.json();
        } catch (err) {
            if (err instanceof TypeError) {
                throw new Error(`${engine} blocked the direct request from this app (CORS/network). Use SearXNG instead, which TauriTavern supports natively.`);
            }
            throw err;
        }
    }
}

const jsonPost = (url, headers, body) => fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
});

const engineFns = {
    async tavily(query) {
        const data = await serverOrDirect('tavily', '/api/search/tavily', { query, include_images: false },
            key => jsonPost('https://api.tavily.com/search', { Authorization: `Bearer ${key}` },
                { query, include_answer: true, max_results: 5 }));
        const bits = [];
        const sources = [];
        if (data.answer) bits.push(data.answer);
        for (const r of data.results ?? []) {
            bits.push(`${r.title}: ${r.content}`);
            sources.push({ title: r.title, url: r.url });
        }
        return { bits, sources };
    },

    async serper(query) {
        const data = await serverOrDirect('serper', '/api/search/serper', { query },
            key => jsonPost('https://google.serper.dev/search', { 'X-API-KEY': key }, { q: query }));
        const bits = [];
        const sources = [];
        if (data.answerBox) bits.push([data.answerBox.title, data.answerBox.answer || data.answerBox.snippet].filter(Boolean).join(': '));
        if (data.knowledgeGraph) {
            const kg = data.knowledgeGraph;
            bits.push([kg.title, kg.type, kg.description].filter(Boolean).join(' — '));
            for (const [k, v] of Object.entries(kg.attributes ?? {})) bits.push(`${k}: ${v}`);
        }
        for (const r of data.organic ?? []) {
            bits.push(`${r.title}: ${r.snippet}`);
            sources.push({ title: r.title, url: r.link });
        }
        for (const r of data.peopleAlsoAsk ?? []) bits.push(`${r.question} ${r.snippet}`);
        return { bits, sources };
    },

    async serpapi(query) {
        const data = await serverOrDirect('serpapi', '/api/search/serpapi', { query },
            key => fetch(`https://serpapi.com/search.json?q=${encodeURIComponent(query)}&api_key=${encodeURIComponent(key)}`));
        const bits = [];
        const sources = [];
        const ab = data.answer_box;
        if (ab) bits.push(ab.answer || ab.result || ab.snippet || ab.title);
        if (data.knowledge_graph) bits.push(data.knowledge_graph.description || data.knowledge_graph.title);
        for (const r of data.organic_results ?? []) {
            bits.push(`${r.title}: ${r.snippet}`);
            sources.push({ title: r.title, url: r.link });
        }
        for (const r of data.related_questions ?? []) bits.push(`${r.question} ${r.snippet}`);
        return { bits, sources };
    },

    async searxng(query) {
        const html = await (await post('/api/search/searxng', { query, baseUrl: settings().searxng_url })).text();
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const bits = [];
        const sources = [];
        const info = doc.querySelector('.infobox p')?.textContent?.trim();
        if (info) bits.push(info);
        for (const art of doc.querySelectorAll('#urls article')) {
            const a = art.querySelector('h3 a') || art.querySelector('a.url_header, a.url_wrapper');
            const content = art.querySelector('p.content')?.textContent?.trim();
            const title = a?.textContent?.trim() || '';
            if (content) bits.push(title ? `${title}: ${content}` : content);
            if (a?.getAttribute('href')) sources.push({ title, url: a.getAttribute('href') });
        }
        if (!bits.length) {
            // Fallback for older/other SearXNG themes
            bits.push(...Array.from(doc.querySelectorAll('#urls p.content')).map(x => x.textContent.trim()).filter(Boolean));
            for (const a of doc.querySelectorAll('#urls .url_header, #urls .url_wrapper')) {
                if (a.getAttribute('href')) sources.push({ title: '', url: a.getAttribute('href') });
            }
        }
        return { bits, sources };
    },

    async zai(query) {
        const data = await serverOrDirect('zai', '/api/search/zai', { query },
            key => jsonPost('https://api.z.ai/api/paas/v4/web_search', { Authorization: `Bearer ${key}` },
                { search_engine: 'search-prime', search_query: query }));
        const bits = [];
        const sources = [];
        for (const r of data.search_result ?? []) {
            bits.push(`${r.title}: ${r.content}`);
            sources.push({ title: r.title, url: r.link });
        }
        return { bits, sources };
    },

    async koboldcpp(query) {
        const c = ctx();
        const url = c.textCompletionSettings?.server_urls?.koboldcpp
            || c.textCompletionSettings?.server_urls?.[c.textCompletionSettings?.type];
        const data = await (await post('/api/search/koboldcpp', { url, query })).json();
        const bits = [];
        const sources = [];
        for (const r of data ?? []) {
            bits.push([r.title, r.desc, r.content].filter(Boolean).join(': '));
            sources.push({ title: r.title, url: r.url });
        }
        return { bits, sources };
    },
};

async function visitPage(url) {
    try {
        const res = await post('/api/search/visit', { url, html: true });
        const text = await extractTextFromHTML(await res.blob(), 'p');
        return (text || '').replace(/\s+/g, ' ').trim();
    } catch (e) {
        LOG('visit failed', url, e.message);
        return '';
    }
}

async function runSearch(query) {
    const s = settings();
    const fn = engineFns[s.engine];
    if (!fn) throw new Error(`Unknown engine: ${s.engine}`);

    const { bits, sources } = await fn(query);
    const seen = new Set();
    let text = '';
    for (let b of bits) {
        b = (b || '').replace(/\s+/g, ' ').trim();
        if (!b || seen.has(b)) continue;
        seen.add(b);
        if (text.length + b.length > s.budget) {
            const room = s.budget - text.length;
            if (room > 120) text += `- ${b.slice(0, room)}…\n`;
            break;
        }
        text += `- ${b}\n`;
    }

    const uniqSources = [];
    const seenUrls = new Set();
    for (const src of sources) {
        if (src?.url && !seenUrls.has(src.url)) {
            seenUrls.add(src.url);
            uniqSources.push(src);
        }
    }

    if (s.visit_pages && uniqSources.length) {
        const targets = uniqSources.slice(0, Math.max(0, Number(s.visit_count) || 0));
        const pages = await Promise.all(targets.map(t => visitPage(t.url)));
        pages.forEach((p, i) => {
            if (p) text += `\n[From ${targets[i].title || targets[i].url}]\n${p.slice(0, s.visit_budget)}\n`;
        });
    }

    if (s.include_sources && uniqSources.length) {
        text += '\nSources:\n' + uniqSources.slice(0, 5).map(x => `- ${x.title || ''} <${x.url}>`).join('\n');
    }

    return { text: text.trim(), sources: uniqSources };
}

/* ------------------------------------------------------------------ */
/* Query building                                                      */
/* ------------------------------------------------------------------ */

function cleanQuery(q) {
    return String(q || '')
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .split('\n').map(x => x.trim()).filter(Boolean)[0]
        ?.replace(/^(search query|query)\s*:\s*/i, '')
        .replace(/^["'`]+|["'`]+$/g, '')
        .trim()
        .slice(0, 200) || '';
}

function lastUserText(chat) {
    for (let i = chat.length - 1; i >= 0; i--) {
        const m = chat[i];
        if (m && m.is_user && !m.is_system && m.mes) return { text: m.mes, index: i };
    }
    return { text: '', index: -1 };
}

async function buildQuery(chat) {
    const s = settings();
    const c = ctx();
    const { text: userText } = lastUserText(chat);
    let query = '';

    if (s.query_mode === 'smart') {
        const recent = chat.filter(m => m && !m.is_system && m.mes)
            .slice(-Math.max(1, Number(s.context_messages) || 6))
            .map(m => `${m.name}: ${m.mes.replace(/\s+/g, ' ').slice(0, 1200)}`)
            .join('\n');
        const prompt = c.substituteParamsExtended(s.query_prompt || DEFAULT_QUERY_PROMPT, { transcript: recent });
        try {
            const out = await c.generateRaw({
                prompt,
                systemPrompt: 'You write web search queries. Reply with the query only.',
                responseLength: 60,
            });
            query = cleanQuery(out);
        } catch (e) {
            LOG('smart query failed, falling back to last user message', e);
        }
    }

    if (!query) {
        query = userText.replace(/\s+/g, ' ').trim().slice(0, 200);
    }

    if (query && s.query_suffix?.trim()) {
        query += ' ' + c.substituteParams(s.query_suffix.trim());
    }

    return query.trim();
}

/* ------------------------------------------------------------------ */
/* Generation interceptor — runs before every generation               */
/* ------------------------------------------------------------------ */

globalThis.AlwaysSearch_Intercept = async function (chat, _contextSize, _abort, type) {
    const s = settings();
    const c = ctx();

    if (type === 'quiet') return;
    // Always clear last turn's injection first
    c.setExtensionPrompt(PROMPT_KEY, '', s.position, s.depth, false, s.role);
    pending = null;

    if (!s.enabled) return;
    if (type === 'impersonate' && !s.search_on_impersonate) return;
    if (!Array.isArray(chat) || chat.length === 0) return;

    const { text: userText, index: userIndex } = lastUserText(chat);
    const triggerKey = `${c.chatId}|${userIndex}|${getStringHash(userText)}`;
    const isReroll = type === 'swipe' || type === 'regenerate' || type === 'continue';

    let result = null;
    const t0 = Date.now();

    try {
        if (isReroll && !s.research_on_swipe && cache.has(triggerKey)) {
            result = cache.get(triggerKey);
            LOG('reusing cached search for reroll', result.query);
        } else {
            const query = await buildQuery(chat);
            if (!query) {
                LOG('no query could be built');
                return;
            }
            if (s.show_toast) toastr.info(query, 'Searching the web…', { timeOut: 2500 });
            const { text, sources } = await runSearch(query);
            result = { query, text, sources };
            cache.set(triggerKey, result);
            if (cache.size > 200) cache.delete(cache.keys().next().value);
        }

        if (!result?.text) {
            if (s.show_toast) toastr.warning('Search returned nothing usable.', 'Always Search');
            return;
        }

        const date = new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
        let template = s.template || DEFAULT_TEMPLATE;
        if (!/{{text}}/i.test(template)) template += '\n{{text}}';
        const injection = c.substituteParamsExtended(template, { text: result.text, query: result.query, date });

        c.setExtensionPrompt(PROMPT_KEY, injection, s.position, s.depth, false, s.role);
        pending = { query: result.query, sources: result.sources.slice(0, 5) };
        lastResult = { ...result, injection, ms: Date.now() - t0 };
        updateLastPanel();
        LOG(`injected ${injection.length} chars in ${Date.now() - t0} ms`);
    } catch (e) {
        console.error('[AlwaysSearch] search failed', e);
        if (s.show_toast) toastr.error(String(e.message || e).slice(0, 200), 'Always Search failed');
    }
};

/* ------------------------------------------------------------------ */
/* Badge under AI messages showing what was searched                   */
/* ------------------------------------------------------------------ */

function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function renderBadge(mesId) {
    if (!settings().show_badge) return;
    const msg = ctx().chat[mesId];
    const info = msg?.extra?.alwayssearch;
    const el = document.querySelector(`#chat .mes[mesid="${mesId}"] .mes_block`);
    if (!el) return;
    el.querySelector('.alwayssearch-badge')?.remove();
    if (!info) return;
    const links = (info.sources || []).map(x =>
        `<li><a href="${escapeHtml(x.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(x.title || x.url)}</a></li>`).join('');
    const details = document.createElement('details');
    details.className = 'alwayssearch-badge';
    details.innerHTML = `<summary>🔎 ${escapeHtml(info.query)}</summary>${links ? `<ul>${links}</ul>` : ''}`;
    el.appendChild(details);
}

function onMessageReceived(mesId) {
    if (!pending) return;
    const msg = ctx().chat[mesId];
    if (!msg || msg.is_user) return;
    msg.extra = msg.extra || {};
    msg.extra.alwayssearch = pending;
    pending = null;
}

function renderAllBadges() {
    const chat = ctx().chat || [];
    chat.forEach((m, i) => { if (m?.extra?.alwayssearch) renderBadge(i); });
}

/* ------------------------------------------------------------------ */
/* Settings UI                                                         */
/* ------------------------------------------------------------------ */

function settingsHtml() {
    const engineOptions = Object.entries(ENGINES).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('');
    return `
<div class="alwayssearch-settings">
  <div class="inline-drawer">
    <div class="inline-drawer-toggle inline-drawer-header">
      <b>Always Search</b>
      <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
    </div>
    <div class="inline-drawer-content">
      <label class="checkbox_label"><input type="checkbox" id="as_enabled"> <span>Search before <b>every</b> response</span></label>

      <h4>Engine</h4>
      <select id="as_engine" class="text_pole">${engineOptions}</select>
      <small id="as_host_note" class="alwayssearch-last"></small>
      <div id="as_key_row" class="flex-container alignItemsCenter">
        <input id="as_key" type="password" class="text_pole flex1" placeholder="Paste API key, then Save">
        <div id="as_key_save" class="menu_button">Save key</div>
      </div>
      <small id="as_key_status"></small>
      <div id="as_searxng_row">
        <label for="as_searxng_url">SearXNG URL</label>
        <input id="as_searxng_url" class="text_pole" type="text">
      </div>

      <h4>Query</h4>
      <select id="as_query_mode" class="text_pole">
        <option value="smart">Smart — the model writes a search query from recent chat</option>
        <option value="last_user">Raw — search your last message as-is (faster, no extra call)</option>
      </select>
      <div id="as_smart_row">
        <label for="as_context_messages">Messages of context for query writing</label>
        <input id="as_context_messages" class="text_pole" type="number" min="1" max="30">
        <label for="as_query_prompt">Query-writing prompt <small>({{transcript}}, {{char}}, {{user}})</small></label>
        <textarea id="as_query_prompt" class="text_pole textarea_compact" rows="6"></textarea>
      </div>
      <label for="as_query_suffix">Always add to query <small>(e.g. "Jujutsu Kaisen wiki"; macros OK)</small></label>
      <input id="as_query_suffix" class="text_pole" type="text">
      <label class="checkbox_label"><input type="checkbox" id="as_research_on_swipe"> <span>New search on swipe/regenerate (off = reuse the last results)</span></label>
      <label class="checkbox_label"><input type="checkbox" id="as_search_on_impersonate"> <span>Also search on Impersonate</span></label>

      <h4>Results</h4>
      <label for="as_budget">Snippet budget (characters)</label>
      <input id="as_budget" class="text_pole" type="number" min="200" max="50000" step="100">
      <label class="checkbox_label"><input type="checkbox" id="as_include_sources"> <span>Include source URLs in the prompt</span></label>
      <label class="checkbox_label"><input type="checkbox" id="as_visit_pages"> <span>Also read the top pages in full (slower, richer)</span></label>
      <div id="as_visit_row" class="flex-container">
        <div class="flex1"><label for="as_visit_count">Pages</label><input id="as_visit_count" class="text_pole" type="number" min="1" max="5"></div>
        <div class="flex1"><label for="as_visit_budget">Chars per page</label><input id="as_visit_budget" class="text_pole" type="number" min="200" max="20000" step="100"></div>
      </div>

      <h4>Injection</h4>
      <div class="flex-container">
        <div class="flex1"><label for="as_position">Position</label>
          <select id="as_position" class="text_pole">
            <option value="1">In chat @ depth</option>
            <option value="0">After main prompt</option>
            <option value="2">Before main prompt</option>
          </select></div>
        <div class="flex1"><label for="as_depth">Depth</label><input id="as_depth" class="text_pole" type="number" min="0" max="100"></div>
        <div class="flex1"><label for="as_role">Role</label>
          <select id="as_role" class="text_pole">
            <option value="0">System</option><option value="1">User</option><option value="2">Assistant</option>
          </select></div>
      </div>
      <label for="as_template">Template <small>({{text}}, {{query}}, {{date}})</small></label>
      <textarea id="as_template" class="text_pole textarea_compact" rows="4"></textarea>

      <label class="checkbox_label"><input type="checkbox" id="as_show_toast"> <span>Show "Searching…" toasts</span></label>
      <label class="checkbox_label"><input type="checkbox" id="as_show_badge"> <span>Show 🔎 query + sources under replies</span></label>

      <div class="flex-container">
        <div id="as_test" class="menu_button">Test search</div>
        <div id="as_last" class="menu_button">Show last injection</div>
        <div id="as_reset_prompts" class="menu_button">Reset prompts</div>
      </div>
      <small id="as_last_line" class="alwayssearch-last"></small>
    </div>
  </div>
</div>`;
}

function refreshVisibility() {
    const s = settings();
    const needsKey = !!ENGINES[s.engine]?.secret;
    $('#as_key_row, #as_key_status').toggle(needsKey);
    $('#as_searxng_row').toggle(s.engine === 'searxng');
    $('#as_smart_row').toggle(s.query_mode === 'smart');
    $('#as_visit_row').toggle(!!s.visit_pages);
    if (isTauriTavern()) {
        $('#as_host_note').text(s.engine === 'searxng'
            ? 'TauriTavern detected: SearXNG runs natively. Approve the endpoint prompt the first time.'
            : 'TauriTavern detected: this engine is called directly with your key. If it fails, switch to SearXNG.');
    }
    if (needsKey) {
        const has = !!secret_state[ENGINES[s.engine].secret] || !!s.direct_keys?.[s.engine];
        $('#as_key_status').text(has ? '✅ Key is saved' : '⚠️ No key saved for this engine');
    }
}

function updateLastPanel() {
    if (!lastResult) return;
    $('#as_last_line').text(`Last: "${lastResult.query}" — ${lastResult.text.length} chars, ${lastResult.ms} ms`);
}

function bind(id, key, kind = 'text') {
    const s = settings();
    const el = $(`#${id}`);
    if (kind === 'checkbox') {
        el.prop('checked', !!s[key]).on('change', () => { s[key] = el.prop('checked'); save(); refreshVisibility(); });
    } else if (kind === 'number') {
        el.val(s[key]).on('input', () => { s[key] = Number(el.val()); save(); });
    } else {
        el.val(s[key]).on('input change', () => { s[key] = el.val(); save(); refreshVisibility(); });
    }
}

async function initUi() {
    $('#extensions_settings2').append(settingsHtml());

    bind('as_enabled', 'enabled', 'checkbox');
    bind('as_engine', 'engine');
    bind('as_searxng_url', 'searxng_url');
    bind('as_query_mode', 'query_mode');
    bind('as_context_messages', 'context_messages', 'number');
    bind('as_query_prompt', 'query_prompt');
    bind('as_query_suffix', 'query_suffix');
    bind('as_research_on_swipe', 'research_on_swipe', 'checkbox');
    bind('as_search_on_impersonate', 'search_on_impersonate', 'checkbox');
    bind('as_budget', 'budget', 'number');
    bind('as_include_sources', 'include_sources', 'checkbox');
    bind('as_visit_pages', 'visit_pages', 'checkbox');
    bind('as_visit_count', 'visit_count', 'number');
    bind('as_visit_budget', 'visit_budget', 'number');
    bind('as_position', 'position', 'number');
    bind('as_depth', 'depth', 'number');
    bind('as_role', 'role', 'number');
    bind('as_template', 'template');
    bind('as_show_toast', 'show_toast', 'checkbox');
    bind('as_show_badge', 'show_badge', 'checkbox');

    $('#as_key_save').on('click', async () => {
        const key = String($('#as_key').val() || '').trim();
        const secret = ENGINES[settings().engine]?.secret;
        if (!secret || !key) return;
        const s = settings();
        if (isTauriTavern()) {
            // TauriTavern has no server route for this engine; keep the key for direct calls
            s.direct_keys = { ...(s.direct_keys || {}), [s.engine]: key };
            save();
        }
        try { await writeSecret(secret, key); } catch (e) { LOG('writeSecret failed', e); }
        $('#as_key').val('');
        toastr.success('API key saved.', 'Always Search');
        refreshVisibility();
    });

    $('#as_test').on('click', async () => {
        const q = await callGenericPopup('Search query to test:', POPUP_TYPE.INPUT, 'Gojo Satoru Infinity');
        if (!q) return;
        try {
            const { text } = await runSearch(String(q));
            await callGenericPopup(`<pre class="alwayssearch-pre">${escapeHtml(text || '(no results)')}</pre>`, POPUP_TYPE.TEXT, '', { wide: true, large: true });
        } catch (e) {
            toastr.error(String(e.message || e), 'Test failed');
        }
    });

    $('#as_last').on('click', async () => {
        const body = lastResult ? lastResult.injection : 'Nothing injected yet this session.';
        await callGenericPopup(`<pre class="alwayssearch-pre">${escapeHtml(body)}</pre>`, POPUP_TYPE.TEXT, '', { wide: true, large: true });
    });

    $('#as_reset_prompts').on('click', () => {
        const s = settings();
        s.query_prompt = DEFAULT_QUERY_PROMPT;
        s.template = DEFAULT_TEMPLATE;
        $('#as_query_prompt').val(s.query_prompt);
        $('#as_template').val(s.template);
        save();
    });

    refreshVisibility();
}

function registerCommands() {
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'alwayssearch',
        helpString: 'Turn Always Search on/off. Usage: /alwayssearch on | off | toggle (no argument = show state).',
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({ description: 'on | off | toggle', typeList: [ARGUMENT_TYPE.STRING], isRequired: false, enumList: ['on', 'off', 'toggle'] }),
        ],
        callback: (_args, value) => {
            const s = settings();
            const v = String(value || '').trim().toLowerCase();
            if (v === 'on') s.enabled = true;
            else if (v === 'off') s.enabled = false;
            else if (v === 'toggle') s.enabled = !s.enabled;
            $('#as_enabled').prop('checked', s.enabled);
            save();
            toastr.info(`Always Search is ${s.enabled ? 'ON' : 'OFF'}`);
            return String(s.enabled);
        },
    }));
}

jQuery(async () => {
    settings();
    await initUi();
    registerCommands();

    const { eventSource, eventTypes } = ctx();
    eventSource.on(eventTypes.MESSAGE_RECEIVED, onMessageReceived);
    eventSource.on(eventTypes.CHARACTER_MESSAGE_RENDERED, renderBadge);
    eventSource.on(eventTypes.CHAT_CHANGED, () => setTimeout(renderAllBadges, 100));
    eventSource.on(eventTypes.MESSAGE_SWIPED, (id) => setTimeout(() => renderBadge(id), 50));
    LOG('loaded');
});
