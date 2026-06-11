// Vercel serverless function → POST /api/scan
const { runScan } = require('../lib/scanner');
const { readJsonBody } = require('./_body');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
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
