/* ============================================================
 * Laporta Scan · lógica de análisis (compartida)
 * Usada tanto por server.js (local) como por api/*.js (Vercel serverless).
 *
 * Scoring:
 *   globalScore = round( 0.30·Performance + 0.25·SEO + 0.25·AEO
 *                       + 0.10·Accesibilidad + 0.10·BestPractices )
 *   aeoScore    = suma de pesos de los checks AEO/GEO aprobados (total 100)
 * ============================================================ */

const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

const PSI_API_KEY = (process.env.PSI_API_KEY || '').trim();
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const LEAD_WEBHOOK_URL = (process.env.LEAD_WEBHOOK_URL || '').trim();

const UA = 'Mozilla/5.0 (compatible; LaportaScan/1.0; +https://scan.matiaslaporta.com)';

// Crawlers de IA que comprobamos en robots.txt (12)
const AI_BOTS = [
  'GPTBot', 'ChatGPT-User', 'OAI-SearchBot', 'ClaudeBot', 'Claude-Web',
  'anthropic-ai', 'Google-Extended', 'PerplexityBot', 'Applebot-Extended',
  'Meta-ExternalAgent', 'Bytespider', 'CCBot',
];

/* -------------------- utilidades -------------------- */

function normalizeUrl(raw) {
  let u = (raw || '').trim();
  if (!u) return null;
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  try {
    const parsed = new URL(u);
    if (!/^https?:$/.test(parsed.protocol)) return null;
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

/* -------------------- PageSpeed Insights -------------------- */

async function runPSI(url) {
  if (!PSI_API_KEY) return { unavailable: true };
  const params = new URLSearchParams({ url, strategy: 'mobile', key: PSI_API_KEY });
  for (const c of ['PERFORMANCE', 'SEO', 'ACCESSIBILITY', 'BEST_PRACTICES']) params.append('category', c);
  const api = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?${params}`;

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 55000);
  try {
    const res = await fetch(api, { signal: ctrl.signal });
    if (!res.ok) return { unavailable: true, error: `PSI HTTP ${res.status}` };
    const j = await res.json();
    const lh = j.lighthouseResult || {};
    const cats = lh.categories || {};
    const audits = lh.audits || {};
    const pct = (c) => (c && typeof c.score === 'number' ? Math.round(c.score * 100) : 0);
    const metric = (id) => {
      const m = audits[id];
      if (!m) return null;
      return { display: m.displayValue || '—', score: m.score, value: m.numericValue ?? null };
    };
    return {
      strategy: 'mobile',
      scores: {
        performance: pct(cats.performance),
        accessibility: pct(cats.accessibility),
        bestPractices: pct(cats['best-practices']),
        seo: pct(cats.seo),
      },
      coreWebVitals: {
        lcp: metric('largest-contentful-paint'),
        cls: metric('cumulative-layout-shift'),
        fcp: metric('first-contentful-paint'),
        tbt: metric('total-blocking-time'),
        si: metric('speed-index'),
        inp: null,
      },
      opportunities: [],
    };
  } catch (e) {
    return { unavailable: true, error: e.name === 'AbortError' ? 'PSI timeout' : String(e.message || e) };
  } finally {
    clearTimeout(t);
  }
}

/* -------------------- SEO on-page -------------------- */

function analyzeSeo(url, page) {
  const $ = cheerio.load(page.body || '');
  const h = page.headers;
  const finalUrl = page.finalUrl || url;
  const isHttps = /^https:/i.test(finalUrl);

  const title = ($('head > title').first().text() || $('title').first().text() || '').trim();
  const desc = ($('meta[name="description"]').attr('content') || '').trim();
  const keywords = ($('meta[name="keywords"]').attr('content') || '').trim();
  const canonical = ($('link[rel="canonical"]').attr('href') || '').trim();

  const og = {
    title: !!$('meta[property="og:title"]').attr('content'),
    description: !!$('meta[property="og:description"]').attr('content'),
    image: !!$('meta[property="og:image"]').attr('content'),
  };
  const twType = ($('meta[name="twitter:card"]').attr('content') || '').trim();
  const robotsMeta = ($('meta[name="robots"]').attr('content') || '').trim();
  const viewport = ($('meta[name="viewport"]').attr('content') || '').trim();
  const lang = ($('html').attr('lang') || '').trim();

  const hreflangs = $('link[rel="alternate"][hreflang]')
    .map((i, el) => $(el).attr('hreflang')).get().filter(Boolean);

  const h1s = $('h1');
  const headings = {
    h1Count: h1s.length,
    h1First: (h1s.first().text() || '').trim().slice(0, 160),
    h2Count: $('h2').length,
  };

  const imgs = $('img');
  let withoutAlt = 0;
  imgs.each((i, el) => {
    const alt = $(el).attr('alt');
    if (alt === undefined || alt === null || String(alt).trim() === '') withoutAlt++;
  });
  const total = imgs.length;
  const altCoverage = total === 0 ? 100 : Math.round(((total - withoutAlt) / total) * 100);

  // --- Schema.org JSON-LD ---
  const types = [];
  let hasOrg = false, hasFaqPage = false, hasBreadcrumb = false, hasSpeakable = false;
  const ldBlocks = $('script[type="application/ld+json"]');
  ldBlocks.each((i, el) => {
    const raw = $(el).contents().text() || $(el).text();
    let data;
    try { data = JSON.parse(raw); } catch { return; }
    const walk = (node) => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) { node.forEach(walk); return; }
      const t = node['@type'];
      const tlist = Array.isArray(t) ? t : (t ? [t] : []);
      for (const tt of tlist) {
        types.push(String(tt));
        const low = String(tt).toLowerCase();
        if (low === 'organization' || low === 'localbusiness' || low.includes('business') || low === 'corporation') hasOrg = true;
        if (low === 'faqpage') hasFaqPage = true;
        if (low === 'breadcrumblist') hasBreadcrumb = true;
        if (low === 'speakablespecification' || low === 'speakable') hasSpeakable = true;
      }
      if (node.speakable) hasSpeakable = true;
      if (node['@graph']) walk(node['@graph']);
    };
    walk(data);
  });

  const security = {
    https: isHttps,
    hsts: !!(h && h.get('strict-transport-security')),
    xfo: !!(h && h.get('x-frame-options')),
    csp: !!(h && h.get('content-security-policy')),
    cacheControl: !!(h && h.get('cache-control')),
  };

  return {
    url,
    httpStatus: page.status,
    finalUrl,
    isHttps,
    html: { size: Buffer.byteLength(page.body || '') },
    title: { text: title, length: title.length, ok: title.length >= 30 && title.length <= 70 },
    description: { text: desc, length: desc.length, ok: desc.length >= 70 && desc.length <= 320 },
    keywords: { has: !!keywords, value: keywords },
    canonical: { has: !!canonical, value: canonical },
    og,
    twitter: { card: !!twType, type: twType },
    robots: { has: !!robotsMeta, value: robotsMeta },
    viewport: { has: !!viewport, value: viewport },
    lang: { has: !!lang, value: lang },
    hreflangs: { count: hreflangs.length, list: hreflangs },
    headings,
    images: { total, withoutAlt, altCoverage },
    schema: {
      count: ldBlocks.length,
      types: [...new Set(types)],
      hasOrg, hasFaqPage, hasBreadcrumb, hasSpeakable,
    },
    security,
  };
}

/* -------------------- robots.txt / sitemap.xml / llms.txt -------------------- */

function aiBotsAllowed(robotsTxt) {
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
  const blocked = (botLower) => {
    const g = groups.find((gr) => gr.agents.includes(botLower)) || groups.find((gr) => gr.agents.includes('*'));
    if (!g) return false; // sin grupo aplicable → permitido por defecto
    const disallowRoot = g.rules.some((r) => r.type === 'disallow' && r.path === '/');
    const allowRoot = g.rules.some((r) => r.type === 'allow' && (r.path === '/' || r.path === ''));
    return disallowRoot && !allowRoot;
  };
  return AI_BOTS.filter((b) => !blocked(b.toLowerCase()));
}

async function analyzeFiles(origin) {
  const out = {
    robots: { exists: false, hasSitemap: false, aiBotsAllowedCount: 0, aiBotsAllowed: [] },
    sitemap: { exists: false, urlCount: 0 },
    llms: { exists: false, length: 0 },
  };

  await Promise.all([
    fetchUrl(origin + '/robots.txt', { timeout: 8000 }).then((r) => {
      if (r.ok && /(^|\n)\s*(user-agent|disallow|allow|sitemap)\s*:/i.test(r.body)) {
        out.robots.exists = true;
        out.robots.hasSitemap = /(^|\n)\s*sitemap\s*:/i.test(r.body);
        const allowed = aiBotsAllowed(r.body);
        out.robots.aiBotsAllowed = allowed;
        out.robots.aiBotsAllowedCount = allowed.length;
      }
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

/* -------------------- consolidación + recomendaciones -------------------- */

function buildRecommendations(psi, seo, files) {
  const recos = [];
  const add = (severity, area, title, tip) => recos.push({ severity, area, title, tip });

  // --- HIGH ---
  if (!seo.title.ok) add('high', 'SEO', 'Title tag fuera de rango óptimo',
    `El title ideal mide 30-70 caracteres. Actualmente: ${seo.title.length} chars.`);
  if (!seo.description.ok) add('high', 'SEO', 'Meta description fuera de rango',
    `Ideal 70-320 chars con keywords clave. Actualmente: ${seo.description.length} chars.`);
  if (!seo.canonical.has) add('high', 'SEO', 'Falta canonical',
    'Agregar <link rel="canonical" href="..."> para evitar contenido duplicado.');
  if (!files.llms.exists) add('high', 'AEO/LLMO', 'Falta llms.txt',
    'Crear /llms.txt con resumen estructurado del negocio para citaciones de ChatGPT, Claude, Gemini y Perplexity.');
  if (!seo.schema.hasFaqPage) add('high', 'AEO/GEO', 'Sin FAQPage schema',
    'Implementar Schema.org FAQPage con 5-8 Q&A para featured snippets y citaciones AI.');
  if ((files.robots.aiBotsAllowedCount || 0) < 5) add('high', 'LLMO', 'AI crawlers no explícitamente permitidos',
    'Agregar a robots.txt: GPTBot, ChatGPT-User, ClaudeBot, Google-Extended, PerplexityBot, Applebot-Extended, Meta-ExternalAgent, CCBot.');
  if (!seo.isHttps) add('high', 'Security', 'Sin HTTPS',
    'Servir el sitio sobre HTTPS con un certificado válido. Es requisito básico de ranking y confianza.');

  // --- MEDIUM ---
  if (!seo.schema.hasOrg) add('medium', 'SEO', 'Sin Organization schema',
    'Agregar Schema.org Organization/LocalBusiness con name, url, logo, telephone, address y sameAs.');
  if (!seo.security.hsts && seo.isHttps) add('medium', 'Security', 'Falta HSTS',
    'Agregar Strict-Transport-Security header en respuestas HTTPS.');
  if (!seo.og.image) add('medium', 'Social', 'Falta og:image',
    'Crear imagen 1200×630 JPG y agregar <meta property="og:image">.');
  if (seo.headings.h1Count !== 1) add('medium', 'SEO', 'H1 no único',
    `Usar exactamente un <h1> por página. Encontrados: ${seo.headings.h1Count}.`);
  if (!seo.viewport.has) add('medium', 'SEO', 'Sin viewport mobile',
    'Agregar <meta name="viewport" content="width=device-width, initial-scale=1"> para responsive.');
  if (!files.sitemap.exists) add('medium', 'SEO', 'Sin sitemap.xml',
    'Publicar /sitemap.xml y declararlo en robots.txt para acelerar la indexación.');

  // --- LOW ---
  if (!seo.schema.hasSpeakable) add('low', 'AEO', 'Sin SpeakableSpecification',
    'Marcar bloques principales como speakable para asistentes de voz (Siri, Google Assistant).');
  if (!seo.twitter.card) add('low', 'Social', 'Sin Twitter Card',
    'Agregar <meta name="twitter:card" content="summary_large_image">.');
  if ((seo.images.altCoverage || 0) < 90) add('low', 'SEO', 'Imágenes sin alt',
    `${seo.images.withoutAlt} imágenes sin atributo alt (cobertura ${seo.images.altCoverage}%). Mejora accesibilidad y SEO de imágenes.`);

  return recos;
}

function consolidate(psi, seo, files) {
  const checks = [
    { key: 'schema-org', ok: !!seo.schema.hasOrg, weight: 12 },
    { key: 'faq-page', ok: !!seo.schema.hasFaqPage, weight: 18, label: 'FAQPage schema (citaciones LLM)' },
    { key: 'breadcrumb', ok: !!seo.schema.hasBreadcrumb, weight: 8 },
    { key: 'speakable', ok: !!seo.schema.hasSpeakable, weight: 8, label: 'speakable (voice AI)' },
    { key: 'llms-txt', ok: !!files.llms.exists, weight: 15, label: 'llms.txt (estándar LLMO)' },
    { key: 'ai-bots', ok: (files.robots.aiBotsAllowedCount || 0) >= 5, weight: 12, label: 'AI bots permitidos (GPTBot/Claude/Gemini/etc)' },
    { key: 'og-complete', ok: !!(seo.og.title && seo.og.description && seo.og.image), weight: 8 },
    { key: 'twitter-card', ok: !!seo.twitter.card, weight: 5 },
    { key: 'alt-coverage', ok: (seo.images.altCoverage || 0) >= 90, weight: 8 },
    { key: 'h1-single', ok: seo.headings.h1Count === 1, weight: 6 },
  ];
  const aeoScore = checks.reduce((s, c) => s + (c.ok ? c.weight : 0), 0);

  let globalScore;
  if (psi && !psi.unavailable && psi.scores) {
    const s = psi.scores;
    globalScore = Math.round(
      0.30 * s.performance + 0.25 * s.seo + 0.25 * aeoScore + 0.10 * s.accessibility + 0.10 * s.bestPractices
    );
  } else {
    globalScore = aeoScore;
  }

  return { globalScore, aeoScore, aeoChecks: checks, recommendations: buildRecommendations(psi, seo, files) };
}

/* -------------------- API pública del módulo -------------------- */

/**
 * Ejecuta el análisis completo de una URL.
 * Lanza un Error con `.status` (400/502) si algo falla de forma controlada.
 */
async function runScan(rawUrl) {
  const parsed = normalizeUrl(rawUrl);
  if (!parsed) {
    const err = new Error('URL inválida. Ej: tudominio.cl');
    err.status = 400;
    throw err;
  }
  const url = parsed.toString();
  const origin = parsed.origin;
  const t0 = Date.now();

  let page;
  try {
    page = await fetchUrl(url, { timeout: 14000 });
  } catch {
    const err = new Error('No se pudo acceder al sitio. Verifica que la URL sea pública y accesible.');
    err.status = 502;
    throw err;
  }
  if (!page.body) {
    const err = new Error('El sitio no devolvió contenido HTML.');
    err.status = 502;
    throw err;
  }

  const [psi, files] = await Promise.all([runPSI(url), analyzeFiles(origin)]);
  const seo = analyzeSeo(url, page);
  const consolidated = consolidate(psi, seo, files);

  return { url, timing: { ms: Date.now() - t0 }, psi, seo, files, consolidated };
}

/**
 * Guarda un lead. Intenta disco (local), siempre loguea (visible en los logs
 * de la plataforma) y, si hay LEAD_WEBHOOK_URL, lo reenvía y espera la respuesta.
 * En serverless el filesystem es de solo lectura: ahí el webhook es el canal real.
 */
async function saveLead(lead) {
  let persisted = false;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(path.join(DATA_DIR, 'leads.jsonl'), JSON.stringify(lead) + '\n', 'utf8');
    persisted = true;
  } catch {
    // FS de solo lectura (Vercel/serverless) → seguimos con webhook + log
  }

  // Log sin el scanData completo (para no inflar los logs)
  const { scanData, ...slim } = lead;
  console.log('[LEAD]', JSON.stringify(slim));

  if (LEAD_WEBHOOK_URL) {
    try {
      await fetch(LEAD_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(lead),
      });
    } catch (e) {
      console.error('[lead] webhook falló:', e.message);
    }
  }

  return { persisted };
}

module.exports = {
  PSI_API_KEY,
  normalizeUrl,
  runScan,
  saveLead,
};
