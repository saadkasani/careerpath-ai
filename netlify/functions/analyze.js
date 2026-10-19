// POST /.netlify/functions/analyze
// body: { cvFile?: {mime:'application/pdf', data: base64}, cvText?: string, lang: "en" | "ar" }
// Only the CV is needed. The model works out the person's field and target role from it.
// The API key lives only here (env var), never in the browser.

const SOURCES = require('./sources.js');
const DOMAINS = SOURCES.map((s) => s.domain);
const CATALOG = require('./catalog.json');
const ACTIVE = CATALOG.filter((c) => c.status !== 'ended');
const BY_ID = new Map(ACTIVE.map((c) => [c.id, c]));
const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-5-5';
const API_URL = 'https://api.anthropic.com/v1/messages';
const SEARCH = process.env.ENABLE_SEARCH === '1'; // web search is slow; catalog-only by default
const MAX_CV = 15000;
const MAX_PDF_BYTES = 3.5 * 1024 * 1024;

const SYSTEM = () => `You are a career advisor for TECHNICAL fields only: software and web development, data and AI, databases, cybersecurity, networks and cloud, DevOps, UX/UI, software testing, and similar IT roles.\nIf the CV clearly belongs to a non-technical field (for example medicine, law, accounting, teaching), do not analyze it. Answer with exactly {"supported": false, "field": "<the field you detected>"} and nothing else.\nIf the CV is technical, "supported" is true.
Read the CV, work out the person's field and the role they are best placed to target next, then compare the CV with what employers in Saudi Arabia usually expect for that role. Find the skill gaps, then use web search to find REAL courses and learning resources for each missing skill.
Verified course catalog (id | title | platform | tags). PREFER these: for each gap, list matching catalog ids in "catalogIds". Never write a URL for them.
${ACTIVE.map((c) => `${c.id} | ${c.title} | ${c.platform}${c.region === 'sa' ? ' (Saudi)' : ''} | ${c.tags.join(', ')}`).join('\n')}
Rules:
- Choose only from the catalog ids above. Prefer Saudi entries; add an international one when it fits better or no Saudi entry fits. If nothing fits a skill, leave catalogIds empty. Never write URLs.${SEARCH ? ' You may use web search only when the catalog has nothing for a skill, and then only recommend resources you actually found.' : ''}
- Be concise: at most 5 gaps, 2 catalog ids per gap, short sentences, at most 6 path steps.
- Web search (if used) is limited to these Saudi platforms: ${SOURCES.map((s) => `${s.name} (${s.domain})`).join('; ')}.
- Answer with ONE JSON object and nothing else, in this shape:
{
 "supported": true,
 "field": string,
 "targetRole": string,
 "matchPercent": number 0-100 (how ready the person is for that role),
 "summary": string,
 "strengths": [string],
 "gaps": [{"skill": string, "importance": "high"|"medium"|"low", "why": string,
           "catalogIds": [string],
           "resources": [{"title": string, "provider": string, "url": string, "type": "course"|"book"|"docs"|"project", "free": boolean}]}],
 "path": [{"step": number, "skill": string, "action": string, "weeks": number}]
}
Write all text values in the requested language.`;

const json = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json; charset=utf-8' },
  body: JSON.stringify(body),
});

// Pull the first balanced {...} object out of a text block.
function extractJson(text) {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) {
      try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; }
    }
  }
  return null;
}

// URLs that the search tool really returned.
function searchedUrls(content) {
  const urls = new Set();
  for (const block of content) {
    if (block.type === 'web_search_tool_result' && Array.isArray(block.content)) {
      for (const r of block.content) if (r.url) urls.add(normalize(r.url));
    }
  }
  return urls;
}

function isSaudiDomain(u) {
  try {
    const host = new URL(u).hostname.toLowerCase();
    return DOMAINS.some((d) => host === d || host.endsWith('.' + d));
  } catch { return false; }
}

function normalize(u) {
  try {
    const x = new URL(u);
    return (x.origin + x.pathname).replace(/\/+$/, '').toLowerCase();
  } catch { return ''; }
}

async function isAlive(url, fetchImpl, timeoutMs = 6000) {
  if (!/^https:\/\//i.test(url)) return false;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { method: 'GET', redirect: 'follow', signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0 CareerPathAI link-check' } });
    return res.status < 400 || res.status === 403; // some sites block bots but exist
  } catch { return false; }
  finally { clearTimeout(t); }
}

