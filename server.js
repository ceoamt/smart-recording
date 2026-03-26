/**
 * Smart Recording – Server HTTP Node.js
 * Servizio standalone di session recording (replica Hotjar Recordings)
 *
 * API:
 *   POST /api/sessions/start              → crea sessione
 *   POST /api/sessions/:id/events         → aggiunge eventi (batch)
 *   POST /api/sessions/:id/end            → chiude sessione
 *   GET  /api/sessions                    → lista sessioni (metadata)
 *   GET  /api/sessions/:id                → metadata sessione
 *   GET  /api/sessions/:id/events         → eventi completi per replay
 *   DELETE /api/sessions/:id              → elimina sessione
 *
 * Storage: flat file JSON in DATA_DIR
 * Avvia: node server.js
 * Env:   PORT (default 4000), DATA_DIR (default ./data), SESSION_TTL_DAYS (default 30)
 */

const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const zlib   = require('zlib');
const crypto = require('crypto');
const { URL } = require('url');

const PORT         = process.env.PORT || 4000;
const DATA_DIR     = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUB_DIR      = path.join(__dirname, 'public');
const TTL_DAYS     = parseInt(process.env.SESSION_TTL_DAYS || '30', 10);
const TTL_MS       = TTL_DAYS * 24 * 60 * 60 * 1000;

// ─── Autenticazione stateless (HMAC — sopravvive ai restart/redeploy) ────────
const AUTH_USER   = process.env.AUTH_USER || 'amtitalia';
const AUTH_PASS   = process.env.AUTH_PASS || 'smartrec2026?!?!';
const COOKIE_NAME = 'sr_session';
const TOKEN_TTL   = 90 * 24 * 60 * 60 * 1000; // 90 giorni

// Segreto derivato dalle credenziali — stabile tra i redeploy finché la password non cambia
const TOKEN_SECRET = crypto.createHash('sha256')
  .update(AUTH_USER + ':' + AUTH_PASS + ':sr2026')
  .digest();

function createToken() {
  const ts  = Date.now().toString();
  const sig = crypto.createHmac('sha256', TOKEN_SECRET).update(ts).digest('hex');
  return ts + '.' + sig;
}

function validateToken(token) {
  if (!token) return false;
  const dot = token.indexOf('.');
  if (dot === -1) return false;
  const ts  = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!ts || !sig) return false;
  const expected = crypto.createHmac('sha256', TOKEN_SECRET).update(ts).digest('hex');
  if (expected !== sig) return false;          // firma non valida
  if (Date.now() - parseInt(ts) > TOKEN_TTL)  return false; // scaduto
  return true;
}

function parseCookies(req) {
  const cookies = {};
  (req.headers.cookie || '').split(';').forEach(part => {
    const [k, ...v] = part.trim().split('=');
    if (k) cookies[k.trim()] = v.join('=').trim();
  });
  return cookies;
}

function isAuthenticated(req) {
  // 1. Cookie (accesso diretto da browser)
  const cookieToken = parseCookies(req)[COOKIE_NAME];
  if (validateToken(cookieToken)) return true;
  // 2. Authorization: Bearer TOKEN (iframe / localStorage)
  const auth = req.headers['authorization'] || '';
  if (auth.startsWith('Bearer ')) {
    const bearerToken = auth.slice(7).trim();
    if (validateToken(bearerToken)) return true;
  }
  return false;
}

// Route pubbliche (tracker + login + pagine HTML) — non richiedono autenticazione
// L'auth delle pagine HTML è gestita lato client con localStorage
function isPublicRoute(method, pathname) {
  if (method === 'OPTIONS')              return true;
  if (pathname === '/')                  return true;   // auth client-side
  if (pathname === '/login')             return true;
  if (pathname === '/api/login')         return true;
  if (pathname === '/api/logout')        return true;
  if (pathname === '/tracker.js')        return true;
  if (pathname === '/test.html')         return true;
  if (method === 'POST' && pathname === '/api/sessions/start')            return true;
  if (method === 'POST' && /^\/api\/sessions\/[^/]+\/events$/.test(pathname)) return true;
  if (method === 'POST' && /^\/api\/sessions\/[^/]+\/end$/.test(pathname))    return true;
  return false;
}

