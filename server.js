/* ============================================================
 * Laporta Scan · servidor local (desarrollo)
 *
 * Para producción usamos Vercel serverless (carpeta /api). Este server
 * replica esos endpoints con Express para poder probar en local con
 * `npm start`. La lógica vive en lib/scanner.js (compartida con /api).
 * ============================================================ */

// Carga variables desde .env si el archivo existe (Node 20.12+).
// En producción (Vercel) las inyecta la plataforma, así que esto es no-op allí.
try { process.loadEnvFile(); } catch { /* sin .env → usa el env del sistema */ }

const express = require('express');
const path = require('path');
const { runScan, saveLead, rateLimit, PSI_API_KEY } = require('./lib/scanner');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '3mb' }));

// Frontend
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.post('/api/scan', async (req, res) => {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim();
  const rl = rateLimit(ip);
  if (!rl.ok) {
    res.set('Retry-After', String(rl.retryAfter));
    return res.status(429).json({ error: `Demasiados análisis seguidos. Espera ${rl.retryAfter}s e intenta de nuevo.` });
  }
  try {
    const result = await runScan(req.body && req.body.url);
    res.json(result);
  } catch (e) {
    const status = e.status || 500;
    res.status(status).json({ error: e.status ? e.message : 'Error interno al analizar la URL.' });
    if (!e.status) console.error('[scan] error:', e);
  }
});

app.post('/api/lead', async (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim();
  const email = String(b.email || '').trim();
  if (!name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.status(400).json({ error: 'Nombre y email válido son obligatorios.' });
  }
  const lead = {
    ts: new Date().toISOString(),
    name,
    email,
    phone: String(b.phone || '').trim(),
    url: String(b.url || '').trim(),
    score: Number(b.score) || 0,
    ip: (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim(),
    scanData: b.scanData || null,
  };
  try {
    await saveLead(lead);
    res.json({ ok: true });
  } catch (e) {
    console.error('[lead] error:', e);
    res.status(500).json({ error: 'No se pudo guardar el lead.' });
  }
});

app.get('/api/health', (req, res) => res.json({ ok: true, psi: !!PSI_API_KEY }));

app.listen(PORT, () => {
  console.log(`▸ Laporta Scan (local) escuchando en http://localhost:${PORT}`);
  console.log(`  PSI_API_KEY: ${PSI_API_KEY ? 'configurada ✓' : 'no configurada (solo SEO + AEO/GEO)'}`);
});
