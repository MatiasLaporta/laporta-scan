# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Qué es

Laporta Scan: auditoría web gratuita (Performance + SEO técnico + AEO/GEO/LLMO) que devuelve un score 0-100, Core Web Vitals, checks y un plan de mejoras priorizado. Es una herramienta de captación de prospectos para Matías Laporta (Growth Architect). Idioma del producto y de los commits: **español**.

## Comandos

```bash
npm install
npm start            # server local en http://localhost:3000 (Express)
npm run dev          # igual, con recarga en caliente (node --watch)
```

No hay tests, linter ni build step. Probar el endpoint directamente:

```bash
curl -X POST http://localhost:3000/api/scan -H "Content-Type: application/json" -d '{"url":"example.com"}'
```

En Windows/PowerShell, para reiniciar el server hay que liberar el puerto 3000 (un `Ctrl+C` no siempre mata el proceso en background):

```powershell
Get-NetTCPConnection -LocalPort 3000 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
```

`server.js` carga `.env` automáticamente con `process.loadEnvFile()` (Node ≥20.12). Para activar Performance/Core Web Vitals en local, poné `PSI_API_KEY` en `.env` (copiá de `.env.example`).

## Arquitectura

Dualidad clave: **producción es Vercel serverless, pero `server.js` existe solo para desarrollo local.** Ambos comparten toda la lógica en `lib/scanner.js` — ahí es donde se trabaja.

```
index.html        Frontend (single page, sin framework ni build) — Vercel lo sirve en /
api/scan.js       Vercel function → POST /api/scan   (handler delgado)
api/lead.js       Vercel function → POST /api/lead   (handler delgado)
api/_body.js      helper de parseo de body (el prefijo "_" evita que Vercel lo trate como endpoint)
lib/scanner.js    TODA la lógica: scoring, fetch, cache, rate-limit, leads
server.js         Express SOLO para local; replica /api/scan y /api/lead usando lib/scanner.js
vercel.json       maxDuration 60s (un scan PSI tarda ~15-50s)
```

Regla práctica: cualquier cambio de comportamiento va en `lib/scanner.js`. Los handlers (`api/*.js`, `server.js`) solo hacen rate-limit + parseo + llamar a `runScan`/`saveLead`. Si tocás la firma de un export, actualizá los **tres** consumidores (`api/scan.js`, `api/lead.js`, `server.js`).

### Flujo de un scan (`runScan` en lib/scanner.js)
1. `normalizeUrl` valida y bloquea hosts internos/IPs privadas (anti-SSRF).
2. Cache por URL (TTL 10 min) — si hay hit, devuelve con `cached: true`.
3. En paralelo: fetch del HTML, `runPSI` (PageSpeed Insights), `analyzeFiles` (robots.txt/sitemap.xml/llms.txt).
4. `analyzeSeo` (parseo con cheerio) → `analyzeContent` (análisis de texto para AEO) → `consolidate`.
5. `consolidate` arma el objeto `consolidated` **ya listo para render** (categories, cwv, seoChecks, aeoChecks, recommendations, scores, methodology). **El frontend es genérico: no contiene lógica de scoring, solo pinta lo que llega.** Para cambiar qué se muestra, editá `consolidate`/`scoreSeo`/`scoreAeo`, no el HTML.

### Modelo de scoring (basado en evidencia, no en hype)
Es el core del producto y está justificado con fuentes 2025-2026 (web.dev, paper Princeton GEO KDD'24, Ahrefs, Semrush). Decisiones deliberadas que NO hay que revertir sin releer la evidencia:

- **Global** = `0.25·Performance + 0.30·SEO + 0.25·AEO + 0.10·Accesibilidad + 0.10·BestPractices`. Sin `PSI_API_KEY`: reponderado sobre SEO(0.55)+AEO(0.45).
- **Performance**: prefiere datos de campo **CrUX** (usuarios reales, `loadingExperience`/`originLoadingExperience`) y cae a lab (Lighthouse) solo si no hay tráfico. Blend campo/lab 70/30. Mide **INP** (reemplazó a FID en 2024), no SI.
- **SEO** (sub-score ponderado): la indexabilidad es un *gate* (noindex/HTTP→tope 25). "Un solo H1" **no** penaliza (mito). HSTS/CSP están **fuera** del score (no son factores de ranking; van como higiene).
- **AEO/GEO** (reescrito por evidencia): mide datos/estadísticas, citas/fuentes, respuesta directa, legibilidad (Flesch EN / Fernández-Huerta ES según idioma), listas/tablas, frescura, headings-pregunta, schema de entidad, HTML semántico. **Eliminados a propósito: FAQPage, llms.txt y word-count** (sin evidencia / deprecados). Gate de bots de citación = OAI-SearchBot/PerplexityBot/Claude/Googlebot; **Google-Extended no penaliza**; sin robots.txt = permitido. Detecta sitios renderizados por JS (SPA) y lo marca como hallazgo AEO (los crawlers de IA no ejecutan JS).

### Leads y persistencia
`saveLead` intenta escribir `data/leads.jsonl` (funciona en local/Docker) y, si está, hace POST a `LEAD_WEBHOOK_URL`. **En Vercel el filesystem es de solo lectura**: los leads NO se persisten en disco; el canal real es `LEAD_WEBHOOK_URL` (+ logs de la función). `data/leads.jsonl` y `.env` están en `.gitignore` — nunca se commitean (repo público).

### Cache y rate-limit
En memoria (Map) dentro de `lib/scanner.js`. **Best-effort en serverless**: Vercel no comparte memoria entre instancias, así que cache y rate-limit (20/min por IP → 429) funcionan plenamente en local/Docker y parcialmente en Vercel. Para límites estrictos a escala se necesitaría Vercel KV/Upstash.

## Deploy

Producción en Vercel (auto-deploy en cada push a `main`). `PSI_API_KEY` y `LEAD_WEBHOOK_URL` van como Environment Variables en Vercel, nunca en el repo. El `Dockerfile` es una alternativa para hosts con Docker (ahí `server.js` corre como servidor real y los leads sí persisten en el volumen `/app/data`).

## Notas

- Plataforma de desarrollo: Windows. Usar el patrón de PowerShell de arriba para matar el server por puerto.
- GitHub: el remoto es `MatiasLaporta/laporta-scan` (cuenta `gh` activa: `MatiasLaporta`, no `MatiasDigitals`).