// ─── Cartelle dati ─────────────────────────────────────────────────────────
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const CLIENTS_FILE  = path.join(DATA_DIR, 'clients.json');
const EVENTS_DIR    = path.join(DATA_DIR, 'events');

function initStorage() {
  if (!fs.existsSync(DATA_DIR))    fs.mkdirSync(DATA_DIR,    { recursive: true });
  if (!fs.existsSync(EVENTS_DIR))  fs.mkdirSync(EVENTS_DIR,  { recursive: true });
  if (!fs.existsSync(SESSIONS_FILE)) fs.writeFileSync(SESSIONS_FILE, '[]', 'utf8');
  if (!fs.existsSync(CLIENTS_FILE))  fs.writeFileSync(CLIENTS_FILE,  '[]', 'utf8');
}

// ─── Helpers I/O ────────────────────────────────────────────────────────────
function readSessions() {
  try { return JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')); }
  catch { return []; }
}

function writeSessions(sessions) {
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2), 'utf8');
}

function eventsFilePath(sessionId) {
  const gz   = path.join(EVENTS_DIR, `${sessionId}.json.gz`);
  const json = path.join(EVENTS_DIR, `${sessionId}.json`);
  // Preferisce .gz se esiste, altrimenti legacy .json
  if (fs.existsSync(gz))   return { file: gz,   compressed: true  };
  if (fs.existsSync(json)) return { file: json,  compressed: false };
  return { file: gz, compressed: true }; // default per nuovi file
}

function readEvents(sessionId) {
  const { file, compressed } = eventsFilePath(sessionId);
  if (!fs.existsSync(file)) return [];
  try {
    const raw = fs.readFileSync(file);
    const txt = compressed ? zlib.gunzipSync(raw).toString('utf8') : raw.toString('utf8');
    return JSON.parse(txt);
  } catch { return []; }
}

function appendEvents(sessionId, newEvents) {
  const existing = readEvents(sessionId);
  const merged   = existing.concat(newEvents);
  const gz       = path.join(EVENTS_DIR, `${sessionId}.json.gz`);
  // Migra legacy .json → .gz se esiste
  const legacyJson = path.join(EVENTS_DIR, `${sessionId}.json`);
  if (fs.existsSync(legacyJson)) fs.unlinkSync(legacyJson);
  fs.writeFileSync(gz, zlib.gzipSync(JSON.stringify(merged)));
  return merged.length;
}

// ─── Geo lookup (ip-api.com, asincrono) ─────────────────────────────────────
function geoLookup(ip) {
  return new Promise(resolve => {
    const clean = (ip || '').replace(/^::ffff:/, '');
    if (!clean || clean === '127.0.0.1' || clean === '::1' || clean.startsWith('192.168') || clean.startsWith('10.')) {
      return resolve({ country: '', countryName: '' });
    }
    const options = { hostname: 'ip-api.com', path: `/json/${clean}?fields=country,countryCode`, timeout: 2000 };
    const req = http.get(options, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { const j = JSON.parse(data); resolve({ country: j.countryCode || '', countryName: j.country || '' }); }
        catch { resolve({ country: '', countryName: '' }); }
      });
    });
    req.on('error', () => resolve({ country: '', countryName: '' }));
    req.on('timeout', () => { req.destroy(); resolve({ country: '', countryName: '' }); });
  });
}

