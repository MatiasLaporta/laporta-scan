# Envío automático del reporte (Google Apps Script)

Captura cada lead, lo guarda en una Google Sheet y le envía al prospecto un **PDF con tu branding** + un email con CTA para agendar. Todo gratis, usando tu Gmail. No suma infraestructura a la app: esta solo hace `POST` del lead a `LEAD_WEBHOOK_URL`, y este script hace el resto.

## Flujo

```
Prospecto deja sus datos en scan.matiaslaporta.com
        │  (api/lead → saveLead → POST con scanData)
        ▼
LEAD_WEBHOOK_URL  ───►  Apps Script doPost
                          ├─ guarda fila en Google Sheet
                          ├─ genera PDF del reporte (branding + datos)
                          └─ envía email al prospecto (PDF adjunto + CTA agenda)
```

## Pasos (10 min)

1. **Google Sheet**: creá una hoja nueva en https://sheets.new. Copiá su ID de la URL
   (`/spreadsheets/d/`**`ESTE_ID`**`/edit`).
2. **Apps Script**: andá a https://script.new (crea un proyecto nuevo).
   - Borrá el contenido de `Code.gs` y pegá el de [`Code.gs`](./Code.gs).
   - En el bloque `CONFIG` de arriba, completá:
     - `SHEET_ID`: el ID del paso 1.
     - `BOOKING_URL`: tu link real de agenda (Calendly / Google Calendar / etc.).
     - `BCC` y `REPLY_TO`: tu email.
   - Guardá (Ctrl+S).
3. **Deploy como Web App**: botón **Implementar → Nueva implementación** →
   tipo **Aplicación web** → *Ejecutar como:* **Yo** → *Quién tiene acceso:* **Cualquier usuario** → **Implementar**.
   - La primera vez te pide **autorizar permisos** (Gmail + Sheets) → aceptá.
   - Copiá la **URL de la app web** (`https://script.google.com/macros/s/.../exec`).
4. **Vercel**: en el proyecto → **Settings → Environment Variables** agregá
   `LEAD_WEBHOOK_URL` = esa URL. Luego **Deployments → Redeploy**.
5. **Probar**: hacé un scan en producción y dejá tus datos en el formulario.
   Deberías recibir el email con el PDF, y ver la fila en la Sheet.

## Notas

- **Cuota de Gmail**: ~100 emails/día en Gmail gratis (1500 en Workspace). De sobra para un lead tool.
- **Fidelidad del PDF**: el reporte usa tablas + `bgcolor` (no solo CSS) porque el conversor HTML→PDF de Apps Script ignora parte del CSS. Si querés cambiar el diseño, mantené ese patrón.
- **Logo**: usa `scan.matiaslaporta.com/logo-ml-inv.png` (versión clara) sobre franjas oscuras. Si cambiás el logo, actualizá `CONFIG.LOGO_URL`.
- Para actualizar el script luego: **Implementar → Administrar implementaciones → editar (lápiz) → Nueva versión**. La URL no cambia.
