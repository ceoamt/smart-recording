/**
 * Smart Recording – Tracker v2
 * Rileva: rage click, u-turn, errori console, navigazione SPA, eventi custom
 *
 * Uso base:
 *   window.SmartRecordingConfig = { siteId: 'mio-sito' };
 *   <script src="https://smart-recording.../tracker.js"></script>
 *
 * API pubblica:
 *   SmartRecording.track('event_name', { ...payload })  // evento custom
 *   SmartRecording.stop()
 *   SmartRecording.getSessionId()
 */
(function () {
  'use strict';

  var cfg            = window.SmartRecordingConfig || {};
  var SERVER_URL     = (cfg.serverUrl    || 'http://localhost:4000').replace(/\/$/, '');
  var SITE_ID        = cfg.siteId        || 'default';
  var MASK_INPUTS    = cfg.maskInputs   !== false;
  var FLUSH_INTERVAL = cfg.flushInterval || 5000;
  var FLUSH_BATCH    = cfg.flushBatch   || 50;
  var SAMPLE_RATE    = cfg.sampleRate    !== undefined ? parseFloat(cfg.sampleRate)    : 1.0;
  var COOLDOWN_HOURS = cfg.cooldownHours !== undefined ? parseFloat(cfg.cooldownHours) : 0;

  function shouldRecord() {
    if (Math.random() > SAMPLE_RATE) return false;
    if (COOLDOWN_HOURS > 0) {
      var key  = '__sr_last_' + SITE_ID;
      var last = parseInt(localStorage.getItem(key) || '0', 10);
      var now  = Date.now();
      if (last && (now - last) < COOLDOWN_HOURS * 3600 * 1000) return false;
      localStorage.setItem(key, String(now));
    }
    return true;
  }

  if (window.__smartRecordingActive) return;
  window.__smartRecordingActive = true;

  function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  var SESSION_ID     = generateId();
  var events         = [];
  var flushTimer     = null;
  var stopFn         = null;
  var sessionStarted = false;

  // ── Metriche comportamentali ────────────────────────────────────────────────
  var rageClicks    = 0;
  var consoleErrors = 0;
  var uturns        = 0;
  var pageList      = [];        // array di { path, time }
  var markers       = [];        // eventi chiave con timestamp relativo

  var SESSION_START_TS = null;   // impostato in startSession

  function relTime() {
    return SESSION_START_TS ? Date.now() - SESSION_START_TS : 0;
  }

  function addMarker(type, payload) {
    markers.push(Object.assign({ type: type, t: relTime() }, payload || {}));
  }

  // ── Rage click (3+ click in <700ms entro 30px) ─────────────────────────────
  var clickHistory = [];
  function onDocClick(e) {
    var now = Date.now();
    clickHistory = clickHistory.filter(function (c) { return now - c.time < 700; });
    clickHistory.push({ time: now, x: e.clientX, y: e.clientY });
    var nearby = clickHistory.filter(function (c) {
      return Math.sqrt(Math.pow(c.x - e.clientX, 2) + Math.pow(c.y - e.clientY, 2)) < 30;
    });
    if (nearby.length >= 3) {
      rageClicks++;
      addMarker('rage_click', { x: Math.round(e.clientX), y: Math.round(e.clientY) });
    }
  }
  document.addEventListener('click', onDocClick, true);

  // ── Navigazione pagine (SPA: pushState / popstate) ─────────────────────────
  var lastNavTime = Date.now();

  function onPageChange(newPath) {
    var now  = Date.now();
    var prev = pageList.length ? pageList[pageList.length - 1].path : null;
    if (newPath === prev) return;

    // U-turn: torna su una pagina già visitata entro 30s
    var recentPaths = pageList.slice(-5).map(function (p) { return p.path; });
    if (recentPaths.indexOf(newPath) !== -1 && (now - lastNavTime) < 30000) {
      uturns++;
      addMarker('uturn', { from: prev, to: newPath });
    }

    pageList.push({ path: newPath, time: now });
    addMarker('page_change', { path: newPath });
    lastNavTime = now;
  }

  // Inizializza con la pagina di landing
  pageList.push({ path: window.location.pathname + window.location.search, time: Date.now() });

  // Intercetta pushState / replaceState
  function wrapHistory(method) {
    var orig = history[method];
    history[method] = function () {
      orig.apply(history, arguments);
      onPageChange(window.location.pathname + window.location.search);
    };
  }
  wrapHistory('pushState');
  wrapHistory('replaceState');
  window.addEventListener('popstate', function () {
    onPageChange(window.location.pathname + window.location.search);
  });

  // ── Console errors ──────────────────────────────────────────────────────────
  var _origError = console.error;
  console.error = function () {
    _origError.apply(console, arguments);
    consoleErrors++;
    try {
      var msg = Array.prototype.slice.call(arguments).join(' ').substring(0, 200);
      addMarker('console_error', { msg: msg });
    } catch (e) {}
  };
  window.addEventListener('error', function (e) {
    consoleErrors++;
    addMarker('console_error', { msg: (e.message || '').substring(0, 200) });
  });
  window.addEventListener('unhandledrejection', function (e) {
    consoleErrors++;
    addMarker('console_error', { msg: 'Unhandled Promise rejection' });
  });

  // ── Fetch helper ────────────────────────────────────────────────────────────
  function post(path, body, keepalive) {
    try {
      fetch(SERVER_URL + path, {
        method:    'POST',
        headers:   { 'Content-Type': 'application/json' },
        body:      JSON.stringify(body),
        keepalive: !!keepalive,
      }).catch(function () {});
    } catch (e) {}
  }

  // ── Flush rrweb events ──────────────────────────────────────────────────────
  function flush(keepalive) {
    if (events.length === 0) return;
    var batch = events.splice(0);
    post('/api/sessions/' + SESSION_ID + '/events', { events: batch }, keepalive);
  }

  function scheduleFlush() {
    clearTimeout(flushTimer);
    flushTimer = setTimeout(function () { flush(false); }, FLUSH_INTERVAL);
  }

  // ── Device info ─────────────────────────────────────────────────────────────
  function getDeviceType() {
    var w = window.innerWidth;
    var t = ('ontouchstart' in window) || navigator.maxTouchPoints > 0;
    if (w <= 768 && t) return 'mobile';
    if (w <= 1024 && t) return 'tablet';
    return 'desktop';
  }

  function getOS() {
    var ua = navigator.userAgent;
    if (/Android/i.test(ua))          return 'Android';
    if (/iPhone|iPad|iPod/i.test(ua)) return 'iOS';
    if (/Windows/i.test(ua))          return 'Windows';
    if (/Mac OS X/i.test(ua))         return 'macOS';
    if (/Linux/i.test(ua))            return 'Linux';
    return 'Unknown';
  }

  // ── Avvio sessione ──────────────────────────────────────────────────────────
  function startSession() {
    SESSION_START_TS = Date.now();
    var conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    post('/api/sessions/start', {
      sessionId:      SESSION_ID,
      siteId:         SITE_ID,
      url:            window.location.href,
      referrer:       document.referrer || '',
      userAgent:      navigator.userAgent,
      viewport:       { width: window.innerWidth, height: window.innerHeight },
      deviceType:     getDeviceType(),
      os:             getOS(),
      language:       navigator.language || '',
      timezone:       Intl ? Intl.DateTimeFormat().resolvedOptions().timeZone : '',
      connectionType: conn ? (conn.effectiveType || conn.type || '') : '',
      pixelRatio:     window.devicePixelRatio || 1,
    }, false);
    sessionStarted = true;
  }

  // ── Carica rrweb ─────────────────────────────────────────────────────────────
  function loadRrweb(callback) {
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
        if (events.length >= FLUSH_BATCH) flush(false);
        else scheduleFlush();
      },
      maskAllInputs:             MASK_INPUTS,
      maskTextSelector:          MASK_INPUTS ? 'input[type="password"]' : undefined,
      recordCrossOriginIframes:  false,
    });
  }

  // ── Unload: flush + chiusura con metriche ───────────────────────────────────
  function onUnload() {
    if (!sessionStarted) return;
    sessionStarted = false; // evita doppio invio
    flush(true);
    post('/api/sessions/' + SESSION_ID + '/end', {
      rageClicks:    rageClicks,
      consoleErrors: consoleErrors,
      uturns:        uturns,
      pagesVisited:  pageList.length,
      pageList:      pageList.slice(0, 50),  // max 50 pagine
      markers:       markers,
    }, true);
    if (typeof stopFn === 'function') stopFn();
  }

  window.addEventListener('beforeunload', onUnload);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') onUnload();
  });

  // ── API pubblica ────────────────────────────────────────────────────────────
  window.SmartRecording = {
    stop:         function () { if (typeof stopFn === 'function') { stopFn(); stopFn = null; } flush(false); },
    getSessionId: function () { return SESSION_ID; },
    track:        function (eventName, payload) {
      addMarker('custom_' + eventName, payload || {});
      // Flush periodico — non immediato per non interrompere la registrazione
    },
  };

  // ── Init ─────────────────────────────────────────────────────────────────────
  if (!shouldRecord()) return;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { loadRrweb(startRecording); });
  } else {
    loadRrweb(startRecording);
  }

})();