// ─── Rilevanza sessione ──────────────────────────────────────────────────────
function computeRelevance(session) {
  let score = 0;
  // Durata (max 25): 0-30s=0, 30s-2min crescente, >5min=25
  const mins = (session.duration || 0) / 60000;
  score += Math.min(mins / 5 * 25, 25);
  // Pagine visitate (max 20): ogni pagina vale 4pt
  score += Math.min((session.pagesVisited || 1) * 4, 20);
  // Rage click (max 30): alta priorità → frustrazione
  score += Math.min((session.rageClicks || 0) * 12, 30);
  // Errori console (max 15): bug tecnici
  score += Math.min((session.consoleErrors || 0) * 8, 15);
  // U-turn (max 10): confusione di navigazione
  score += Math.min((session.uturns || 0) * 5, 10);

  const pct   = Math.min(Math.round(score), 100);
  const level = pct >= 60 ? 'high' : pct >= 30 ? 'medium' : 'low';
  return { relevanceScore: pct, relevance: level };
}

function deleteEventFile(sessionId) {
  const gz   = path.join(EVENTS_DIR, `${sessionId}.json.gz`);
  const json = path.join(EVENTS_DIR, `${sessionId}.json`);
  if (fs.existsSync(gz))   fs.unlinkSync(gz);
  if (fs.existsSync(json)) fs.unlinkSync(json);
}

// ─── TTL cleanup (rispetta ttlDays per-cliente) ──────────────────────────────
function cleanupExpiredSessions() {
  const sessions = readSessions();
  const clients  = readClients();
  const clientMap = {};
  clients.forEach(c => { clientMap[c.siteId] = c; });

  const now = Date.now();
  const expired = sessions.filter(s => {
    const client  = clientMap[s.siteId];
    const days    = (client && client.ttlDays > 0) ? client.ttlDays : TTL_DAYS;
    const cutoff  = now - days * 24 * 60 * 60 * 1000;
    return s.startTime < cutoff;
  });
  if (!expired.length) return;

  expired.forEach(s => deleteEventFile(s.id));
  const expiredIds = new Set(expired.map(s => s.id));
  writeSessions(sessions.filter(s => !expiredIds.has(s.id)));
  console.log(`[TTL] Eliminate ${expired.length} sessioni scadute.`);
}

// Esegui all'avvio e poi ogni 24 ore
function scheduleTTL() {
  cleanupExpiredSessions();
  setInterval(cleanupExpiredSessions, 24 * 60 * 60 * 1000);
}

function readClients() {
  try { return JSON.parse(fs.readFileSync(CLIENTS_FILE, 'utf8')); }
  catch { return []; }
}

function writeClients(clients) {
  fs.writeFileSync(CLIENTS_FILE, JSON.stringify(clients, null, 2), 'utf8');
}


function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ─── Body reader ────────────────────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end',  () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

// ─── MIME ────────────────────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
};

