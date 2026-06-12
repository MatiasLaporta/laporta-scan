// Vercel serverless function → POST /api/scan
const { runScan, rateLimit } = require('../lib/scanner');
const { readJsonBody } = require('./_body');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').toString().split(',')[0].trim();
  const rl = rateLimit(ip);
  if (!rl.ok) {
    res.setHeader('Retry-After', rl.retryAfter);
    res.status(429).json({ error: `Demasiados análisis seguidos. Espera ${rl.retryAfter}s e intenta de nuevo.` });
    return;
  }
  try {
    const body = await readJsonBody(req);
    const result = await runScan(body && body.url);
    res.status(200).json(result);
  } catch (e) {
    const status = e.status || 500;
    res.status(status).json({ error: e.status ? e.message : 'Error interno al analizar la URL.' });
    if (!e.status) console.error('[scan] error:', e);
  }
};
