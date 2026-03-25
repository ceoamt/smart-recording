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

// ─── Autenticazione ──────────────────────────────────────────────────────────
const AUTH_USER   = process.env.AUTH_USER || 'amtitalia';
const AUTH_PASS   = process.env.AUTH_PASS || 'smartrec2026?!?!';
const COOKIE_NAME = 'sr_session';
const AUTH_FILE   = path.join(DATA_DIR, 'auth_tokens.json');
const TOKEN_TTL   = 90 * 24 * 60 * 60 * 1000; // 90 giorni

// Carica tokens da disco (persistono tra i redeploy)
function loadAuthTokens() {
  try {
    if (fs.existsSync(AUTH_FILE)) {
      const data = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
      const now = Date.now();
      const map = new Map();
      Object.entries(data).forEach(([token, info]) => {
        if (now - info.createdAt < TOKEN_TTL) map.set(token, info); // scarta i token scaduti
      });
      return map;
    }
  } catch {}
  return new Map();
}

function saveAuthTokens(map) {
  try {
    const obj = {};
    map.forEach((v, k) => { obj[k] = v; });
    fs.writeFileSync(AUTH_FILE, JSON.stringify(obj), 'utf8');
  } catch {}
}

const SESSIONS_AUTH = loadAuthTokens();

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
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
  // 1. Cookie (fallback per accesso diretto da browser)
  const cookieToken = parseCookies(req)[COOKIE_NAME];
  if (cookieToken && SESSIONS_AUTH.has(cookieToken)) return true;
  // 2. Authorization: Bearer TOKEN (usato da iframe / localStorage flow)
  const auth = req.headers['authorization'] || '';
  if (auth.startsWith('Bearer ')) {
    const bearerToken = auth.slice(7).trim();
    if (bearerToken && SESSIONS_AUTH.has(bearerToken)) return true;
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
      const token = generateToken();
      SESSIONS_AUTH.set(token, { createdAt: Date.now() });
      saveAuthTokens(SESSIONS_AUTH); // persisti su disco
      // Mantengo anche il cookie per compatibilità accesso diretto
      const isHttps = req.headers['x-forwarded-proto'] === 'https' || req.socket?.encrypted;
      const cookieFlags = isHttps ? 'HttpOnly; SameSite=None; Secure' : 'HttpOnly; SameSite=Lax';
      res.setHeader('Set-Cookie', `${COOKIE_NAME}=${token}; Path=/; ${cookieFlags}`);
      json(res, 200, { ok: true, token }); // token restituito per localStorage (iframe)
    } else {
      json(res, 401, { ok: false, error: 'Credenziali non valide' });
    }
    return;
  }

  // ── POST /api/logout ──────────────────────────────────────────────────────
  if (method === 'POST' && pathname === '/api/logout') {
    const token = parseCookies(req)[COOKIE_NAME];
    if (token) { SESSIONS_AUTH.delete(token); saveAuthTokens(SESSIONS_AUTH); }
    res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; ${cookieFlags(req)}; Max-Age=0`);
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
    };

    sessions.push(session);
    writeSessions(sessions);
    json(res, 200, { ok: true, sessionId: id });
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
    const sessions = readSessions();
    const idx      = sessions.findIndex(s => s.id === id);

    if (idx === -1) { json(res, 404, { error: 'session not found' }); return; }

    sessions[idx].endTime  = Date.now();
    sessions[idx].duration = sessions[idx].endTime - sessions[idx].startTime;
    sessions[idx].status   = 'completed';
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
    const sorted   = [...sessions].sort((a, b) => b.startTime - a.startTime);
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