// Keep only links that (1) came from the search results and (2) respond.
async function keepRealLinks(result, found, fetchImpl) {
  for (const gap of result.gaps || []) {
    const checked = await Promise.all((gap.resources || []).map(async (r) => {
      const ok = isSaudiDomain(r.url) && found.has(normalize(r.url)) && await isAlive(r.url, fetchImpl);
      return ok ? r : null;
    }));
    const fromSearch = checked.filter(Boolean).map((r) => ({ ...r, source: 'search' }));
    const fromCatalog = [...new Set(gap.catalogIds || [])].map((id) => BY_ID.get(id)).filter(Boolean).map((c) => ({
      title: c.title, provider: c.platform, url: c.url, type: 'course', free: c.free ?? null, source: 'catalog', region: c.region,
    }));
    delete gap.catalogIds;
    gap.resources = [...fromCatalog, ...fromSearch.filter((r) => !fromCatalog.some((c) => normalize(c.url) === normalize(r.url)))];
  }
  return result;
}

function buildContent({ cvText, cvFile, cvImages, lang }) {
  const intro = `Language: ${lang === 'ar' ? 'Arabic' : 'English'}\n\n`;
  if (cvImages && cvImages.length) {
    return [
      { type: 'text', text: intro + 'The CV is in the attached page images (in order).' },
      ...cvImages.map((data) => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } })),
    ];
  }
  if (cvFile) {
    return [
      { type: 'text', text: intro + 'The CV is the attached PDF.' },
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: cvFile.data } },
    ];
  }
  return `${intro}CV:\n${cvText}`;
}

async function run({ cvText, cvFile, cvImages, lang }, { apiKey, fetchImpl = fetch } = {}) {
  const res = await fetchImpl(API_URL, {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 2500,
      system: SYSTEM(),
      ...(SEARCH ? { tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 2, allowed_domains: DOMAINS }] } : {}),
      messages: [{ role: 'user', content: buildContent({ cvText, cvFile, cvImages, lang }) }],
    }),
  });
  if (!res.ok) throw new Error(`Claude API ${res.status}: ${(await res.text().catch(() => '')).slice(0, 400)}`);
  const data = await res.json();
  const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  const parsed = extractJson(text);
  if (!parsed) throw new Error('Could not read the model answer');
  if (parsed.supported === false) return { supported: false, field: String(parsed.field || '') };
  return keepRealLinks(parsed, searchedUrls(data.content || []), fetchImpl);
}

// Validates the request body. Returns { cvText, cvFile, lang } or { error, status }.
function parseRequest(raw) {
  let body;
  try { body = JSON.parse(raw || '{}'); } catch { return { status: 400, error: 'Invalid JSON' }; }
  let cvText = '';
  let cvFile = null;
  let cvImages = null;
  if (Array.isArray(body.cvImages) && body.cvImages.length) {
    cvImages = body.cvImages.slice(0, 3).map(String);
    if (cvImages.some((d) => !/^[A-Za-z0-9+/=]+$/.test(d) || d.length > 400000)) return { status: 400, error: 'Bad images' };
  } else if (body.cvFile) {
    const data = String(body.cvFile.data || '');
    const bytes = Buffer.from(data, 'base64');
    if (body.cvFile.mime !== 'application/pdf' || bytes.slice(0, 4).toString() !== '%PDF') return { status: 400, error: 'Only PDF files are supported' };
    if (bytes.length > MAX_PDF_BYTES) return { status: 400, error: 'File is too large' };
    cvFile = { data };
  } else {
    cvText = String(body.cvText || '').trim();
    if (cvText.length < 50) return { status: 400, error: 'CV is too short' };
    if (cvText.length > MAX_CV) return { status: 400, error: 'Text is too long' };
  }
  return { cvText, cvFile, cvImages, lang: body.lang === 'ar' ? 'ar' : 'en', jobId: body.jobId };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Use POST' });
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return json(500, { error: 'Server is missing ANTHROPIC_API_KEY' });
  const req = parseRequest(event.body);
  if (req.error) return json(req.status, { error: req.error });
  try {
    return json(200, await run(req, { apiKey }));
  } catch (e) {
    console.error('[analyze] failed:', e && e.message);
    return json(502, { error: 'Analysis failed, please try again', detail: process.env.NETLIFY_DEV ? String(e && e.message) : undefined });
  }
};

exports.run = run;
exports.parseRequest = parseRequest;
exports._test = { CATALOG, extractJson, searchedUrls, normalize, keepRealLinks, run, buildContent, isSaudiDomain };
