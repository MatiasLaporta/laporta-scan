# Envío automático del reporte (Apps Script + Resend)

Captura cada lead, lo guarda en una Google Sheet, genera un **PDF con tu branding** y se lo envía al prospecto por email con un **CTA para agendar**. El envío sale por **Resend desde el subdominio `send.matiaslaporta.com`**, para aislar la reputación de spam de tu dominio y correo principal.

## Flujo

```
Prospecto deja sus datos en scan.matiaslaporta.com
        │  (api/lead → saveLead → POST con scanData)
        ▼
LEAD_WEBHOOK_URL  ───►  Apps Script doPost
                          ├─ guarda fila en Google Sheet
                          ├─ genera PDF del reporte (branding + datos)
                          └─ POST a Resend → email desde scan@send.matiaslaporta.com
                                              (PDF adjunto + CTA agenda)
```

División de tareas: **Apps Script** hace la Sheet y el **PDF** (gratis, sin infra). **Resend** hace el **envío** firmado por el subdominio (reputación aislada).

---

## Parte 1 · Resend + subdominio (DNS)

1. Creá cuenta gratis en **https://resend.com** (3.000 emails/mes, 100/día).
2. **Domains → Add Domain** → escribí **`send.matiaslaporta.com`**. Elegí región (ej. `us-east-1`).
3. Resend te muestra **3–4 registros DNS** (MX, SPF, DKIM y opcional DMARC). Copialos tal cual.
4. **Namecheap → Domain List → `matiaslaporta.com` → Manage → Advanced DNS → Add New Record.**
   Pegá lo que da Resend. ⚠️ **Clave de Namecheap:** el campo *Host* es **relativo** al dominio
   (no pongas `.matiaslaporta.com` al final). Ejemplos según lo que muestre Resend:

   | Resend dice (nombre completo)                 | Type | Host en Namecheap            | Value                              |
   |-----------------------------------------------|------|------------------------------|------------------------------------|
   | `send.matiaslaporta.com`                      | MX   | `send`                       | `feedback-smtp.us-east-1…` (prio 10) |
   | `send.matiaslaporta.com`                      | TXT  | `send`                       | `v=spf1 include:amazonses.com ~all` |
   | `resend._domainkey.send.matiaslaporta.com`    | TXT  | `resend._domainkey.send`     | `p=MIGf…` (clave larga DKIM)        |
   | `_dmarc.send.matiaslaporta.com`               | TXT  | `_dmarc.send`                | `v=DMARC1; p=none;`                 |

   > Regla: al *nombre completo* que da Resend, **quitale `.matiaslaporta.com`** → eso va en *Host*.
5. Volvé a Resend → **Verify**. Tarda de minutos a ~1 h en propagar. Cuando quede ✅ verde, podés enviar a cualquier destinatario.
6. **API Keys → Create API Key** (permiso *Sending access*). Copiá la key (empieza con `re_…`). La usás en la Parte 2.

---

## Parte 2 · Google Sheet

1. Creá una hoja nueva en **https://sheets.new**.
2. El **SHEET_ID** está en la URL, entre `/d/` y `/edit`:
   `https://docs.google.com/spreadsheets/d/`**`ESTE_ID`**`/edit` → copiá solo esa cadena.

---

## Parte 3 · Apps Script

1. Andá a **https://script.new** (proyecto nuevo).
2. Borrá `Code.gs` y pegá el de [`Code.gs`](./Code.gs).
3. En `CONFIG` completá: `SHEET_ID`, `BOOKING_URL` (tu link de agenda real), `BCC`/`REPLY_TO`.
   `FROM` ya está como `Matías Laporta <scan@send.matiaslaporta.com>`.
4. **La API key NO va en el código.** Andá a **⚙ Configuración del proyecto →
   Propiedades del script → Agregar propiedad**: nombre `RESEND_API_KEY`, valor la key `re_…` del paso 6.
5. Guardá (Ctrl+S).
6. **Implementar → Nueva implementación → Aplicación web** → *Ejecutar como:* **Yo** →
   *Quién tiene acceso:* **Cualquier usuario** → **Implementar**. Autorizá los permisos (Sheets + conexiones externas).
7. Copiá la **URL de la app web** (`https://script.google.com/macros/s/.../exec`).

---

## Parte 4 · Conectar la app (Vercel)

1. **Vercel → proyecto → Settings → Environment Variables**: agregá
   `LEAD_WEBHOOK_URL` = la URL del paso 7.
2. **Deployments → … → Redeploy**.
3. **Probar**: hacé un scan en producción y dejá tus datos. Deberías recibir el email con el PDF,
   y ver la fila en la Sheet. (Si Resend aún no está verificado, solo te llegará a tu propio email.)

---

## Notas

- **Reputación**: todo el envío sale firmado por `send.matiaslaporta.com` (SPF+DKIM+DMARC). Si algo cae en spam, no afecta a `matiaslaporta.com` ni a tu correo.
- **Fidelidad del PDF**: el conversor HTML→PDF de Apps Script ignora parte del CSS, por eso el reporte usa tablas + `bgcolor`. Mantené ese patrón si lo editás.
- **Actualizar el script**: **Implementar → Administrar implementaciones → editar (lápiz) → Nueva versión**. La URL no cambia.
- **Cambiar el remitente**: editá `CONFIG.FROM` (debe ser una dirección del subdominio verificado en Resend).
