/* ============================================================
 * Laporta Scan · Google Apps Script (Web App)
 *
 * Recibe el lead que envía la app (POST a LEAD_WEBHOOK_URL), lo guarda
 * en una Google Sheet, genera un PDF con branding a partir de los datos
 * del scan y lo envía por email al prospecto con un CTA para agendar.
 *
 * Setup: ver apps-script/README.md
 * ============================================================ */

// ===== CONFIG · completá estos valores =====
const CONFIG = {
  // ID de tu Google Sheet (lo sacás de la URL: /spreadsheets/d/<ESTE_ID>/edit). Vacío = no guarda en Sheet.
  SHEET_ID: '',
  SHEET_NAME: 'Leads',
  // Tu link de agenda (Calendly, Google Calendar appointments, etc.). Cambialo por el real.
  BOOKING_URL: 'https://matiaslaporta.com',
  // Copia oculta para vos (para enterarte de cada lead). '' para desactivar.
  BCC: 'matias@digitals.cl',
  FROM_NAME: 'Matías Laporta',
  // Email al que el prospecto puede responder.
  REPLY_TO: 'matias@digitals.cl',
  // Logo (claro/invertido) servido por la app. Va sobre la franja oscura del PDF/email.
  LOGO_URL: 'https://scan.matiaslaporta.com/logo-ml-inv.png',
  SITE_URL: 'https://scan.matiaslaporta.com',
};

// Paleta (para el PDF/email)
const C = {
  bg: '#12162f', card: '#1c2143', blue: '#1a2b56', steel: '#2f5972',
  cyan: '#45b8c0', yellow: '#f3cd74', red: '#e8736f',
  ink: '#1c2143', muted: '#5b6580', line: '#e3e7ef', white: '#ffffff',
};

function doGet() {
  return ContentService.createTextOutput('Laporta Scan webhook · OK');
}

