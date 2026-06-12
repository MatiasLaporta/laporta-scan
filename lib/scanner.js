/* ============================================================
 * Laporta Scan · motor de análisis (v2, basado en evidencia)
 *
 * Diseñado con fuentes 2025-2026:
 *  - Core Web Vitals + INP + datos de campo CrUX (web.dev / Google)
 *  - SEO técnico ponderado por indexabilidad (Google Search Central)
 *  - AEO/GEO según estudios (Princeton GEO KDD'24, Ahrefs, Semrush)
 *
 * El backend devuelve "consolidated" ya listo para render:
 *   categories[], cwv[], cwvSource, seoChecks[], aeoChecks[],
 *   recommendations[], scores{}, globalScore, methodology[]
 * ============================================================ */

const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

const PSI_API_KEY = (process.env.PSI_API_KEY || '').trim();
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const LEAD_WEBHOOK_URL = (process.env.LEAD_WEBHOOK_URL || '').trim();

const UA = 'Mozilla/5.0 (compatible; LaportaScan/2.0; +https://scan.matiaslaporta.com)';

// Bots cuya BLOQUEO sí impacta la visibilidad en motores de IA (citación).
// Nota: Google-Extended NO es la puerta de AI Overviews (esa usa Googlebot),
// por eso no se penaliza bloquearlo.
const AI_SEARCH_BOTS = ['OAI-SearchBot', 'ChatGPT-User', 'PerplexityBot', 'Claude-SearchBot', 'ClaudeBot', 'Googlebot'];

/* ============================================================
 * cache de resultados + rate limit (best-effort)
 *
 * Nota serverless: en Vercel el estado en memoria NO se comparte entre
 * instancias, así que esto es "best-effort" (ayuda en instancias calientes
 * y en el server local/Docker). Para límites estrictos en producción de alto
 * tráfico se usaría un store compartido (Vercel KV / Upstash Redis).
 * ============================================================ */

const SCAN_CACHE = new Map(); // url -> { at, data }
const CACHE_TTL_MS = 10 * 60 * 1000;

function cacheGet(url) {
  const e = SCAN_CACHE.get(url);
  if (e && Date.now() - e.at < CACHE_TTL_MS) return e.data;
  if (e) SCAN_CACHE.delete(url);
  return null;
}
function cacheSet(url, data) {
  SCAN_CACHE.set(url, { at: Date.now(), data });
  if (SCAN_CACHE.size > 300) SCAN_CACHE.delete(SCAN_CACHE.keys().next().value);
}

const RL_HITS = new Map(); // ip -> [timestamps]
const RL_WINDOW_MS = 60 * 1000;
const RL_MAX = 20; // scans por minuto por IP

function rateLimit(ip) {
  if (!ip) return { ok: true };
  const now = Date.now();
  const arr = (RL_HITS.get(ip) || []).filter((t) => now - t < RL_WINDOW_MS);
  if (arr.length >= RL_MAX) return { ok: false, retryAfter: Math.ceil((RL_WINDOW_MS - (now - arr[0])) / 1000) };
  arr.push(now);
  RL_HITS.set(ip, arr);
  if (RL_HITS.size > 5000) RL_HITS.delete(RL_HITS.keys().next().value);
  return { ok: true };
}

/* ============================================================
 * utilidades de red
 * ============================================================ */

