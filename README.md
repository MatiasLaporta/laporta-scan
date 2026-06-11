# Laporta Scan

Auditoría web gratuita: **Performance** (Google PageSpeed Insights) + **SEO técnico** + **AEO/GEO/LLMO** (optimización para crawlers de IA).
Devuelve un **score 0-100**, Core Web Vitals, 22 checks y un **plan de mejoras priorizado**.

Pensado para correr en `https://scan.matiaslaporta.com`.

![stack](https://img.shields.io/badge/node-%3E%3D18-339933) ![license](https://img.shields.io/badge/license-MIT-blue)

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

## Desarrollo local

Requiere **Node.js 18+**.

```bash
npm install
cp .env.example .env      # rellena PSI_API_KEY si la tienes (opcional)
npm start                 # o: npm run dev  (recarga en caliente)
```

Abre http://localhost:3000

### Probar el endpoint directamente

```bash
curl -X POST http://localhost:3000/api/scan \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com"}'
```

---

## Variables de entorno

| Variable | Obligatoria | Descripción |
|---|---|---|
| `PORT` | no | Puerto (default 3000). |
| `PSI_API_KEY` | recomendada | API key de Google PageSpeed Insights. [Conseguir gratis](https://console.cloud.google.com/apis/credentials) (activar "PageSpeed Insights API" · 25.000 req/día gratis). Sin ella: solo SEO + AEO/GEO. |
| `DATA_DIR` | no | Carpeta donde se escribe `leads.jsonl` (default `./data`). |
| `LEAD_WEBHOOK_URL` | no | Si la defines, cada lead se hace POST aquí además de guardarse en disco (Make / Zapier / n8n / Slack / endpoint propio). |

---

## 🔒 Leads y privacidad (repo público)

Los leads contienen datos personales (nombre, email, teléfono) y **nunca** deben quedar en el repositorio.

- Se guardan en `data/leads.jsonl`, que está en **`.gitignore`** → no se commitea.
- En producción, monta `data/` como **volumen persistente** para que los leads sobrevivan a los redeploys.
- Secretos (`PSI_API_KEY`, etc.) van en `.env`, también gitignored. El repo solo incluye `.env.example`.

Cada línea de `leads.jsonl` es un JSON:

```json
{"ts":"2026-06-11T…","name":"…","email":"…","phone":"…","url":"…","score":78,"ip":"…","scanData":{…}}
```

---

## Deploy con Docker

```bash
docker build -t laporta-scan .
docker run -d --name laporta-scan \
  -p 3000:3000 \
  -e PSI_API_KEY=tu_key_aqui \
  -v laporta-scan-data:/app/data \
  laporta-scan
```

### Deploy en Dokploy / Coolify / similar

1. Conecta este repo de GitHub.
2. Tipo de app: **Dockerfile** (ya incluido).
3. Variables de entorno: `PSI_API_KEY` (y opcional `LEAD_WEBHOOK_URL`).
4. Volumen persistente: monta `/app/data`.
5. Dominio: apunta `scan.matiaslaporta.com` al servicio (el proxy maneja HTTPS).

### Subdominio

Crea un registro DNS para `scan.matiaslaporta.com` (A/AAAA o CNAME) apuntando a tu servidor, y configura el dominio en tu plataforma de deploy.

---

## Estructura

```
.
├── server.js          # Backend: /api/scan, /api/lead, /api/health
├── public/
│   └── index.html     # Frontend (single page, sin build step)
├── data/              # leads.jsonl (gitignored)
├── Dockerfile
├── .env.example
└── README.md
```

---

© 2026 · Matías Laporta · Growth Architect · Chile · MIT License