// ─── CORS headers ────────────────────────────────────────────────────────────
function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function json(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

// ─── Router ─────────────────────────────────────────────────────────────────
async function router(req, res) {
  setCORS(res);

  // Preflight CORS
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const parsed   = new URL(req.url, `http://localhost`);
  const pathname = parsed.pathname;
  const method   = req.method;

  // ── POST /api/login ───────────────────────────────────────────────────────
  if (method === 'POST' && pathname === '/api/login') {
    const body = await readBody(req);
    if (body.username === AUTH_USER && body.password === AUTH_PASS) {
      const token   = createToken(); // firmato HMAC, nessuno stato server necessario
      const isHttps = req.headers['x-forwarded-proto'] === 'https' || req.socket?.encrypted;
      const flags   = isHttps ? 'HttpOnly; SameSite=None; Secure' : 'HttpOnly; SameSite=Lax';
      res.setHeader('Set-Cookie', `${COOKIE_NAME}=${token}; Path=/; ${flags}`);
      json(res, 200, { ok: true, token }); // token in body per localStorage (iframe)
    } else {
      json(res, 401, { ok: false, error: 'Credenziali non valide' });
    }
    return;
  }

  // ── POST /api/logout ──────────────────────────────────────────────────────
  if (method === 'POST' && pathname === '/api/logout') {
    // Token HMAC: basta cancellare cookie e localStorage lato client
    const isHttps = req.headers['x-forwarded-proto'] === 'https' || req.socket?.encrypted;
    const flags   = isHttps ? 'HttpOnly; SameSite=None; Secure' : 'HttpOnly; SameSite=Lax';
    res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; ${flags}; Max-Age=0`);
    json(res, 200, { ok: true });
    return;
  }

  // ── Auth guard — solo per chiamate API, non per pagine HTML ──────────────
  // Le pagine HTML (index.html, login.html) sono pubbliche:
  // l'auth è gestita client-side con localStorage + Bearer token
  if (!isPublicRoute(method, pathname) && !isAuthenticated(req)) {
    json(res, 401, { error: 'unauthorized' });
    return;
  }

  // ── GET /login → serve login.html ────────────────────────────────────────
  if (method === 'GET' && pathname === '/login') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    fs.createReadStream(path.join(PUB_DIR, 'login.html')).pipe(res);
    return;
  }

  // ── POST /api/sessions/start ──────────────────────────────────────────────
  if (method === 'POST' && pathname === '/api/sessions/start') {
    const body     = await readBody(req);
    const sessions = readSessions();
    const id       = body.sessionId || generateId();

    const siteId  = body.siteId || 'default';
    const clients = readClients();
    const client  = clients.find(c => c.siteId === siteId);
    if (!client) {
      // Cliente non registrato: ignora silenziosamente (il tracker non deve crashare)
      json(res, 200, { ok: false, reason: 'unknown_site' });
      return;
    }

    // Sample rate server-side (es. 10% → scarta 90% delle sessioni in arrivo)
    const sampleRate = client.sampleRate !== undefined ? client.sampleRate : 100;
    if (sampleRate < 100 && Math.random() * 100 > sampleRate) {
      json(res, 200, { ok: false, reason: 'sampled_out' });
      return;
    }

    // Limite massimo sessioni per cliente
    if (client.maxSessions > 0) {
      const clientCount = sessions.filter(s => s.siteId === siteId).length;
      if (clientCount >= client.maxSessions) {
        json(res, 200, { ok: false, reason: 'limit_reached' });
        return;
      }
    }

    const session = {
      id,
      siteId,
      startTime:      Date.now(),
      endTime:        null,
      duration:       null,
      url:            body.url            || '',
      referrer:       body.referrer       || '',
      userAgent:      body.userAgent      || '',
      viewport:       body.viewport       || {},
      deviceType:     body.deviceType     || 'desktop',
      os:             body.os             || '',
      language:       body.language       || '',
      timezone:       body.timezone       || '',
      connectionType: body.connectionType || '',
      pixelRatio:     body.pixelRatio     || 1,
      eventsCount:    0,
      status:         'recording',
      // Comportamentali (aggiornati a /end)
      country:        '',
      countryName:    '',
      pagesVisited:   1,
      rageClicks:     0,
      consoleErrors:  0,
      uturns:         0,
      relevanceScore: 0,
      relevance:      'low',
      markers:        [],
    };

    sessions.push(session);
    writeSessions(sessions);
    json(res, 200, { ok: true, sessionId: id });

    // Geo lookup asincrono (non blocca la risposta)
    const clientIp = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;
    geoLookup(clientIp).then(geo => {
      if (!geo.country) return;
      const ss = readSessions();
      const ix = ss.findIndex(s => s.id === id);
      if (ix !== -1) { ss[ix].country = geo.country; ss[ix].countryName = geo.countryName; writeSessions(ss); }
    }).catch(() => {});
    return;
  }

  // ── POST /api/sessions/:id/events ─────────────────────────────────────────
  const eventsMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/events$/);
  if (method === 'POST' && eventsMatch) {
    const id       = eventsMatch[1];
    const body     = await readBody(req);
    const events   = body.events || [];
    const sessions = readSessions();
    const idx      = sessions.findIndex(s => s.id === id);

    if (idx === -1) { json(res, 404, { error: 'session not found' }); return; }

    const total = appendEvents(id, events);
    sessions[idx].eventsCount = total;
    writeSessions(sessions);
    json(res, 200, { ok: true, total });
    return;
  }

  // ── POST /api/sessions/:id/end ────────────────────────────────────────────
  const endMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/end$/);
  if (method === 'POST' && endMatch) {
    const id       = endMatch[1];
    const body     = await readBody(req);
    const sessions = readSessions();
    const idx      = sessions.findIndex(s => s.id === id);

    if (idx === -1) { json(res, 404, { error: 'session not found' }); return; }

    sessions[idx].endTime  = Date.now();
    sessions[idx].duration = sessions[idx].endTime - sessions[idx].startTime;
    sessions[idx].status   = 'completed';

    // Metriche comportamentali dal tracker
    if (body.rageClicks    !== undefined) sessions[idx].rageClicks    = body.rageClicks;
    if (body.consoleErrors !== undefined) sessions[idx].consoleErrors = body.consoleErrors;
    if (body.uturns        !== undefined) sessions[idx].uturns        = body.uturns;
    if (body.pagesVisited  !== undefined) sessions[idx].pagesVisited  = body.pagesVisited;
    if (body.pageList      !== undefined) sessions[idx].pageList      = body.pageList;
    if (body.markers       !== undefined) sessions[idx].markers       = body.markers;

    // Calcola rilevanza
    const rel = computeRelevance(sessions[idx]);
    sessions[idx].relevanceScore = rel.relevanceScore;
    sessions[idx].relevance      = rel.relevance;

    writeSessions(sessions);
    json(res, 200, { ok: true });
    return;
  }

  // ── GET /api/clients ──────────────────────────────────────────────────────
  if (method === 'GET' && pathname === '/api/clients') {
    const clients  = readClients();
    const sessions = readSessions();
    const enriched = clients.map(c => ({
      ...c,
      sessionCount: sessions.filter(s => s.siteId === c.siteId).length,
      lastSeen:     sessions.filter(s => s.siteId === c.siteId).reduce((m, s) => Math.max(m, s.startTime), 0) || null,
    }));
    json(res, 200, enriched.sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0)));
    return;
  }

  // ── POST /api/clients ─────────────────────────────────────────────────────
  if (method === 'POST' && pathname === '/api/clients') {
    const body    = await readBody(req);
    const siteId  = (body.siteId || '').trim().toLowerCase().replace(/\s+/g, '-');
    if (!siteId)  { json(res, 400, { error: 'siteId obbligatorio' }); return; }
    const clients = readClients();
    if (clients.find(c => c.siteId === siteId)) {
      json(res, 409, { error: 'siteId già esistente' }); return;
    }
    const client = { id: generateId(), siteId, name: body.name || siteId, createdAt: Date.now() };
    clients.push(client);
    writeClients(clients);
    json(res, 201, client);
    return;
  }

  // ── PATCH /api/clients/:id ────────────────────────────────────────────────
  const patchClientMatch = pathname.match(/^\/api\/clients\/([^/]+)$/);
  if (method === 'PATCH' && patchClientMatch) {
    const id      = patchClientMatch[1];
    const body    = await readBody(req);
    const clients = readClients();
    const idx     = clients.findIndex(c => c.id === id);
    if (idx === -1) { json(res, 404, { error: 'not found' }); return; }
    if (body.name        !== undefined) clients[idx].name        = body.name;
    if (body.maxSessions !== undefined) clients[idx].maxSessions = Number(body.maxSessions) || 0;
    if (body.ttlDays     !== undefined) clients[idx].ttlDays     = Number(body.ttlDays)     || 0;
    if (body.sampleRate  !== undefined) clients[idx].sampleRate  = Math.min(100, Math.max(1, Number(body.sampleRate) || 100));
    writeClients(clients);
    json(res, 200, clients[idx]);
    return;
  }

  // ── DELETE /api/clients/:id ───────────────────────────────────────────────
  const delClientMatch = pathname.match(/^\/api\/clients\/([^/]+)$/);
  if (method === 'DELETE' && delClientMatch) {
    const id      = delClientMatch[1];
    const clients = readClients();
    const client  = clients.find(c => c.id === id);
    if (!client) { json(res, 404, { error: 'not found' }); return; }
    writeClients(clients.filter(c => c.id !== id));
    json(res, 200, { ok: true });
    return;
  }

  // ── GET /api/sessions ─────────────────────────────────────────────────────
  if (method === 'GET' && pathname === '/api/sessions') {
    const siteId   = parsed.searchParams.get('siteId');
    let sessions   = readSessions();
    if (siteId) sessions = sessions.filter(s => s.siteId === siteId);
    // Ordina: prima le live, poi per relevanceScore desc, poi per data desc
    const sorted   = [...sessions].sort((a, b) => {
      if (a.status === 'recording' && b.status !== 'recording') return -1;
      if (b.status === 'recording' && a.status !== 'recording') return  1;
      if ((b.relevanceScore || 0) !== (a.relevanceScore || 0)) return (b.relevanceScore || 0) - (a.relevanceScore || 0);
      return b.startTime - a.startTime;
    });
    json(res, 200, sorted);
    return;
  }

  // ── GET /api/sessions/:id/events ──────────────────────────────────────────
  const getEventsMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/events$/);
  if (method === 'GET' && getEventsMatch) {
    const id = getEventsMatch[1];
    json(res, 200, readEvents(id));
    return;
  }

  // ── GET /api/sessions/:id ─────────────────────────────────────────────────
  const getSessionMatch = pathname.match(/^\/api\/sessions\/([^/]+)$/);
  if (method === 'GET' && getSessionMatch) {
    const id      = getSessionMatch[1];
    const session = readSessions().find(s => s.id === id);
    if (!session) { json(res, 404, { error: 'not found' }); return; }
    json(res, 200, session);
    return;
  }

  // ── PATCH /api/sessions/:id (tags, starred, note) ────────────────────────
  const patchMatch = pathname.match(/^\/api\/sessions\/([^/]+)$/);
  if (method === 'PATCH' && patchMatch) {
    const id       = patchMatch[1];
    const body     = await readBody(req);
    const sessions = readSessions();
    const idx      = sessions.findIndex(s => s.id === id);
    if (idx === -1) { json(res, 404, { error: 'not found' }); return; }
    if (body.tags    !== undefined) sessions[idx].tags    = body.tags;
    if (body.starred !== undefined) sessions[idx].starred = body.starred;
    if (body.note    !== undefined) sessions[idx].note    = body.note;
    writeSessions(sessions);
    json(res, 200, sessions[idx]);
    return;
  }

  // ── DELETE /api/sessions/:id ──────────────────────────────────────────────
  const delMatch = pathname.match(/^\/api\/sessions\/([^/]+)$/);
  if (method === 'DELETE' && delMatch) {
    const id       = delMatch[1];
    const sessions = readSessions();
    const filtered = sessions.filter(s => s.id !== id);
    if (filtered.length === sessions.length) { json(res, 404, { error: 'not found' }); return; }
    writeSessions(filtered);
    deleteEventFile(id);
    json(res, 200, { ok: true });
    return;
  }

  // ── Serve file statici ────────────────────────────────────────────────────
  let filePath = pathname === '/' ? '/index.html' : pathname;
  filePath = path.join(PUB_DIR, filePath);

  // Sicurezza: blocca path traversal
  if (!filePath.startsWith(PUB_DIR)) {
    json(res, 403, { error: 'forbidden' });
    return;
  }

  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext  = path.extname(filePath);
    const mime = MIME[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime });
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  json(res, 404, { error: 'not found' });
}

// ─── Avvio ───────────────────────────────────────────────────────────────────
initStorage();
scheduleTTL();

const server = http.createServer(async (req, res) => {
  try {
    await router(req, res);
  } catch (err) {
    console.error('[Error]', err.message);
    if (!res.headersSent) json(res, 500, { error: 'internal server error' });
  }
});

server.listen(PORT, () => {
  console.log(`[Smart Recording] Server avviato su http://localhost:${PORT}`);
  console.log(`[Smart Recording] Dashboard: http://localhost:${PORT}/`);
  console.log(`[Smart Recording] Tracker:   http://localhost:${PORT}/tracker.js`);
});
