# Laporta Scan

Auditoría web gratuita: **Performance** (Google PageSpeed Insights) + **SEO técnico** + **AEO/GEO/LLMO** (optimización para crawlers de IA).
Devuelve un **score 0-100**, Core Web Vitals, 22 checks y un **plan de mejoras priorizado**.

Pensado para correr en `https://scan.matiaslaporta.com` (deploy en **Vercel**).

![stack](https://img.shields.io/badge/node-%3E%3D18-339933) ![deploy](https://img.shields.io/badge/deploy-vercel-black) ![license](https://img.shields.io/badge/license-MIT-blue)

---

## ¿Cómo funciona el scoring?

```
globalScore = round( 0.30·Performance + 0.25·SEO + 0.25·AEO
                   + 0.10·Accesibilidad + 0.10·BestPractices )
```

- **Performance, SEO, Accesibilidad y Best Practices** vienen de la API de Google PageSpeed Insights (Lighthouse).
- **AEO/GEO/LLMO** es un score propio 0-100 = suma de pesos de los checks aprobados:

| Check | Peso |
|---|---|
| FAQPage schema | 18 |
| llms.txt | 15 |
| Schema.org Organization | 12 |
| AI bots permitidos (GPTBot/Claude/Gemini…) | 12 |
| BreadcrumbList | 8 |
| Speakable (voice AI) | 8 |
| Open Graph completo | 8 |
| Cobertura de `alt` en imágenes | 8 |
| H1 único | 6 |
| Twitter Card | 5 |

> Si **no** hay `PSI_API_KEY` configurada, el scan funciona igual pero solo muestra SEO + AEO/GEO, y `globalScore = aeoScore`.

---

## Estructura

```
.
├── index.html         # Frontend (single page, sin build step) → servido en /
├── api/
│   ├── scan.js        # Vercel serverless function → POST /api/scan
│   ├── lead.js        # Vercel serverless function → POST /api/lead
│   └── _body.js       # helper (parseo de body)
├── lib/
│   └── scanner.js     # Lógica compartida: PSI + SEO + AEO/GEO + leads
├── server.js          # Servidor Express SOLO para desarrollo local (npm start)
├── vercel.json        # Config Vercel (maxDuration 60s para el scan)
├── Dockerfile         # Alternativa: deploy en cualquier host con Docker
├── .env.example
└── README.md
```

---

## Desarrollo local

Requiere **Node.js 18+**.

```bash
npm install
cp .env.example .env      # rellena PSI_API_KEY si la tienes (opcional)
npm start                 # levanta http://localhost:3000
```

`server.js` lee `.env` automáticamente (`process.loadEnvFile`). Prueba el endpoint:

```bash
curl -X POST http://localhost:3000/api/scan \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com"}'
```

---

## Deploy en Vercel (recomendado)

Vercel sirve `index.html` como estático y convierte cada archivo de `api/` en una serverless function. Se redespliega solo en cada `git push`.

1. Entra a **https://vercel.com** e inicia sesión con GitHub.
2. **Add New… → Project** → importa el repo `MatiasLaporta/laporta-scan`.
3. Framework Preset: **Other** (no hay build step). Deja todo por defecto → **Deploy**.
4. Cuando termine, ve a **Settings → Environment Variables** y agrega:
   - `PSI_API_KEY` = tu clave de PageSpeed Insights *(opcional pero recomendado)*.
   - `LEAD_WEBHOOK_URL` = destino de leads *(ver abajo)*.
5. Vuelve a **Deployments → … → Redeploy** para que tome las variables.

### Dominio `scan.matiaslaporta.com`

En **Settings → Domains** agrega `scan.matiaslaporta.com`. Vercel te dirá qué registro DNS crear (normalmente un `CNAME` → `cname.vercel-dns.com`). HTTPS lo gestiona Vercel automático.

---

## ⚠️ Leads en serverless

En Vercel el filesystem es **de solo lectura**: no se puede guardar `leads.jsonl` en disco como en local. Por eso los leads se entregan así:

1. **`LEAD_WEBHOOK_URL`** (recomendado): si la defines, cada lead se hace POST a esa URL y se espera la respuesta. Sirve para conectar:
   - una hoja de **Google Sheets** (vía Google Apps Script Web App),
   - **Make / Zapier / n8n**,
   - **Slack/Discord** (incoming webhook),
   - o un endpoint propio.
2. **Logs de Vercel**: además, cada lead se imprime como `[LEAD] {...}` en los logs de la función (Deployments → función → Logs). Útil de respaldo, no como canal principal.

> En **local**, los leads sí se guardan en `data/leads.jsonl` (gitignored).

---

## Variables de entorno

| Variable | Dónde | Descripción |
|---|---|---|
| `PSI_API_KEY` | Vercel / `.env` | API key de Google PageSpeed Insights. [Conseguir gratis](https://console.cloud.google.com/apis/credentials) (activar "PageSpeed Insights API" · 25.000 req/día). Sin ella: solo SEO + AEO/GEO. |
| `LEAD_WEBHOOK_URL` | Vercel / `.env` | Destino de los leads (ver sección de leads). |
| `DATA_DIR` | local | Carpeta de `leads.jsonl` en local (default `./data`). |
| `PORT` | local | Puerto del server local (default 3000). |

🔒 **Nunca** subas la API key al repo. Vive en las Environment Variables de Vercel (o en `.env`, que está en `.gitignore`).

---

## Deploy alternativo con Docker

Si en el futuro usas un VPS/host con Docker (en vez de Vercel), el `Dockerfile` corre `server.js` como servidor normal y los leads sí persisten en el volumen `/app/data`:

```bash
docker build -t laporta-scan .
docker run -d -p 3000:3000 -e PSI_API_KEY=tu_key -v laporta-scan-data:/app/data laporta-scan
```

---

© 2026 · Matías Laporta · Growth Architect · Chile · MIT License