function normalizeUrl(raw) {
  let u = (raw || '').trim();
  if (!u) return null;
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  try {
    const parsed = new URL(u);
    if (!/^https?:$/.test(parsed.protocol)) return null;
    // Bloqueo básico anti-SSRF: nada de hosts internos / IPs privadas
    const host = parsed.hostname.toLowerCase();
    if (
      host === 'localhost' || host === '0.0.0.0' || host.endsWith('.local') ||
      /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) ||
      /^169\.254\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
      host === '[::1]'
    ) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function fetchUrl(url, { timeout = 12000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: ctrl.signal,
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,*/*' },
    });
    const body = await res.text();
    return { ok: res.ok, status: res.status, finalUrl: res.url || url, headers: res.headers, body };
  } finally {
    clearTimeout(t);
  }
}

/* ============================================================
 * PageSpeed Insights (lab + campo CrUX)
 * ============================================================ */

const CWV_THRESHOLDS = {
  lcp: { good: 2500, poor: 4000, unit: 'ms' },
  inp: { good: 200, poor: 500, unit: 'ms' },
  cls: { good: 0.1, poor: 0.25, unit: '' },
  fcp: { good: 1800, poor: 3000, unit: 'ms' },
  tbt: { good: 200, poor: 600, unit: 'ms' },
  ttfb: { good: 800, poor: 1800, unit: 'ms' },
  si: { good: 3400, poor: 5800, unit: 'ms' },
};

function metricBand(metric, val) {
  if (val == null) return 'med';
  const t = CWV_THRESHOLDS[metric];
  if (!t) return 'med';
  return val <= t.good ? 'good' : val <= t.poor ? 'med' : 'bad';
}

function catToBand(category) {
  if (category === 'FAST') return 'good';
  if (category === 'AVERAGE') return 'med';
  if (category === 'SLOW') return 'bad';
  return 'med';
}

function fmtMs(v) {
  if (v == null) return '—';
  return v >= 1000 ? (v / 1000).toFixed(1) + ' s' : Math.round(v) + ' ms';
}

function parseField(le) {
  if (!le || !le.metrics) return null;
  const m = le.metrics;
  const one = (key, div) => {
    const x = m[key];
    if (!x || typeof x.percentile !== 'number') return null;
    return { value: div ? x.percentile / div : x.percentile, category: x.category || null };
  };
  const f = {
    lcp: one('LARGEST_CONTENTFUL_PAINT_MS'),
    inp: one('INTERACTION_TO_NEXT_PAINT'),
    cls: one('CUMULATIVE_LAYOUT_SHIFT_SCORE', 100),
    fcp: one('FIRST_CONTENTFUL_PAINT_MS'),
    ttfb: one('EXPERIMENTAL_TIME_TO_FIRST_BYTE'),
  };
  if (!f.lcp && !f.inp && !f.cls) return null;
  return f;
}

// Puntaje 0-100 a partir de las 3 Core Web Vitals de campo (categoría CrUX)
function fieldAssessment(field) {
  const map = { FAST: 95, AVERAGE: 60, SLOW: 30 };
  const vals = [];
  for (const k of ['lcp', 'inp', 'cls']) {
    if (field[k] && field[k].category && map[field[k].category] != null) vals.push(map[field[k].category]);
  }
  if (!vals.length) return null;
  return Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
}

async function runPSI(url) {
  if (!PSI_API_KEY) return { unavailable: true };
  const params = new URLSearchParams({ url, strategy: 'mobile', key: PSI_API_KEY });
  for (const c of ['PERFORMANCE', 'SEO', 'ACCESSIBILITY', 'BEST_PRACTICES']) params.append('category', c);
  const api = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?${params}`;

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 50000);
  try {
    const res = await fetch(api, { signal: ctrl.signal });
    if (!res.ok) return { unavailable: true, error: `PSI HTTP ${res.status}` };
    const j = await res.json();
    const lh = j.lighthouseResult || {};
    const cats = lh.categories || {};
    const audits = lh.audits || {};
    const pct = (c) => (c && typeof c.score === 'number' ? Math.round(c.score * 100) : 0);
    const num = (id) => (audits[id] && typeof audits[id].numericValue === 'number' ? audits[id].numericValue : null);

    // Datos de campo (reales): página, con fallback a origen
    const fieldPage = parseField(j.loadingExperience);
    const fieldOrigin = parseField(j.originLoadingExperience);
    const field = fieldPage || fieldOrigin;
    const fieldSource = fieldPage ? 'page' : (fieldOrigin ? 'origin' : null);

    const lab = {
      lcp: num('largest-contentful-paint'),
      cls: num('cumulative-layout-shift'),
      fcp: num('first-contentful-paint'),
      tbt: num('total-blocking-time'),
      si: num('speed-index'),
    };

    const labScore = pct(cats.performance);
    const fieldScore = field ? fieldAssessment(field) : null;
    // Headline: campo manda (70/30) si existe; si no, lab.
    let performance = labScore;
    let source = 'lab';
    if (fieldScore != null) {
      performance = Math.round(0.7 * fieldScore + 0.3 * labScore);
      source = 'field';
    }

    return {
      strategy: 'mobile',
      source,            // 'field' | 'lab'
      fieldSource,       // 'page' | 'origin' | null
      performance,       // headline 0-100
      scores: {
        performance: labScore,        // score lab puro (Lighthouse)
        accessibility: pct(cats.accessibility),
        bestPractices: pct(cats['best-practices']),
        seo: pct(cats.seo),
      },
      field,             // {lcp,inp,cls,fcp,ttfb} de CrUX o null
      lab,               // métricas lab en ms
    };
  } catch (e) {
    return { unavailable: true, error: e.name === 'AbortError' ? 'PSI timeout' : String(e.message || e) };
  } finally {
    clearTimeout(t);
  }
}

// Construye las tarjetas Core Web Vitals (prefiere campo, cae a lab)
function buildCwv(psi) {
  if (!psi || psi.unavailable) return { source: 'none', tiles: [] };
  const f = psi.field || {};
  const lab = psi.lab || {};
  const tiles = [];

  const push = (key, name, val, band, src) =>
    tiles.push({ key, name, display: val, band, source: src });

  // LCP
  if (f.lcp) push('LCP', 'Largest Contentful Paint', fmtMs(f.lcp.value), catToBand(f.lcp.category), 'campo');
  else push('LCP', 'Largest Contentful Paint', fmtMs(lab.lcp), metricBand('lcp', lab.lcp), 'lab');
  // INP (solo campo)
  if (f.inp) push('INP', 'Interaction to Next Paint', fmtMs(f.inp.value), catToBand(f.inp.category), 'campo');
  else push('INP', 'Interaction to Next Paint', '— (sin datos de campo)', 'med', 'lab');
  // CLS
  if (f.cls) push('CLS', 'Cumulative Layout Shift', f.cls.value.toFixed(2), catToBand(f.cls.category), 'campo');
  else push('CLS', 'Cumulative Layout Shift', lab.cls != null ? lab.cls.toFixed(3) : '—', metricBand('cls', lab.cls), 'lab');
  // FCP
  if (f.fcp) push('FCP', 'First Contentful Paint', fmtMs(f.fcp.value), catToBand(f.fcp.category), 'campo');
  else push('FCP', 'First Contentful Paint', fmtMs(lab.fcp), metricBand('fcp', lab.fcp), 'lab');
  // TBT (siempre lab — proxy de interactividad)
  push('TBT', 'Total Blocking Time', fmtMs(lab.tbt), metricBand('tbt', lab.tbt), 'lab');

  return { source: psi.source === 'field' ? 'field' : 'lab', tiles };
}

/* ============================================================
 * SEO técnico on-page
 * ============================================================ */

function analyzeSeo(url, page) {
  const $ = cheerio.load(page.body || '');
  const h = page.headers;
  const reqUrl = new URL(url);
  const finalUrl = page.finalUrl || url;
  const isHttps = /^https:/i.test(finalUrl);

  const title = ($('head > title').first().text() || $('title').first().text() || '').trim();
  const desc = ($('meta[name="description"]').attr('content') || '').trim();
  const canonical = ($('link[rel="canonical"]').attr('href') || '').trim();

  const og = {
    title: !!$('meta[property="og:title"]').attr('content'),
    description: !!$('meta[property="og:description"]').attr('content'),
    image: !!$('meta[property="og:image"]').attr('content'),
  };
  const twType = ($('meta[name="twitter:card"]').attr('content') || '').trim();
  const robotsMeta = ($('meta[name="robots"]').attr('content') || '').trim().toLowerCase();
  const xRobots = ((h && h.get('x-robots-tag')) || '').toLowerCase();
  const noindex = /\bnoindex\b/.test(robotsMeta) || /\bnoindex\b/.test(xRobots) || /\bnone\b/.test(robotsMeta);
  const viewport = ($('meta[name="viewport"]').attr('content') || '').trim();
  const lang = ($('html').attr('lang') || '').trim();

  const hreflangs = $('link[rel="alternate"][hreflang]')
    .map((i, el) => $(el).attr('hreflang')).get().filter(Boolean);

  const h1s = $('h1');
  const headings = {
    h1Count: h1s.length,
    h1First: (h1s.first().text() || '').trim().slice(0, 160),
    h2Count: $('h2').length,
    h3Count: $('h3').length,
  };

  const imgs = $('img');
  let withoutAlt = 0;
  imgs.each((i, el) => {
    const alt = $(el).attr('alt');
    // alt="" (decorativo) es válido; solo cuenta como falta si el atributo no existe
    if (alt === undefined || alt === null) withoutAlt++;
  });
  const total = imgs.length;
  const altCoverage = total === 0 ? 100 : Math.round(((total - withoutAlt) / total) * 100);

  // Schema.org JSON-LD
  const types = [];
  let hasOrg = false, hasPerson = false, hasArticle = false, hasBreadcrumb = false, jsonLdValid = false;
  const ldBlocks = $('script[type="application/ld+json"]');
  ldBlocks.each((i, el) => {
    const raw = $(el).contents().text() || $(el).text();
    let data;
    try { data = JSON.parse(raw); jsonLdValid = true; } catch { return; }
    const walk = (node) => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) { node.forEach(walk); return; }
      const t = node['@type'];
      const tlist = Array.isArray(t) ? t : (t ? [t] : []);
      for (const tt of tlist) {
        types.push(String(tt));
        const low = String(tt).toLowerCase();
        if (low === 'organization' || low === 'localbusiness' || low.includes('business') || low === 'corporation') hasOrg = true;
        if (low === 'person') hasPerson = true;
        if (low === 'article' || low === 'newsarticle' || low === 'blogposting') hasArticle = true;
        if (low === 'breadcrumblist') hasBreadcrumb = true;
      }
      if (node.author) hasPerson = true;
      for (const k of Object.keys(node)) {
        if (node[k] && typeof node[k] === 'object') walk(node[k]);
      }
    };
    walk(data);
  });

  const security = {
    https: isHttps,
    hsts: !!(h && h.get('strict-transport-security')),
    csp: !!(h && h.get('content-security-policy')),
    xfo: !!(h && h.get('x-frame-options')),
    xcto: !!(h && h.get('x-content-type-options')),
  };

  // canonical: ¿es self o cross? (heurístico)
  let canonicalSelf = false, canonicalCross = false;
  if (canonical) {
    try {
      const cu = new URL(canonical, finalUrl);
      canonicalSelf = cu.host === reqUrl.host;
      canonicalCross = cu.host !== reqUrl.host;
    } catch {}
  }

  return {
    url,
    httpStatus: page.status,
    finalUrl,
    redirected: finalUrl.replace(/\/$/, '') !== url.replace(/\/$/, ''),
    isHttps,
    indexable: page.status >= 200 && page.status < 300 && !noindex,
    noindex,
    html: { size: Buffer.byteLength(page.body || '') },
    title: { text: title, length: title.length, ok: title.length >= 30 && title.length <= 60 },
    description: { text: desc, length: desc.length, ok: desc.length >= 70 && desc.length <= 160 },
    canonical: { has: !!canonical, value: canonical, self: canonicalSelf, cross: canonicalCross },
    og,
    twitter: { card: !!twType, type: twType },
    robotsMeta: { has: !!robotsMeta, value: robotsMeta, noindex },
    viewport: { has: !!viewport, value: viewport, responsive: /width\s*=\s*device-width/i.test(viewport) },
    lang: { has: !!lang, value: lang },
    hreflangs: { count: hreflangs.length, list: hreflangs },
    headings,
    images: { total, withoutAlt, altCoverage },
    schema: { count: ldBlocks.length, valid: jsonLdValid, types: [...new Set(types)], hasOrg, hasPerson, hasArticle, hasBreadcrumb },
    security,
    _$: $, // cheerio reutilizable para el análisis de contenido
  };
}

/* ============================================================
 * AEO / GEO / LLMO · análisis de CONTENIDO (basado en evidencia)
 * ============================================================ */

function countSyllables(word) {
  const w = word.toLowerCase().replace(/[^a-záéíóúüñ]/g, '');
  if (!w) return 0;
  const groups = w.match(/[aeiouyáéíóúü]+/g);
  return Math.max(1, groups ? groups.length : 1);
}

function analyzeContent(url, seo) {
  const $ = seo._$;
  const lang = (seo.lang && seo.lang.value) || '';
  const pageHost = (() => { try { return new URL(url).host; } catch { return ''; } })();

  // Texto visible principal (sin chrome de la página)
  const root = $('main').first().length ? $('main').first()
    : ($('article').first().length ? $('article').first() : $('body'));
  const clone = root.clone();
  clone.find('script,style,noscript,nav,header,footer,aside,svg,form,iframe').remove();
  const text = (clone.text() || '').replace(/\s+/g, ' ').trim();
  const words = text ? text.split(/\s+/).filter(Boolean) : [];
  const wordCount = words.length;
  const sentences = Math.max(1, (text.match(/[.!?…]+(\s|$)/g) || []).length);

  // 1) Estadísticas / datos
  const statMatches =
    (text.match(/\d+([.,]\d+)?\s?%/g) || []).length +
    (text.match(/[$€£]\s?\d+([.,]\d+)?/g) || []).length +
    (text.match(/\b\d{1,3}(?:[.,]\d{3})+(?:[.,]\d+)?\b/g) || []).length +
    (text.match(/\b\d+([.,]\d+)?\s?(millones|millón|mil|billones|veces|x|usd|clp|eur|dólares|pesos)\b/gi) || []).length;
  const statDensity = wordCount ? +(statMatches / (wordCount / 100)).toFixed(2) : 0;
  const statsOk = statMatches >= 3 && statDensity >= 0.5;

  // 2) Citas / fuentes externas
  let outbound = 0;
  $('a[href]').each((i, el) => {
    try { const hh = new URL($(el).attr('href'), url).host; if (hh && hh !== pageHost) outbound++; } catch {}
  });
  const blockquotes = $('blockquote').length;
  const citationsOk = outbound >= 3 || blockquotes >= 1;

  // 3) Respuesta directa al inicio (answer-first)
  let firstParaWords = 0;
  root.find('p').slice(0, 4).each((i, el) => {
    const w = ($(el).text() || '').trim().split(/\s+/).filter(Boolean).length;
    if (w > firstParaWords) firstParaWords = w;
  });
  const answerFirstOk = firstParaWords >= 40;

  // 4) Legibilidad — fórmula según idioma (Flesch EN / Fernández-Huerta ES)
  const sample = words.slice(0, 3000);
  let syl = 0; for (const w of sample) syl += countSyllables(w);
  const wps = sample.length / sentences;        // palabras por frase
  const spw = sample.length ? syl / sample.length : 0; // sílabas por palabra
  const isEn = /^en/i.test(lang || '');         // sin lang asumimos español (mercado CL)
  let flesch = isEn
    ? 206.835 - 1.015 * wps - 84.6 * spw
    : 206.84 - 60 * spw - 1.02 * wps;            // Fernández-Huerta (español)
  flesch = Math.max(0, Math.min(100, Math.round(flesch)));
  const readabilityOk = wordCount >= 100 && flesch >= 50;

  // 5) Listas y tablas
  const lists = $('ul li, ol li').length ? ($('ul').length + $('ol').length) : 0;
  const tables = $('table').length;
  const formattingOk = lists >= 1 || tables >= 1;

  // 6) Frescura (fecha publicada / modificada)
  let pubDate = null;
  const dateCandidates = [
    $('meta[property="article:modified_time"]').attr('content'),
    $('meta[property="article:published_time"]').attr('content'),
    $('meta[name="date"]').attr('content'),
    $('time[datetime]').first().attr('datetime'),
  ];
  $('script[type="application/ld+json"]').each((i, el) => {
    try {
      const d = JSON.parse($(el).contents().text() || $(el).text());
      const scan = (n) => {
        if (!n || typeof n !== 'object') return;
        if (Array.isArray(n)) return n.forEach(scan);
        if (n.dateModified) dateCandidates.push(n.dateModified);
        if (n.datePublished) dateCandidates.push(n.datePublished);
        for (const k of Object.keys(n)) if (n[k] && typeof n[k] === 'object') scan(n[k]);
      };
      scan(d);
    } catch {}
  });
  for (const c of dateCandidates) {
    if (!c) continue;
    const t = Date.parse(c);
    if (!isNaN(t) && (!pubDate || t > pubDate)) pubDate = t;
  }
  const ageDays = pubDate ? Math.round((Date.now() - pubDate) / 86400000) : null;
  const freshnessOk = !!pubDate;

  // 7) Headings tipo pregunta
  let questionHeadings = 0;
  $('h2, h3').each((i, el) => { if (/\?\s*$/.test(($(el).text() || '').trim())) questionHeadings++; });
  const questionsOk = questionHeadings >= 1;

  // 8) Schema de entidad (Organization / Person·Author)
  const entityOk = seo.schema.hasOrg || seo.schema.hasPerson;

  // 9) HTML semántico
  const semanticOk = $('main').length > 0 || $('article').length > 0;

  // SPA / contenido renderizado por JS: HTML casi vacío + marcadores de framework.
  // Relevante para AEO: los crawlers de IA suelen NO ejecutar JS (SearchVIU 2025),
  // así que ven el HTML crudo — un sitio CSR es poco visible para ChatGPT/Perplexity.
  const spaMarkers = $('#root, #__next, #app, [data-reactroot], app-root, [ng-version], [data-server-rendered]').length;
  const jsRendered = wordCount < 250 && spaMarkers > 0;

  return {
    wordCount,
    thin: wordCount < 200,
    jsRendered,
    stats: { count: statMatches, density: statDensity, ok: statsOk },
    citations: { outbound, blockquotes, ok: citationsOk },
    answerFirst: { firstParaWords, ok: answerFirstOk },
    readability: { flesch, ok: readabilityOk },
    formatting: { lists, tables, ok: formattingOk },
    freshness: { hasDate: !!pubDate, ageDays, ok: freshnessOk },
    questions: { count: questionHeadings, ok: questionsOk },
    entity: { hasOrg: seo.schema.hasOrg, hasPerson: seo.schema.hasPerson, ok: entityOk },
    semantic: { ok: semanticOk },
  };
}

/* ============================================================
 * robots.txt / sitemap.xml / llms.txt
 * ============================================================ */

function botBlocked(robotsTxt, botLower) {
  const lines = robotsTxt.split(/\r?\n/);
  const groups = [];
  let current = null;
  for (const raw of lines) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const field = m[1].toLowerCase();
    const val = m[2].trim();
    if (field === 'user-agent') {
      if (current && current.started) current = null;
      if (!current) { current = { agents: [], rules: [], started: false }; groups.push(current); }
      current.agents.push(val.toLowerCase());
    } else if (current && (field === 'disallow' || field === 'allow')) {
      current.started = true;
      current.rules.push({ type: field, path: val });
    }
  }
  const g = groups.find((gr) => gr.agents.includes(botLower)) || groups.find((gr) => gr.agents.includes('*'));
  if (!g) return false; // sin grupo → permitido por defecto
  const disallowRoot = g.rules.some((r) => r.type === 'disallow' && r.path === '/');
  const allowRoot = g.rules.some((r) => r.type === 'allow' && (r.path === '/' || r.path === ''));
  return disallowRoot && !allowRoot;
}

async function analyzeFiles(origin) {
  const out = {
    robots: { exists: false, hasSitemap: false, aiSearchBlocked: [], allowsAiSearch: true },
    sitemap: { exists: false, urlCount: 0 },
    llms: { exists: false, length: 0 },
  };

  await Promise.all([
    fetchUrl(origin + '/robots.txt', { timeout: 8000 }).then((r) => {
      if (r.ok && /(^|\n)\s*(user-agent|disallow|allow|sitemap)\s*:/i.test(r.body)) {
        out.robots.exists = true;
        out.robots.hasSitemap = /(^|\n)\s*sitemap\s*:/i.test(r.body);
        const blocked = AI_SEARCH_BOTS.filter((b) => botBlocked(r.body, b.toLowerCase()));
        out.robots.aiSearchBlocked = blocked;
        out.robots.allowsAiSearch = blocked.length === 0;
      }
      // Sin robots.txt → todo permitido por defecto (allowsAiSearch = true)
    }).catch(() => {}),

    fetchUrl(origin + '/sitemap.xml', { timeout: 8000 }).then((r) => {
      if (r.ok && /<(urlset|sitemapindex|loc)\b/i.test(r.body)) {
        out.sitemap.exists = true;
        out.sitemap.urlCount = (r.body.match(/<loc>/gi) || []).length;
      }
    }).catch(() => {}),

    fetchUrl(origin + '/llms.txt', { timeout: 8000 }).then((r) => {
      const head = (r.body || '').slice(0, 200).toLowerCase();
      if (r.ok && r.body && r.body.trim() && !head.includes('<html') && !head.includes('<!doctype')) {
        out.llms.exists = true;
        out.llms.length = Buffer.byteLength(r.body);
      }
    }).catch(() => {}),
  ]);

  return out;
}

/* ============================================================
 * scoring + recomendaciones
 * ============================================================ */

function band(v) { return v >= 90 ? 'good' : v >= 50 ? 'med' : 'bad'; }

// --- SEO sub-score (0-100), ponderado por indexabilidad ---
function scoreSeo(seo, files) {
  const checks = [
    { key: 'http', ok: seo.httpStatus >= 200 && seo.httpStatus < 300, weight: 12,
      label: 'Estado HTTP 200', detail: `HTTP ${seo.httpStatus}${seo.redirected ? ' · con redirección' : ''}` },
    { key: 'indexable', ok: !seo.noindex, weight: 13,
      label: 'Indexable (sin noindex)', detail: seo.noindex ? '⚠ bloqueado con noindex' : 'sin meta/X-Robots noindex' },
    { key: 'canonical', ok: seo.canonical.has && !seo.canonical.cross, weight: 10,
      label: 'Canonical válido', detail: seo.canonical.has ? (seo.canonical.cross ? 'apunta a otro dominio' : seo.canonical.value) : 'sin canonical' },
    { key: 'https', ok: seo.isHttps, weight: 10,
      label: 'HTTPS activo', detail: seo.isHttps ? 'conexión segura' : 'no HTTPS (factor de ranking)' },
    { key: 'title', ok: seo.title.text.length > 0, weight: 8,
      label: 'Title presente', detail: seo.title.text ? seo.title.text.slice(0, 60) : 'sin title' },
    { key: 'title-len', ok: seo.title.ok, weight: 7,
      label: 'Largo del title', detail: `${seo.title.length} chars · ideal 50-60` },
    { key: 'desc', ok: seo.description.length > 0, weight: 5,
      label: 'Meta description presente', detail: seo.description.length ? 'presente' : 'sin meta description' },
    { key: 'desc-len', ok: seo.description.ok, weight: 3,
      label: 'Largo de la description', detail: `${seo.description.length} chars · ideal ~155` },
    { key: 'h1', ok: seo.headings.h1Count >= 1, weight: 7,
      label: 'Tiene H1', detail: `${seo.headings.h1Count} H1 · ${seo.headings.h2Count} H2` },
    { key: 'viewport', ok: seo.viewport.responsive, weight: 8,
      label: 'Viewport mobile', detail: seo.viewport.responsive ? 'width=device-width' : 'sin viewport responsive' },
    { key: 'alt', ok: seo.images.altCoverage >= 90, weight: 7,
      label: 'Imágenes con alt', detail: `${seo.images.altCoverage}% · ${seo.images.withoutAlt} sin alt` },
    { key: 'lang', ok: seo.lang.has, weight: 4,
      label: 'Idioma declarado', detail: seo.lang.has ? `lang="${seo.lang.value}"` : 'sin lang en <html>' },
    { key: 'schema', ok: seo.schema.count > 0 && seo.schema.valid, weight: 4,
      label: 'Datos estructurados', detail: seo.schema.count ? `${seo.schema.count} JSON-LD · ${seo.schema.types.slice(0, 3).join(', ')}` : 'sin JSON-LD' },
    { key: 'social', ok: (seo.og.title && seo.og.image) || seo.twitter.card, weight: 2,
      label: 'Open Graph / Twitter', detail: (() => {
        const p = [];
        if (seo.og.title) p.push('og:title');
        if (seo.og.image) p.push('og:image');
        if (seo.twitter.card) p.push('twitter:card');
        return p.length ? p.join(' · ') : 'sin Open Graph ni Twitter Card';
      })() },
  ];
  let score = checks.reduce((s, c) => s + (c.ok ? c.weight : 0), 0);
  // Gate: si no es indexable, el SEO real es ~nulo
  if (seo.noindex || seo.httpStatus >= 400 || seo.httpStatus < 200) score = Math.min(score, 25);
  return { score: Math.round(score), checks };
}

// --- AEO/GEO sub-score (0-100), basado en evidencia ---
function scoreAeo(content, files, seo) {
  const checks = [
    { key: 'stats', ok: content.stats.ok, weight: 18,
      label: 'Estadísticas y datos', detail: `${content.stats.count} datos · ${content.stats.density}/100 palabras` },
    { key: 'citations', ok: content.citations.ok, weight: 18,
      label: 'Citas y fuentes externas', detail: `${content.citations.outbound} enlaces externos · ${content.citations.blockquotes} citas` },
    { key: 'answer-first', ok: content.answerFirst.ok, weight: 14,
      label: 'Respuesta directa al inicio', detail: content.answerFirst.ok ? `intro de ${content.answerFirst.firstParaWords} palabras` : 'sin párrafo de respuesta arriba' },
    { key: 'readability', ok: content.readability.ok, weight: 10,
      label: 'Legibilidad / fluidez', detail: `Flesch ${content.readability.flesch}/100` },
    { key: 'formatting', ok: content.formatting.ok, weight: 10,
      label: 'Listas y tablas', detail: `${content.formatting.lists} listas · ${content.formatting.tables} tablas` },
    { key: 'freshness', ok: content.freshness.ok, weight: 10,
      label: 'Frescura (fecha)', detail: content.freshness.hasDate ? (content.freshness.ageDays != null ? `actualizado hace ${content.freshness.ageDays} días` : 'fecha presente') : 'sin fecha de publicación' },
    { key: 'questions', ok: content.questions.ok, weight: 7,
      label: 'Headings tipo pregunta', detail: `${content.questions.count} preguntas en H2/H3` },
    { key: 'entity', ok: content.entity.ok, weight: 8,
      label: 'Schema de entidad', detail: content.entity.hasOrg ? 'Organization' : (content.entity.hasPerson ? 'Person/Author' : 'sin Organization/Person') },
    { key: 'semantic', ok: content.semantic.ok, weight: 5,
      label: 'HTML semántico', detail: content.semantic.ok ? '<main>/<article> presente' : 'sin <main>/<article>' },
  ];
  let score = checks.reduce((s, c) => s + (c.ok ? c.weight : 0), 0);
  // Gate: bots de citación de IA bloqueados → penalización fuerte
  if (!files.robots.allowsAiSearch) score = Math.round(score * 0.6);
  // Contenido muy delgado → tope
  if (content.thin) score = Math.min(score, 45);
  return { score: Math.round(score), checks, aiBlocked: !files.robots.allowsAiSearch };
}

function buildRecommendations(psi, seo, content, files, seoRes, aeoRes) {
  const recos = [];
  const add = (severity, area, title, tip) => recos.push({ severity, area, title, tip });

  // CRÍTICAS — indexabilidad / acceso
  if (seo.noindex) add('high', 'Indexación', 'Página marcada como noindex',
    'La página le dice a Google que NO la indexe. Si debe aparecer en búsquedas, quita la directiva noindex (meta robots o header X-Robots-Tag).');
  if (seo.httpStatus >= 400) add('high', 'Indexación', `La URL responde HTTP ${seo.httpStatus}`,
    'Una página que no devuelve 200 no se indexa. Revisa el estado del servidor o la URL.');
  if (!seo.isHttps) add('high', 'Seguridad', 'Sin HTTPS',
    'HTTPS es un factor de ranking confirmado y requisito de confianza. Instala un certificado y fuerza https.');
  if (files.robots.exists && !files.robots.allowsAiSearch) add('high', 'AEO/LLMO', 'Bloqueas crawlers de IA de citación',
    `robots.txt bloquea: ${files.robots.aiSearchBlocked.join(', ')}. Para aparecer en ChatGPT/Perplexity/AI Overviews, permite OAI-SearchBot, PerplexityBot, Claude-SearchBot y Googlebot.`);
  if (content.jsRendered) add('high', 'AEO/GEO', 'Contenido renderizado por JavaScript',
    'El HTML servido casi no tiene contenido (se arma con JS en el navegador). Los crawlers de IA (ChatGPT, Claude, Perplexity) normalmente NO ejecutan JS, así que ven la página vacía y no pueden citarte. Usa renderizado en servidor (SSR) o prerender.');

  // AEO/GEO — palancas con evidencia
  if (!content.stats.ok) add('high', 'AEO/GEO', 'Falta densidad de datos',
    'Los LLMs citan contenido con datos: agrega estadísticas, cifras y porcentajes concretos (estudio de Princeton: +30-40% de visibilidad).');
  if (!content.citations.ok) add('high', 'AEO/GEO', 'Faltan citas y fuentes',
    'Citar fuentes externas y agregar citas textuales es de los factores con mayor lift para ser citado por motores de IA. Enlaza fuentes autoritativas.');
  if (!content.answerFirst.ok) add('medium', 'AEO/GEO', 'Sin respuesta directa arriba',
    'Pon una respuesta clara y concisa en el primer párrafo. Los motores de IA extraen respuestas del inicio del contenido.');
  if (!content.freshness.ok) add('medium', 'AEO/GEO', 'Sin fecha visible',
    'Agrega fecha de publicación/actualización (schema Article o <time>). La frescura correlaciona con ser citado.');
  if (!content.formatting.ok) add('medium', 'AEO/GEO', 'Sin listas ni tablas',
    'Estructura el contenido con listas y tablas: facilita que los motores de IA extraigan y reusen la información.');
  if (!content.readability.ok && content.wordCount >= 100) add('low', 'AEO/GEO', 'Legibilidad mejorable',
    'Frases más cortas y lenguaje claro suben la "fluidez", un factor que mejora la visibilidad en motores generativos.');
  if (!content.questions.ok) add('low', 'AEO/GEO', 'Sin headings tipo pregunta',
    'Usa H2/H3 con la pregunta que responde cada sección (ej: "¿Cuánto cuesta…?"). Ayuda a mapear consultas conversacionales.');

  // SEO técnico
  if (!seo.title.ok) add('medium', 'SEO', 'Title fuera de rango',
    `El title ideal mide 50-60 caracteres. Actualmente: ${seo.title.length}.`);
  if (seo.description.length === 0) add('medium', 'SEO', 'Falta meta description',
    'Agrega una meta description única de ~155 caracteres. No es factor de ranking pero mejora el CTR en buscadores.');
  if (!seo.canonical.has) add('medium', 'SEO', 'Falta canonical',
    'Agrega <link rel="canonical"> autoreferenciado para consolidar señales y evitar duplicados.');
  if (!seo.viewport.responsive) add('medium', 'SEO', 'Sin viewport mobile',
    'Agrega <meta name="viewport" content="width=device-width, initial-scale=1">. Google indexa mobile-first.');
  if (seo.images.altCoverage < 90 && seo.images.total > 0) add('low', 'SEO', 'Imágenes sin alt',
    `${seo.images.withoutAlt} imágenes sin alt (cobertura ${seo.images.altCoverage}%). Mejora accesibilidad y SEO de imágenes.`);
  if (!seo.schema.hasOrg) add('low', 'SEO', 'Sin Organization schema',
    'Agrega Schema.org Organization con name, url, logo y sameAs: ayuda a la resolución de entidad en el Knowledge Graph.');

  // Performance
  if (psi && !psi.unavailable && psi.performance < 50) add('high', 'Performance', 'Rendimiento bajo',
    'El rendimiento está en rojo. Optimiza imágenes, reduce JS que bloquea y mejora el LCP para no perder usuarios ni ranking.');

  // Higiene (no ranking, pero profesional)
  if (seo.isHttps && !seo.security.hsts) add('low', 'Seguridad', 'Falta HSTS',
    'Agrega Strict-Transport-Security. No afecta ranking, pero es buena práctica de seguridad.');

  return recos;
}

function consolidate(psi, seo, content, files) {
  const seoRes = scoreSeo(seo, files);
  const aeoRes = scoreAeo(content, files, seo);

  const perf = psi && !psi.unavailable ? psi.performance : null;
  const a11y = psi && !psi.unavailable ? psi.scores.accessibility : null;
  const bp = psi && !psi.unavailable ? psi.scores.bestPractices : null;

  let globalScore;
  if (perf != null) {
    globalScore = Math.round(
      0.25 * perf + 0.30 * seoRes.score + 0.25 * aeoRes.score + 0.10 * a11y + 0.10 * bp
    );
  } else {
    // Sin PSI: reponderamos sobre lo medible (SEO + AEO)
    globalScore = Math.round(seoRes.score * 0.55 + aeoRes.score * 0.45);
  }

  // Categorías para la fila de tiles
  const categories = [];
  if (perf != null) categories.push({ lbl: 'Performance', val: perf, band: band(perf), source: psi.source });
  categories.push({ lbl: 'SEO técnico', val: seoRes.score, band: band(seoRes.score) });
  categories.push({ lbl: 'AEO/GEO/LLMO', val: aeoRes.score, band: band(aeoRes.score) });
  if (a11y != null) categories.push({ lbl: 'Accesibilidad', val: a11y, band: band(a11y) });
  if (bp != null) categories.push({ lbl: 'Best Practices', val: bp, band: band(bp) });

  const cwv = buildCwv(psi);

  const recommendations = buildRecommendations(psi, seo, content, files, seoRes, aeoRes);

  return {
    globalScore,
    band: band(globalScore),
    scores: { performance: perf, seo: seoRes.score, aeo: aeoRes.score, accessibility: a11y, bestPractices: bp },
    categories,
    cwv: cwv.tiles,
    cwvSource: cwv.source,
    seoChecks: seoRes.checks.map((c) => ({ ok: c.ok, label: c.label, detail: c.detail })),
    aeoChecks: aeoRes.checks.map((c) => ({ ok: c.ok, label: c.label, detail: c.detail })),
    aiBlocked: aeoRes.aiBlocked,
    recommendations,
    methodology: [
      'Performance: Google PageSpeed Insights — datos de campo (CrUX, usuarios reales) con respaldo en lab (Lighthouse).',
      'Core Web Vitals: LCP, INP (reemplazó a FID en 2024) y CLS según umbrales oficiales de web.dev.',
      'SEO: ponderado por indexabilidad (Google Search Central). HSTS/CSP no son factores de ranking.',
      'AEO/GEO: factores con evidencia (Princeton GEO KDD’24, Ahrefs, Semrush): datos, citas, respuesta directa, frescura.',
      'Análisis del HTML servido (como lo ven los crawlers de IA). Si el sitio se renderiza con JavaScript, el contenido visible para IA puede ser menor al real.',
    ],
  };
}

/* ============================================================
 * API pública
 * ============================================================ */

async function runScan(rawUrl) {
  const parsed = normalizeUrl(rawUrl);
  if (!parsed) {
    const err = new Error('URL inválida o no permitida. Ej: tudominio.cl');
    err.status = 400;
    throw err;
  }
  const url = parsed.toString();
  const origin = parsed.origin;
  const t0 = Date.now();

  const hit = cacheGet(url);
  if (hit) return { ...hit, cached: true };

  // Página, PSI y archivos en paralelo (PSI solo necesita la URL, no el HTML).
  const pageP = fetchUrl(url, { timeout: 14000 }).catch(() => null);
  const [page, psi, files] = await Promise.all([pageP, runPSI(url), analyzeFiles(origin)]);

  if (!page) {
    const err = new Error('No se pudo acceder al sitio. Verifica que la URL sea pública y accesible.');
    err.status = 502;
    throw err;
  }
  if (!page.body) {
    const err = new Error('El sitio no devolvió contenido HTML.');
    err.status = 502;
    throw err;
  }

  const seo = analyzeSeo(url, page);
  const content = analyzeContent(url, seo);
  const consolidated = consolidate(psi, seo, content, files);

  // No serializamos la instancia de cheerio
  delete seo._$;

  const result = { url, timing: { ms: Date.now() - t0 }, psi, seo, content, files, consolidated };
  cacheSet(url, result);
  return result;
}

async function saveLead(lead) {
  let persisted = false;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(path.join(DATA_DIR, 'leads.jsonl'), JSON.stringify(lead) + '\n', 'utf8');
    persisted = true;
  } catch {
    // FS de solo lectura (Vercel/serverless) → webhook + log
  }
  const { scanData, ...slim } = lead;
  console.log('[LEAD]', JSON.stringify(slim));
  if (LEAD_WEBHOOK_URL) {
    try {
      await fetch(LEAD_WEBHOOK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(lead) });
    } catch (e) {
      console.error('[lead] webhook falló:', e.message);
    }
  }
  return { persisted };
}

module.exports = { PSI_API_KEY, normalizeUrl, runScan, saveLead, rateLimit };
