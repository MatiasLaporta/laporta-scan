// Vercel serverless function → POST /api/lead
const { saveLead } = require('../lib/scanner');
const { readJsonBody } = require('./_body');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  try {
    const b = (await readJsonBody(req)) || {};
    const name = String(b.name || '').trim();
    const email = String(b.email || '').trim();
    if (!name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      res.status(400).json({ error: 'Nombre y email válido son obligatorios.' });
      return;
    }

    const lead = {
      ts: new Date().toISOString(),
      name,
      email,
      phone: String(b.phone || '').trim(),
      url: String(b.url || '').trim(),
      score: Number(b.score) || 0,
      ip: (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').toString().split(',')[0].trim(),
      scanData: b.scanData || null,
    };

    await saveLead(lead);
    res.status(200).json({ ok: true });
  } catch (e) {
    console.error('[lead] error:', e);
    res.status(500).json({ error: 'No se pudo guardar el lead.' });
  }
};
