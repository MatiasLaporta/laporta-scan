# Envío automático del reporte (Apps Script + MailerSend)

Captura cada lead, lo guarda en una Google Sheet, genera un **PDF con tu branding** y se lo envía al prospecto por email con un **CTA para agendar**. El envío sale por **MailerSend desde el subdominio `send.matiaslaporta.com`**, para aislar la reputación de spam de tu dominio y correo principal. MailerSend es gratis (3.000 emails/mes), es transaccional puro y **no agrega marca de agua** al email.

## Flujo

```
Prospecto deja sus datos en scan.matiaslaporta.com
        │  (api/lead → saveLead → POST con scanData)
        ▼
LEAD_WEBHOOK_URL  ───►  Apps Script doPost
                          ├─ guarda fila en Google Sheet
                          ├─ genera PDF del reporte (branding + datos)
                          └─ POST a MailerSend → email desde scan@send.matiaslaporta.com
                                                  (PDF adjunto + CTA agenda)
```

División de tareas: **Apps Script** hace la Sheet y el **PDF** (gratis, sin infra). **MailerSend** hace el **envío** firmado por el subdominio (reputación aislada, sin marca de agua).

---

## Parte 1 · MailerSend + subdominio (DNS)

1. Creá cuenta gratis en **https://www.mailersend.com** (3.000 emails/mes). Te pueden pedir una breve aprobación de cuenta.
2. **Domains → Add domain** → escribí **`send.matiaslaporta.com`**.
3. MailerSend te muestra los **registros DNS** a agregar (verificación TXT + SPF + DKIM (CNAME) + Return-Path/CNAME). Copialos tal cual.
4. **Namecheap → Domain List → `matiaslaporta.com` → Manage → Advanced DNS → Add New Record.**
   Pegá lo que da MailerSend. ⚠️ **Clave de Namecheap:** el campo *Host* es **relativo** al dominio
   (no pongas `.matiaslaporta.com` al final). Ejemplos típicos (usá EXACTO lo que muestre tu panel):

   | MailerSend dice (nombre completo)              | Type  | Host en Namecheap            | Value (lo da MailerSend)            |
   |------------------------------------------------|-------|------------------------------|-------------------------------------|
   | `send.matiaslaporta.com`                       | TXT   | `send`                       | `v=spf1 include:_spf.mailersend.net ~all` |
   | `mlsend2._domainkey.send.matiaslaporta.com`    | CNAME | `mlsend2._domainkey.send`    | `mlsend2._domainkey.mailersend.net` |
   | `mta.send.matiaslaporta.com` (Return-Path)     | CNAME | `mta.send`                   | `…mailersend.net` (lo da el panel)  |
   | (verificación) `…send.matiaslaporta.com`       | TXT   | `send`                       | el string de verificación que dé    |

   > Regla: al *nombre completo* que da MailerSend, **quitale `.matiaslaporta.com`** → eso va en *Host*.
   > Para registros **CNAME**, en Namecheap el valor no lleva punto final.
5. Volvé a MailerSend → **Verify**. Tarda de minutos a ~1 h en propagar. Cuando quede verificado, podés enviar a cualquier destinatario.
6. **Settings → API tokens → Generate new token** (permiso de *Email · Full access* o *Send*). Copiá el token. Lo usás en la Parte 3.

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
   `FROM_EMAIL`/`FROM_NAME` ya están como `scan@send.matiaslaporta.com` / `Matías Laporta`.
4. **El token NO va en el código.** Andá a **⚙ Configuración del proyecto →
   Propiedades del script → Agregar propiedad**: nombre `MAILERSEND_API_KEY`, valor el token de MailerSend del paso 6.
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
   y ver la fila en la Sheet. (Si el dominio aún no está verificado en MailerSend, el envío fallará: verificá primero.)

---

## Notas

- **Reputación**: todo el envío sale firmado por `send.matiaslaporta.com` (SPF+DKIM). Si algo cae en spam, no afecta a `matiaslaporta.com` ni a tu correo.
- **Fidelidad del PDF**: el conversor HTML→PDF de Apps Script ignora parte del CSS, por eso el reporte usa tablas + `bgcolor`. Mantené ese patrón si lo editás.
- **Actualizar el script**: **Implementar → Administrar implementaciones → editar (lápiz) → Nueva versión**. La URL no cambia.
- **Cambiar el remitente**: editá `CONFIG.FROM_EMAIL` (debe ser una dirección del subdominio verificado en MailerSend).
