/**
 * Smart Recording – Tracker
 * Snippet da embeddare nelle pagine da monitorare.
 *
 * Uso base:
 *   <script>
 *     window.SmartRecordingConfig = { siteId: 'mio-sito' };
 *   </script>
 *   <script src="http://localhost:4000/tracker.js"></script>
 *
 * Opzioni complète:
 *   window.SmartRecordingConfig = {
 *     siteId:        'mio-sito',                        // ID cliente (obbligatorio)
 *     serverUrl:     'https://recording.miodominio.com', // default: localhost:4000
 *     sampleRate:    0.3,     // % sessioni da registrare: 0.0-1.0 (default: 1.0 = tutte)
 *     cooldownHours: 24,      // ore minime tra registrazioni dello stesso utente (default: 0)
 *     maskInputs:    true,    // maschera tutti gli input (default: true)
 *     flushInterval: 5000,    // ms tra un flush e l'altro (default: 5000)
 *     flushBatch:    50,      // eventi prima del flush forzato (default: 50)
 *   };
 */
(function () {
  'use strict';

  // ── Configurazione ─────────────────────────────────────────────────────────
  var cfg = window.SmartRecordingConfig || {};
  var SERVER_URL     = (cfg.serverUrl    || 'http://localhost:4000').replace(/\/$/, '');
  var SITE_ID        = cfg.siteId        || 'default';
  var MASK_INPUTS    = cfg.maskInputs   !== false;
  var FLUSH_INTERVAL = cfg.flushInterval || 5000;
  var FLUSH_BATCH    = cfg.flushBatch   || 50;

  // Frequenza di registrazione
  // sampleRate: 0.0 - 1.0 (default 1.0 = 100%)
  // cooldownHours: ore di attesa tra una registrazione e l'altra per lo stesso utente (default 0 = nessun limite)
  var SAMPLE_RATE    = cfg.sampleRate    !== undefined ? parseFloat(cfg.sampleRate)    : 1.0;
  var COOLDOWN_HOURS = cfg.cooldownHours !== undefined ? parseFloat(cfg.cooldownHours) : 0;

  // Controlla se questa sessione deve essere registrata
  function shouldRecord() {
    // 1. Sample rate: estrazione casuale
    if (Math.random() > SAMPLE_RATE) return false;

    // 2. Cooldown utente (via localStorage)
    if (COOLDOWN_HOURS > 0) {
      var key      = '__sr_last_' + SITE_ID;
      var lastTime = parseInt(localStorage.getItem(key) || '0', 10);
      var now      = Date.now();
      if (lastTime && (now - lastTime) < COOLDOWN_HOURS * 3600 * 1000) return false;
      localStorage.setItem(key, String(now));
    }

    return true;
  }

  // Evita doppia inizializzazione
  if (window.__smartRecordingActive) return;
  window.__smartRecordingActive = true;

  // ── ID sessione ────────────────────────────────────────────────────────────
  function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  var SESSION_ID = generateId();
  var events     = [];
  var flushTimer = null;
  var stopFn     = null;
  var sessionStarted = false;

  // ── Fetch helper con keepalive (per beforeunload) ──────────────────────────
  function post(path, body, keepalive) {
    try {
      fetch(SERVER_URL + path, {
        method:    'POST',
        headers:   { 'Content-Type': 'application/json' },
        body:      JSON.stringify(body),
        keepalive: !!keepalive,
      }).catch(function () { /* silenzioso */ });
    } catch (e) { /* fetch non disponibile */ }
  }

  // ── Flush eventi al server ─────────────────────────────────────────────────
  function flush(keepalive) {
    if (events.length === 0) return;
    var batch = events.splice(0);
    post('/api/sessions/' + SESSION_ID + '/events', { events: batch }, keepalive);
  }

  function scheduleFlush() {
    clearTimeout(flushTimer);
    flushTimer = setTimeout(function () { flush(false); }, FLUSH_INTERVAL);
  }

  // ── Avvio sessione ─────────────────────────────────────────────────────────
  function getDeviceType() {
    var w = window.innerWidth;
    var hasTouch = ('ontouchstart' in window) || navigator.maxTouchPoints > 0;
    if (w <= 768 && hasTouch) return 'mobile';
    if (w <= 1024 && hasTouch) return 'tablet';
    return 'desktop';
  }

  function getOS() {
    var ua = navigator.userAgent;
    if (/Android/i.test(ua))               return 'Android';
    if (/iPhone|iPad|iPod/i.test(ua))      return 'iOS';
    if (/Windows/i.test(ua))               return 'Windows';
    if (/Mac OS X/i.test(ua))              return 'macOS';
    if (/Linux/i.test(ua))                 return 'Linux';
    return 'Unknown';
  }

  function startSession() {
    var conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    post('/api/sessions/start', {
      sessionId:       SESSION_ID,
      siteId:          SITE_ID,
      url:             window.location.href,
      referrer:        document.referrer || '',
      userAgent:       navigator.userAgent,
      viewport:        { width: window.innerWidth, height: window.innerHeight },
      deviceType:      getDeviceType(),
      os:              getOS(),
      language:        navigator.language || '',
      timezone:        Intl ? Intl.DateTimeFormat().resolvedOptions().timeZone : '',
      connectionType:  conn ? (conn.effectiveType || conn.type || '') : '',
      pixelRatio:      window.devicePixelRatio || 1,
    }, false);
    sessionStarted = true;
  }

  // ── Carica rrweb da CDN e avvia registrazione ──────────────────────────────
  function loadRrweb(callback) {
    // Se rrweb è già caricato (es. dal progetto host) usa quello
    if (window.rrweb) { callback(); return; }

    var script   = document.createElement('script');
    script.src   = 'https://cdn.jsdelivr.net/npm/rrweb@1/dist/rrweb.min.js';
    script.async = true;
    script.onload  = callback;
    document.head.appendChild(script);
  }

  function startRecording() {
    if (!window.rrweb) return;

    startSession();

    stopFn = rrweb.record({
      emit: function (event) {
        events.push(event);
        if (events.length >= FLUSH_BATCH) {
          flush(false);
        } else {
          scheduleFlush();
        }
      },
      maskAllInputs:   MASK_INPUTS,
      maskTextSelector: MASK_INPUTS ? 'input[type="password"]' : undefined,
      // Registra anche le modifiche al DOM in Shadow DOM
      recordCrossOriginIframes: false,
    });
  }

  // ── Evento unload: flush finale + chiusura sessione ────────────────────────
  function onUnload() {
    if (!sessionStarted) return;
    flush(true);
    post('/api/sessions/' + SESSION_ID + '/end', {}, true);
    if (typeof stopFn === 'function') stopFn();
  }

  window.addEventListener('beforeunload', onUnload);
  // visibilitychange come fallback per mobile
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') onUnload();
  });

  // ── API pubblica ───────────────────────────────────────────────────────────
  window.SmartRecording = {
    stop: function () {
      if (typeof stopFn === 'function') { stopFn(); stopFn = null; }
      flush(false);
    },
    getSessionId: function () { return SESSION_ID; },
  };

  // ── Init ───────────────────────────────────────────────────────────────────
  if (!shouldRecord()) return; // nessuna registrazione per questa sessione

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { loadRrweb(startRecording); });
  } else {
    loadRrweb(startRecording);
  }

})();