function doPost(e) {
  try {
    const lead = JSON.parse(e.postData.contents);
    appendToSheet_(lead);
    sendReport_(lead);
    return json_({ ok: true });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/* ---------- Google Sheet ---------- */
function appendToSheet_(lead) {
  if (!CONFIG.SHEET_ID) return;
  const ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  let sh = ss.getSheetByName(CONFIG.SHEET_NAME) || ss.insertSheet(CONFIG.SHEET_NAME);
  if (sh.getLastRow() === 0) {
    sh.appendRow(['Fecha', 'Nombre', 'Email', 'WhatsApp', 'URL', 'Score', 'IP']);
  }
  sh.appendRow([new Date(), lead.name || '', lead.email || '', lead.phone || '',
    lead.url || '', lead.score || '', lead.ip || '']);
}

/* ---------- Email + PDF ---------- */
function sendReport_(lead) {
  const cs = (lead.scanData && lead.scanData.consolidated) || {};
  const host = cleanHost_(lead.url);

  const pdfHtml = buildReportHtml_(lead, cs, host);
  const pdf = Utilities.newBlob(pdfHtml, 'text/html', 'reporte.html')
    .getAs('application/pdf')
    .setName('Auditoria-' + host + '.pdf');

  MailApp.sendEmail({
    to: lead.email,
    bcc: CONFIG.BCC || '',
    name: CONFIG.FROM_NAME,
    replyTo: CONFIG.REPLY_TO || '',
    subject: 'Tu auditoría web · ' + host + ' · score ' + (cs.globalScore != null ? cs.globalScore : '–') + '/100',
    htmlBody: buildEmailHtml_(lead, cs, host),
    attachments: [pdf],
  });
}

/* ---------- helpers ---------- */
function cleanHost_(url) {
  try { return String(url || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '') || 'tu-sitio'; }
  catch (e) { return 'tu-sitio'; }
}
function esc_(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function bandColor_(b) { return b === 'good' ? C.cyan : (b === 'med' ? C.yellow : C.red); }
function sevColor_(s) { return s === 'high' ? C.red : (s === 'medium' ? C.yellow : C.cyan); }
function sevLabel_(s) { return s === 'high' ? 'ALTA' : (s === 'medium' ? 'MEDIA' : 'BAJA'); }

function catRows_(cats) {
  return (cats || []).map(function (c) {
    var col = bandColor_(c.band);
    return '<tr>' +
      '<td style="padding:7px 0;font-size:13px;color:' + C.ink + ';">' + esc_(c.lbl) + '</td>' +
      '<td width="55%" style="padding:7px 0;">' +
        '<table cellpadding="0" cellspacing="0" width="100%"><tr>' +
        '<td bgcolor="' + C.line + '" style="height:8px;border-radius:6px;">' +
          '<table cellpadding="0" cellspacing="0" width="' + Math.max(3, Math.min(100, c.val)) + '%"><tr>' +
          '<td bgcolor="' + col + '" style="height:8px;border-radius:6px;font-size:0;">&nbsp;</td></tr></table>' +
        '</td></tr></table>' +
      '</td>' +
      '<td align="right" style="padding:7px 0 7px 14px;font-size:14px;font-weight:bold;color:' + col + ';">' + esc_(c.val) + '<span style="color:' + C.muted + ';font-weight:normal;font-size:11px;">/100</span></td>' +
      '</tr>';
  }).join('');
}

function checkList_(arr) {
  return (arr || []).map(function (c) {
    var ok = c.ok;
    var mark = ok ? '✓' : '✕';
    var col = ok ? C.cyan : C.red;
    return '<tr>' +
      '<td valign="top" width="22" style="padding:5px 8px 5px 0;color:' + col + ';font-weight:bold;font-size:13px;">' + mark + '</td>' +
      '<td style="padding:5px 0;font-size:12px;color:' + C.ink + ';"><b>' + esc_(c.label) + '</b>' +
        (c.detail ? ' <span style="color:' + C.muted + ';">· ' + esc_(c.detail) + '</span>' : '') + '</td>' +
      '</tr>';
  }).join('');
}

function recoList_(recos) {
  return (recos || []).map(function (r) {
    var col = sevColor_(r.severity);
    return '<table cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 10px 0;">' +
      '<tr><td width="5" bgcolor="' + col + '" style="border-radius:4px;font-size:0;">&nbsp;</td>' +
      '<td style="padding:8px 0 8px 14px;">' +
        '<div style="font-size:10px;letter-spacing:1px;color:' + col + ';font-weight:bold;">' +
          sevLabel_(r.severity) + ' · ' + esc_(r.area) + '</div>' +
        '<div style="font-size:14px;font-weight:bold;color:' + C.ink + ';margin:3px 0;">' + esc_(r.title) + '</div>' +
        '<div style="font-size:12px;color:' + C.muted + ';line-height:1.5;">' + esc_(r.tip) + '</div>' +
      '</td></tr></table>';
  }).join('');
}

function cwvCells_(cwv) {
  if (!cwv || !cwv.length) {
    return '<tr><td style="font-size:12px;color:' + C.muted + ';padding:6px 0;">No se pudo medir Performance de este sitio (PageSpeed Insights no devolvió datos a tiempo). El SEO y el AEO/GEO de este reporte sí son válidos.</td></tr>';
  }
  return '<tr>' + cwv.map(function (x) {
    var col = bandColor_(x.band);
    return '<td valign="top" width="20%" style="padding:6px;">' +
      '<div style="font-size:10px;letter-spacing:1px;color:' + C.muted + ';font-weight:bold;">' + esc_(x.key) + '</div>' +
      '<div style="font-size:18px;font-weight:bold;color:' + col + ';margin-top:3px;">' + esc_(x.display) + '</div>' +
      '</td>';
  }).join('') + '</tr>';
}

/* ---------- HTML del PDF ---------- */
function buildReportHtml_(lead, cs, host) {
  var score = cs.globalScore != null ? cs.globalScore : '–';
  var band = cs.band || 'med';
  var scoreCol = bandColor_(band);
  var today = Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'America/Santiago', 'dd/MM/yyyy');

  return '' +
  '<html><body style="margin:0;padding:0;font-family:Arial,Helvetica,sans-serif;color:' + C.ink + ';background:' + C.white + ';">' +

  // Header oscuro con logo
  '<table width="100%" cellpadding="0" cellspacing="0" bgcolor="' + C.bg + '"><tr><td style="padding:26px 34px;">' +
    '<img src="' + CONFIG.LOGO_URL + '" height="40" alt="Matías Laporta" style="display:block;margin-bottom:8px;"/>' +
    '<div style="color:' + C.cyan + ';font-size:10px;letter-spacing:2px;font-weight:bold;">AUDITORÍA WEB · PERFORMANCE · SEO · AEO/GEO</div>' +
  '</td></tr></table>' +

  // URL + score
  '<table width="100%" cellpadding="0" cellspacing="0"><tr>' +
    '<td valign="middle" style="padding:26px 34px;">' +
      '<div style="font-size:11px;letter-spacing:1px;color:' + C.muted + ';text-transform:uppercase;">Sitio analizado</div>' +
      '<div style="font-size:22px;font-weight:bold;color:' + C.ink + ';margin-top:4px;">' + esc_(host) + '</div>' +
      '<div style="font-size:11px;color:' + C.muted + ';margin-top:4px;">' + esc_(lead.url) + ' · ' + today + '</div>' +
    '</td>' +
    '<td align="right" valign="middle" width="150" style="padding:26px 34px;">' +
      '<table cellpadding="0" cellspacing="0"><tr><td align="center" bgcolor="' + scoreCol + '" width="104" style="padding:18px 0;border-radius:12px;">' +
        '<div style="font-size:40px;font-weight:bold;color:' + C.bg + ';line-height:1;">' + esc_(score) + '</div>' +
        '<div style="font-size:9px;letter-spacing:2px;color:' + C.bg + ';margin-top:4px;">SCORE GLOBAL</div>' +
      '</td></tr></table>' +
    '</td>' +
  '</tr></table>' +

  '<div style="height:1px;background:' + C.line + ';margin:0 34px;"></div>' +

  // Categorías
  block_('Categorías', '<table width="100%" cellpadding="0" cellspacing="0">' + catRows_(cs.categories) + '</table>') +

  // Core Web Vitals
  block_('Core Web Vitals', '<table width="100%" cellpadding="0" cellspacing="0">' + cwvCells_(cs.cwv) + '</table>') +

  // SEO
  block_('SEO técnico', '<table width="100%" cellpadding="0" cellspacing="0">' + checkList_(cs.seoChecks) + '</table>') +

  // AEO
  block_('AEO / GEO / LLMO (crawlers de IA)', '<table width="100%" cellpadding="0" cellspacing="0">' + checkList_(cs.aeoChecks) + '</table>') +

  // Recomendaciones
  block_('Plan de mejoras priorizado', recoList_(cs.recommendations)) +

  // CTA
  '<table width="100%" cellpadding="0" cellspacing="0"><tr><td style="padding:14px 34px 30px;">' +
    '<table width="100%" cellpadding="0" cellspacing="0" bgcolor="' + C.bg + '" style="border-radius:14px;"><tr><td style="padding:24px 28px;">' +
      '<div style="font-size:18px;font-weight:bold;color:' + C.yellow + ';">¿Implementamos estas mejoras juntos?</div>' +
      '<div style="font-size:13px;color:#cdd6e5;margin:8px 0 16px;">Agendá una reunión por Google Meet y armamos tu estrategia de Performance + SEO + AEO/GEO. Sin costo.</div>' +
      '<a href="' + CONFIG.BOOKING_URL + '" style="background:' + C.yellow + ';color:' + C.bg + ';font-weight:bold;font-size:13px;text-decoration:none;padding:12px 26px;border-radius:30px;">Agendar reunión →</a>' +
    '</td></tr></table>' +
  '</td></tr></table>' +

  // Footer / metodología
  '<table width="100%" cellpadding="0" cellspacing="0"><tr><td style="padding:0 34px 30px;font-size:10px;color:' + C.muted + ';line-height:1.6;">' +
    '<b style="color:' + C.ink + ';">Metodología.</b> ' + (cs.methodology || []).map(esc_).join(' · ') +
    '<br><br>© ' + new Date().getFullYear() + ' · Matías Laporta · Growth Architect · ' + CONFIG.SITE_URL +
  '</td></tr></table>' +

  '</body></html>';
}

function block_(title, inner) {
  return '<table width="100%" cellpadding="0" cellspacing="0"><tr><td style="padding:22px 34px 6px;">' +
    '<div style="font-size:13px;font-weight:bold;letter-spacing:1px;color:' + C.steel + ';text-transform:uppercase;border-left:3px solid ' + C.yellow + ';padding-left:10px;margin-bottom:12px;">' + esc_(title) + '</div>' +
    inner +
  '</td></tr></table>';
}

/* ---------- HTML del email ---------- */
function buildEmailHtml_(lead, cs, host) {
  var first = (lead.name || '').split(' ')[0] || 'Hola';
  var score = cs.globalScore != null ? cs.globalScore : '–';
  var scoreCol = bandColor_(cs.band || 'med');
  var topRecos = (cs.recommendations || []).slice(0, 3);

  return '' +
  '<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:' + C.ink + ';">' +
    '<table width="100%" cellpadding="0" cellspacing="0" bgcolor="' + C.bg + '" style="border-radius:14px 14px 0 0;"><tr><td style="padding:24px 28px;">' +
      '<img src="' + CONFIG.LOGO_URL + '" height="34" alt="Matías Laporta" style="display:block;"/>' +
    '</td></tr></table>' +
    '<table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ' + C.line + ';border-top:0;border-radius:0 0 14px 14px;"><tr><td style="padding:26px 28px;">' +
      '<p style="font-size:15px;margin:0 0 14px;">Hola ' + esc_(first) + ',</p>' +
      '<p style="font-size:14px;line-height:1.6;margin:0 0 18px;color:' + C.muted + ';">Acá está tu auditoría de <b style="color:' + C.ink + ';">' + esc_(host) + '</b>. ' +
        'El <b>reporte completo en PDF</b> va adjunto a este correo.</p>' +
      '<table cellpadding="0" cellspacing="0" style="margin:0 0 18px;"><tr>' +
        '<td bgcolor="' + scoreCol + '" width="74" align="center" style="padding:14px 0;border-radius:10px;">' +
          '<div style="font-size:30px;font-weight:bold;color:' + C.bg + ';line-height:1;">' + esc_(score) + '</div>' +
          '<div style="font-size:8px;letter-spacing:1px;color:' + C.bg + ';">/100</div>' +
        '</td>' +
        '<td style="padding-left:16px;font-size:13px;color:' + C.muted + ';">Score global de tu sitio<br>(Performance + SEO + AEO/GEO)</td>' +
      '</tr></table>' +
      (topRecos.length ? '<div style="font-size:12px;font-weight:bold;letter-spacing:1px;color:' + C.steel + ';text-transform:uppercase;margin:0 0 8px;">Primeras 3 mejoras</div>' +
        topRecos.map(function (r) {
          return '<div style="font-size:13px;margin:0 0 8px;padding-left:10px;border-left:3px solid ' + sevColor_(r.severity) + ';"><b>' + esc_(r.title) + '</b><br><span style="color:' + C.muted + ';">' + esc_(r.tip) + '</span></div>';
        }).join('') : '') +
      '<div style="text-align:center;margin:24px 0 8px;">' +
        '<a href="' + CONFIG.BOOKING_URL + '" style="background:' + C.yellow + ';color:' + C.bg + ';font-weight:bold;font-size:14px;text-decoration:none;padding:14px 32px;border-radius:30px;display:inline-block;">Agendar reunión por Google Meet →</a>' +
      '</div>' +
      '<p style="font-size:12px;color:' + C.muted + ';text-align:center;margin:14px 0 0;">Sin costo, sin spam. Te responde Matías directamente.</p>' +
    '</td></tr></table>' +
    '<p style="font-size:11px;color:' + C.muted + ';text-align:center;margin:16px 0;">© ' + new Date().getFullYear() + ' · Matías Laporta · Growth Architect</p>' +
  '</div>';
}
