// Lee y parsea el body JSON de una request, tanto si Vercel ya lo parseó
// (req.body) como si llega el stream crudo. El prefijo "_" evita que Vercel
// lo trate como un endpoint.
async function readJsonBody(req) {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'string') {
      try { return JSON.parse(req.body); } catch { return {}; }
    }
    return req.body;
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

module.exports = { readJsonBody };
