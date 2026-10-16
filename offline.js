// =====================================================
// MenuPro – offline.js
// Database locale (IndexedDB) + coda di sincronizzazione + shim Supabase
//
// Come funziona, in breve:
//  - `sb` (il client Supabase) viene "avvolto": script.js continua a chiamare
//    sb.from('ordini').update(...).eq(...) come prima.
//  - LETTURE: online leggono dal server e aggiornano la copia locale.
//    Offline (o con modifiche ancora in coda) leggono la copia locale.
//  - SCRITTURE (ristoratore e cliente): applicate subito in locale, messe in
//    coda e inviate appena possibile. Offline restano in coda e partono da sole
//    quando torna la connessione.
//  - L'area admin NON viene mai messa in coda: resta solo online.
// =====================================================
(function () {
  'use strict';

  var DB_NAME = 'menupro-offline';
  var DB_VERSION = 1;
  var FETCH_TIMEOUT = 8000;      // ms: oltre, la rete è considerata assente
  var NET_RETRY_AFTER = 10000;   // ms: pausa dopo un errore di rete
  var POLL_EVERY = 6000;         // ms: controllo nuovi ordini (ristoratore)
  var RETRY_EVERY = 15000;       // ms: tentativo periodico di sincronizzazione

  // Tabelle che possono stare in locale / essere accodate
  var SYNC_TABLES = ['ristoranti', 'tavoli', 'piatti', 'categorie', 'ordini', 'ordine_riga', 'messaggio', 'pagamento'];
  var MENU_TABLES = ['ristoranti', 'tavoli', 'piatti', 'categorie'];
  // Tabelle con id uuid: l'id viene generato dal client così un reinvio non crea doppioni
  var CLIENT_ID_TABLES = ['ordini', 'piatti', 'tavoli', 'categorie'];
  // Tabelle accessorie: se mancano sul database l'app originale ignorava l'errore
  var OPTIONAL_TABLES = ['ordine_riga', 'messaggio', 'pagamento'];
  // Cosa può scrivere un cliente (QR)
  var CLIENT_WRITES = { ordini: 'insert', ordine_riga: 'insert', messaggio: 'insert', pagamento: 'insert', tavoli: 'update' };
  var STATO_ORDER = ['nuovo', 'in_preparazione', 'pronto', 'consegnato', 'chiuso'];
  var FILTERS = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'is', 'in'];
  var ISO_RE = /^\d{4}-\d{2}-\d{2}T/;

  // ---------------------------------------------------
  // Stato in memoria
  // ---------------------------------------------------
  var idb = null;
  var realClient = null;
  var rows = new Map();          // tabella -> Map(id -> riga)
  var outbox = [];               // modifiche in attesa [{seq, table, type, payload, calls, ts, tries}]
  var failed = [];               // modifiche rifiutate dal server
  var meta = new Map();          // chiave -> valore (sessione, ecc.)
  var seq = 1;
  var flushing = null;
  var netDownUntil = 0;
  var lastSyncedAt = 0;
  var opResults = new Map();     // seq -> errore permanente
  var pollSig = null;
  var pollIds = null;
  var pollRid = null;

  // ---------------------------------------------------
  // Utilità
  // ---------------------------------------------------
  function logErr(e) { try { console.warn('[offline]', e && e.message ? e.message : e); } catch (_) {} }

  function clone(v) {
    if (v === undefined || v === null) return v;
    if (typeof structuredClone === 'function') {
      try { return structuredClone(v); } catch (_) {}
    }
    return JSON.parse(JSON.stringify(v));
  }

  function uuid() {
    var c = (typeof crypto !== 'undefined') ? crypto : null;
    if (c && c.randomUUID) return c.randomUUID();
    var b = new Uint8Array(16);
    if (c && c.getRandomValues) c.getRandomValues(b);
    else for (var i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    var h = Array.prototype.map.call(b, function (x) { return ('0' + x.toString(16)).slice(-2); });
    return h.slice(0, 4).join('') + '-' + h.slice(4, 6).join('') + '-' + h.slice(6, 8).join('') +
      '-' + h.slice(8, 10).join('') + '-' + h.slice(10).join('');
  }

  function tableMap(t) {
    var m = rows.get(t);
    if (!m) { m = new Map(); rows.set(t, m); }
    return m;
  }

  function currentRole() {
    try { return (typeof currentUser !== 'undefined' && currentUser) ? currentUser.role : null; }
    catch (_) { return null; }
  }
  function currentRistoranteId() {
    try { return (typeof currentRistorante !== 'undefined' && currentRistorante) ? currentRistorante.id : null; }
    catch (_) { return null; }
  }
  function currentRistoranteObj() {
    try { return (typeof currentRistorante !== 'undefined') ? currentRistorante : null; }
    catch (_) { return null; }
  }

  function isOffline() {
    return (typeof navigator !== 'undefined' && navigator.onLine === false) || Date.now() < netDownUntil;
  }
  function canTryNetwork() {
    return !!realClient && !isOffline();
  }
  function netDown() { netDownUntil = Date.now() + NET_RETRY_AFTER; emitStatus(); }
  function netOk() { if (netDownUntil) { netDownUntil = 0; emitStatus(); } }

  // Errore di rete (fetch fallita, timeout) – NON un errore del database
  function isNetworkError(err, status) {
    if (status === 0 && !(err && err.code)) return true;
    if (!err) return false;
    if (err.code) return false; // errori Postgres / PostgREST veri hanno un codice
    var m = String(err.message || err).toLowerCase();
    return /failed to fetch|networkerror|network request failed|load failed|abort|timeout|fetch/.test(m);
  }
  function isTransientStatus(status) {
    return status === 408 || status === 429 || (status >= 500 && status < 600);
  }

  // fetch con timeout, usata dal client Supabase
  function fetchWithTimeout(url, opts) {
    opts = opts || {};
    var ctrl = new AbortController();
    var t = setTimeout(function () { ctrl.abort(); }, FETCH_TIMEOUT);
    if (opts.signal) {
      if (opts.signal.aborted) ctrl.abort();
      else opts.signal.addEventListener('abort', function () { ctrl.abort(); });
    }
    var o = Object.assign({}, opts, { signal: ctrl.signal });
    return fetch(url, o).then(
      function (r) { clearTimeout(t); return r; },
      function (e) { clearTimeout(t); throw e; }
    );
  }

  // ---------------------------------------------------
  // IndexedDB (con fallback in sola memoria se non disponibile)
  // ---------------------------------------------------
  function openDb() {
    return new Promise(function (resolve) {
      if (typeof indexedDB === 'undefined' || !indexedDB) return resolve(null);
      var r;
      try { r = indexedDB.open(DB_NAME, DB_VERSION); } catch (e) { return resolve(null); }
      r.onupgradeneeded = function () {
        var d = r.result;
        if (!d.objectStoreNames.contains('rows')) d.createObjectStore('rows', { keyPath: 'k' });
        if (!d.objectStoreNames.contains('outbox')) d.createObjectStore('outbox', { keyPath: 'seq' });
        if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'key' });
      };
      r.onsuccess = function () { resolve(r.result); };
      r.onerror = function () { resolve(null); };
      r.onblocked = function () { resolve(null); };
    });
  }

  function idbRun(store, mode, fn) {
    return new Promise(function (resolve, reject) {
      if (!idb) return resolve(undefined);
      var out;
      try {
        var t = idb.transaction(store, mode);
        var s = t.objectStore(store);
        var r = fn(s);
        if (r) r.onsuccess = function () { out = r.result; };
        t.oncomplete = function () { resolve(out); };
        t.onerror = function () { reject(t.error); };
        t.onabort = function () { reject(t.error); };
      } catch (e) { reject(e); }
    });
  }
  function dbPut(store, v) { return idbRun(store, 'readwrite', function (s) { return s.put(v); }).catch(logErr); }
  function dbDel(store, k) { return idbRun(store, 'readwrite', function (s) { return s.delete(k); }).catch(logErr); }
  function dbClear(store) { return idbRun(store, 'readwrite', function (s) { return s.clear(); }).catch(logErr); }
  function dbAll(store) { return idbRun(store, 'readonly', function (s) { return s.getAll(); }).then(function (r) { return r || []; }).catch(function (e) { logErr(e); return []; }); }

  function persistRows(table, putRows, delIds) {
    if (!idb) return Promise.resolve();
    return new Promise(function (resolve) {
      try {
        var t = idb.transaction('rows', 'readwrite');
        var s = t.objectStore('rows');
        (putRows || []).forEach(function (r) {
          s.put({ k: table + ':' + r.id, t: table, id: String(r.id), row: r });
        });
        (delIds || []).forEach(function (id) { s.delete(table + ':' + id); });
        t.oncomplete = resolve;
        t.onerror = function () { logErr(t.error); resolve(); };
        t.onabort = function () { logErr(t.error); resolve(); };
      } catch (e) { logErr(e); resolve(); }
    });
  }
  function persistOp(op) { return dbPut('outbox', op); }
  function persistFailed() { return dbPut('meta', { key: 'failed', value: failed }); }
  function setMeta(key, value) { meta.set(key, value); return dbPut('meta', { key: key, value: value }); }

  var ready = (async function init() {
    try { idb = await openDb(); } catch (_) { idb = null; }
    if (idb) {
      (await dbAll('rows')).forEach(function (e) { tableMap(e.t).set(String(e.id), e.row); });
      outbox = (await dbAll('outbox')).sort(function (a, b) { return a.seq - b.seq; });
      (await dbAll('meta')).forEach(function (e) { meta.set(e.key, e.value); });
      failed = meta.get('failed') || [];
      seq = outbox.reduce(function (m, o) { return Math.max(m, o.seq); }, 0) + 1;
    }
    try {
      if (typeof navigator !== 'undefined' && navigator.storage && navigator.storage.persist) navigator.storage.persist();
    } catch (_) {}
    emitStatus();
  })();

  // ---------------------------------------------------
  // Filtri / ordinamento locali
  // ---------------------------------------------------
  function looseEq(a, b) {
    if (a === b) return true;
    if (a == null || b == null) return false;
    return String(a) === String(b);
  }
  function cmp(a, b) {
    if (a == null && b == null) return 0;
    if (a == null) return 1;
    if (b == null) return -1;
    if (typeof a === 'string' && typeof b === 'string' && ISO_RE.test(a) && ISO_RE.test(b)) {
      return Date.parse(a) - Date.parse(b);
    }
    return a < b ? -1 : (a > b ? 1 : 0);
  }
  function matchRow(r, f) {
    var m = f[0], c = f[1][0], v = f[1][1], x = r[c];
    switch (m) {
      case 'eq': return looseEq(x, v);
      case 'neq': return !looseEq(x, v);
      case 'in': return Array.isArray(v) && v.some(function (y) { return looseEq(x, y); });
      case 'gt': return cmp(x, v) > 0 && x != null;
      case 'gte': return cmp(x, v) >= 0 && x != null;
      case 'lt': return cmp(x, v) < 0 && x != null;
      case 'lte': return cmp(x, v) <= 0 && x != null;
      case 'is': return v === null ? x == null : x === v;
      default: return true;
    }
  }
  function isFilter(call) { return FILTERS.indexOf(call[0]) !== -1; }

  function localSelect(q) {
    var list = Array.from(tableMap(q.table).values());
    var orders = [], limit = null, single = null;
    for (var i = 0; i < q.calls.length; i++) {
      var c = q.calls[i], m = c[0];
      if (isFilter(c)) list = list.filter(function (r) { return matchRow(r, c); });
      else if (m === 'order') orders.push(c[1]);
      else if (m === 'limit') limit = c[1][0];
      else if (m === 'single' || m === 'maybeSingle') single = m;
      else if (m === 'throwOnError') { /* ignora */ }
      else return { data: null, count: null, status: 0, error: { message: 'Operazione non supportata offline: ' + m, code: 'OFFLINE_UNSUPPORTED' } };
    }
    if (orders.length) {
      list.sort(function (a, b) {
        for (var k = 0; k < orders.length; k++) {
          var col = orders[k][0], asc = !(orders[k][1] && orders[k][1].ascending === false);
          var d = cmp(a[col], b[col]);
          if (d !== 0) return asc ? d : -d;
        }
        return 0;
      });
    }
    var total = list.length;
    if (limit != null) list = list.slice(0, limit);
    var wantCount = q.opts && q.opts.count ? total : null;
    if (q.opts && q.opts.head) return { data: null, count: wantCount, error: null, status: 200 };
    var data = clone(list);
    if (single === 'single') {
      if (data.length !== 1) return { data: null, count: null, status: 406, error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' } };
      data = data[0];
    } else if (single === 'maybeSingle') {
      if (data.length > 1) return { data: null, count: null, status: 406, error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' } };
      data = data[0] || null;
    }
    return { data: data, count: wantCount, error: null, status: 200 };
  }

  // ---------------------------------------------------
  // Cache locale alimentata dalle letture online
  // ---------------------------------------------------
  function stripSecret(table, r) {
    var c = Object.assign({}, r);
    if (table === 'ristoranti') delete c.password; // mai password in chiaro sul dispositivo
    return c;
  }

  function cacheAllowed(q, role) {
    if (SYNC_TABLES.indexOf(q.table) === -1) return false;
    if (role === 'ristoratore') return true;
    if (role === 'cliente') {
      if (MENU_TABLES.indexOf(q.table) !== -1) return true;
      // del cliente salviamo solo la lettura del proprio ordine
      return q.calls.some(function (c) { return c[0] === 'eq' && (c[1][0] === 'id' || c[1][0] === 'id_ordine'); });
    }
    return false; // admin / non loggato: nessuna copia locale
  }

  function cacheFromRead(q, res, role) {
    if (!cacheAllowed(q, role)) return;
    if (q.cols && String(q.cols).replace(/\s/g, '') !== '*') return; // colonne parziali: non salvare
    if (q.opts && q.opts.head) return;
    var isList = Array.isArray(res.data);
    var list = isList ? res.data : (res.data ? [res.data] : []);
    list = list.filter(function (r) { return r && r.id != null; }).map(function (r) { return stripSecret(q.table, r); });
    var t = tableMap(q.table);
    var removeIds = [];
    var limited = q.calls.some(function (c) { return c[0] === 'limit' || c[0] === 'range'; });
    if (isList && !limited) {
      // niente è in coda (siamo qui solo a coda vuota): le righe locali che il
      // server non ha più, e che rientrano negli stessi filtri, vanno tolte
      var ids = new Set(list.map(function (r) { return String(r.id); }));
      var filters = q.calls.filter(isFilter);
      t.forEach(function (row, id) {
        if (!ids.has(String(id)) && filters.every(function (f) { return matchRow(row, f); })) removeIds.push(id);
      });
    }
    list.forEach(function (r) { t.set(String(r.id), r); });
    removeIds.forEach(function (id) { t.delete(id); });
    persistRows(q.table, list, removeIds);
  }

  // ---------------------------------------------------
  // Esecuzione letture
  // ---------------------------------------------------
  function replayRead(q) {
    var b = realClient.from(q.table);
    b = (q.opts !== undefined && q.opts !== null) ? b.select(q.cols || '*', q.opts) : b.select(q.cols || '*');
    for (var i = 0; i < q.calls.length; i++) b = b[q.calls[i][0]].apply(b, q.calls[i][1]);
    return b;
  }

  function localAllowed(q, role) {
    return (role === 'ristoratore' || role === 'cliente') && SYNC_TABLES.indexOf(q.table) !== -1;
  }

  async function execRead(q) {
    await ready;
    var role = currentRole();
    if (outbox.length && canTryNetwork()) await flush();
    if (!outbox.length && canTryNetwork()) {
      var res;
      try { res = await replayRead(q); } catch (e) { res = { data: null, error: e, status: 0 }; }
      if (!res.error) { netOk(); cacheFromRead(q, res, role); return res; }
      if (!isNetworkError(res.error, res.status)) { netOk(); return res; }
      netDown();
    }
    if (!localAllowed(q, role)) {
      return { data: null, count: null, status: 0, error: { message: 'Sei offline', code: 'OFFLINE' } };
    }
    return localSelect(q);
  }

  // ---------------------------------------------------
  // Esecuzione scritture
  // ---------------------------------------------------
  function queueable(q, role) {
    if (role !== 'ristoratore' && role !== 'cliente') return false;
    if (SYNC_TABLES.indexOf(q.table) === -1) return false;
    if (q.op === 'upsert') return false;
    if (q.table === 'ristoranti' && q.op !== 'update') return false;
    if (role === 'cliente' && CLIENT_WRITES[q.table] !== q.op) return false;
    var list = Array.isArray(q.payload) ? q.payload : [q.payload];
    if (list.some(function (r) { return r && typeof r === 'object' && 'password' in r; })) return false;
    return true;
  }

  function passWrite(q) {
    if (!realClient) return Promise.resolve({ data: null, error: { message: 'Database non collegato' }, status: 0 });
    var b = realClient.from(q.table);
    if (q.op === 'delete') b = b.delete(q.opts);
    else if (q.opts !== undefined && q.opts !== null) b = b[q.op](q.payload, q.opts);
    else b = b[q.op](q.payload);
    for (var i = 0; i < q.calls.length; i++) b = b[q.calls[i][0]].apply(b, q.calls[i][1]);
    return Promise.resolve(b).then(function (r) { return r; }, function (e) { return { data: null, error: e, status: 0 }; });
  }

  function shapeWriteResult(q, affected) {
    var returning = q.calls.some(function (c) { return c[0] === 'select'; });
    if (!returning) return { data: null, error: null, status: 201 };
    var data = clone(affected);
    var single = q.calls.some(function (c) { return c[0] === 'single'; });
    var maybe = q.calls.some(function (c) { return c[0] === 'maybeSingle'; });
    if (single || maybe) data = data[0] || null;
    return { data: data, error: null, status: 201 };
  }

  async function execWrite(q) {
    await ready;
    var role = currentRole();
    if (!queueable(q, role)) return passWrite(q);

    var t = tableMap(q.table);
    var filters = q.calls.filter(isFilter);
    var op = { seq: seq++, table: q.table, type: q.op, ts: Date.now(), calls: clone(filters), payload: null, tries: 0 };
    var affected = [];
    var delIds = [];

    if (q.op === 'insert') {
      var input = Array.isArray(q.payload) ? q.payload : [q.payload];
      var toSend = input.map(function (r) {
        var row = Object.assign({}, r);
        if (CLIENT_ID_TABLES.indexOf(q.table) !== -1 && row.id == null) row.id = uuid();
        if (q.table === 'ordini' && !row.created_at) row.created_at = new Date().toISOString();
        return row;
      });
      op.payload = clone(toSend);
      toSend.forEach(function (r) {
        var local = Object.assign({}, r);
        if (local.id == null) local.id = 'loc-' + uuid(); // solo locale, non viene inviato
        t.set(String(local.id), local);
        affected.push(local);
      });
      persistRows(q.table, affected, []);
    } else if (q.op === 'update') {
      op.payload = clone(q.payload);
      t.forEach(function (row) {
        if (filters.every(function (f) { return matchRow(row, f); })) {
          Object.assign(row, q.payload);
          affected.push(row);
        }
      });
      persistRows(q.table, affected, []);
    } else if (q.op === 'delete') {
      t.forEach(function (row, id) {
        if (filters.every(function (f) { return matchRow(row, f); })) delIds.push(id);
      });
      delIds.forEach(function (id) { t.delete(id); });
      persistRows(q.table, [], delIds);
    }

    outbox.push(op);
    persistOp(op);
    emitStatus();

    if (canTryNetwork()) {
      await flush();
      var err = opResults.get(op.seq);
      if (err) {
        opResults.delete(op.seq);
        return { data: null, error: err, status: 400 };
      }
    } else {
      requestBackgroundSync();
    }
    return shapeWriteResult(q, affected);
  }

  // ---------------------------------------------------
  // Sincronizzazione
  // ---------------------------------------------------
  async function sendOp(op) {
    var attempt = 0;
    while (true) {
      attempt++;
      var res;
      try {
        var b = realClient.from(op.table);
        var calls = (op.calls || []).slice();
        if (op.type === 'insert') {
          var hasIds = op.payload.every(function (r) { return r.id != null; });
          // upsert + ignoreDuplicates: se l'invio viene ripetuto non nascono doppioni
          b = hasIds ? b.upsert(op.payload, { onConflict: 'id', ignoreDuplicates: true }) : b.insert(op.payload);
        } else if (op.type === 'update') {
          b = b.update(op.payload);
          // lo stato di un ordine può solo avanzare: una modifica vecchia
          // arrivata in ritardo non fa tornare indietro un ordine già avanzato
          if (op.table === 'ordini' && op.payload && op.payload.stato) {
            var i = STATO_ORDER.indexOf(op.payload.stato);
            if (i > 0) calls.push(['in', ['stato', STATO_ORDER.slice(0, i)]]);
          }
        } else {
          b = b.delete();
        }
        for (var k = 0; k < calls.length; k++) b = b[calls[k][0]].apply(b, calls[k][1]);
        res = await b;
      } catch (e) { res = { error: e, status: 0 }; }

      if (!res || !res.error) return { ok: true };
      var err = res.error;

      // schema vecchio senza colonna "items": come faceva l'app, riprova senza
      if (op.table === 'ordini' && op.type === 'insert' && attempt === 1 &&
          /items/i.test(err.message || '') && op.payload.some(function (r) { return 'items' in r; })) {
        op.payload = op.payload.map(function (r) { var c = Object.assign({}, r); delete c.items; return c; });
        persistOp(op);
        continue;
      }
      if (isNetworkError(err, res.status)) return { network: true };
      if (isTransientStatus(res.status)) {
        op.tries = (op.tries || 0) + 1;
        persistOp(op);
        if (op.tries < 5) return { network: true };
      }
      return { error: err };
    }
  }

  async function runFlush() {
    var synced = 0;
    emitStatus();
    while (outbox.length) {
      var op = outbox[0];
      var r = await sendOp(op);
      if (r.ok) {
        outbox.shift(); dbDel('outbox', op.seq); synced++; netOk();
        continue;
      }
      if (r.network) { netDown(); break; }
      // rifiutata dal server: non blocca le altre
      outbox.shift(); dbDel('outbox', op.seq);
      var code = r.error && r.error.code;
      var silent = OPTIONAL_TABLES.indexOf(op.table) !== -1 && ['PGRST205', 'PGRST204', '42P01', '42703'].indexOf(code) !== -1;
      if (silent) {
        logErr('Tabella/colonna opzionale mancante (' + op.table + '): ignorato');
      } else {
        failed.push({ table: op.table, type: op.type, error: String((r.error && r.error.message) || r.error), ts: op.ts });
        persistFailed();
        opResults.set(op.seq, r.error);
      }
    }
    if (synced) {
      lastSyncedAt = Date.now();
      try { window.dispatchEvent(new CustomEvent('offline:synced', { detail: { count: synced } })); } catch (_) {}
    }
  }

  async function flush() {
    while (true) {
      if (flushing) { await flushing; continue; }
      if (!outbox.length || !canTryNetwork()) return;
      flushing = runFlush();
      try { await flushing; }
      finally { flushing = null; emitStatus(); }
      if (!outbox.length) return;
    }
  }

  // Riprova subito (evento "online", ritorno in primo piano, messaggio del Service Worker)
  function retryNow() {
    netDownUntil = 0;
    emitStatus();
    return flush();
  }

  function requestBackgroundSync() {
    try {
      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.ready.then(function (reg) {
          if (reg && reg.sync) return reg.sync.register('menupro-sync');
        }).catch(function () {});
      }
    } catch (_) {}
  }

  function isPending(table, id) {
    return outbox.some(function (op) {
      if (op.table !== table) return false;
      if (op.type === 'insert') return op.payload.some(function (r) { return String(r.id) === String(id); });
      return (op.calls || []).some(function (c) { return c[0] === 'eq' && c[1][0] === 'id' && String(c[1][1]) === String(id); });
    });
  }

  // ---------------------------------------------------
  // Query builder compatibile con supabase-js
  // ---------------------------------------------------
  function makeBuilder(table) {
    var q = { table: table, op: null, payload: null, opts: undefined, cols: null, calls: [] };
    var b = {};
    var p = null;
    function run() {
      if (!p) p = (q.op === null || q.op === 'select') ? execRead(q) : execWrite(q);
      return p;
    }
    b.select = function (cols, opts) {
      if (q.op === null) { q.op = 'select'; q.cols = cols; q.opts = opts; }
      else q.calls.push(['select', cols === undefined ? [] : [cols]]);
      return b;
    };
    b.insert = function (payload, opts) { q.op = 'insert'; q.payload = payload; q.opts = opts; return b; };
    b.update = function (payload, opts) { q.op = 'update'; q.payload = payload; q.opts = opts; return b; };
    b.upsert = function (payload, opts) { q.op = 'upsert'; q.payload = payload; q.opts = opts; return b; };
    b.delete = function (opts) { q.op = 'delete'; q.opts = opts; return b; };
    ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'is', 'in', 'like', 'ilike', 'contains', 'containedBy',
     'overlaps', 'or', 'not', 'filter', 'match', 'textSearch', 'order', 'limit', 'range',
     'single', 'maybeSingle', 'csv', 'throwOnError', 'abortSignal'].forEach(function (m) {
      b[m] = function () { q.calls.push([m, Array.prototype.slice.call(arguments)]); return b; };
    });
    b.then = function (ok, ko) { return run().then(ok, ko); };
    b.catch = function (ko) { return run().then(undefined, ko); };
    b.finally = function (f) { return run().finally(f); };
    return b;
  }

  function wrap(real) {
    realClient = real || null;
    var shim = {
      from: function (table) { return makeBuilder(table); }
    };
    if (!real) return shim;
    return new Proxy(real, {
      get: function (target, prop) {
        if (prop === 'from') return shim.from;
        var v = target[prop];
        return typeof v === 'function' ? v.bind(target) : v;
      }
    });
  }

  // ---------------------------------------------------
  // Sessione e logout
  // ---------------------------------------------------
  async function saveSession(s) {
    await ready;
    var prev = meta.get('session');
    if (prev && prev.ristoranteId && s && prev.ristoranteId !== s.ristoranteId) {
      // altro ristorante su questo dispositivo: via la vecchia copia dati
      rows.clear();
      await dbClear('rows');
    }
    await setMeta('session', s);
  }
  async function loadSession() { await ready; return meta.get('session') || null; }

  async function beforeLogout() {
    await ready;
    if (outbox.length && canTryNetwork()) await flush();
    if (!outbox.length) return true;
    return window.confirm('Ci sono ' + outbox.length + ' modifiche non ancora inviate al server.\n' +
      'Se esci ora andranno perse.\n\nUscire comunque?');
  }
  async function onLogout() {
    await ready;
    rows.clear(); outbox = []; failed = []; meta.clear();
    pollSig = null; pollIds = null; pollRid = null;
    await Promise.all([dbClear('rows'), dbClear('outbox'), dbClear('meta')]);
    emitStatus();
  }

  // ---------------------------------------------------
  // Banner di stato
  // ---------------------------------------------------
  var banner = null;
  function status() {
    return { offline: isOffline(), pending: outbox.length, failed: failed.length, syncing: !!flushing };
  }
  function ensureBanner() {
    if (banner || typeof document === 'undefined' || !document.body) return banner;
    banner = document.createElement('div');
    banner.id = 'offline-banner';
    banner.className = 'offline-banner hidden';
    banner.addEventListener('click', onBannerClick);
    document.body.appendChild(banner);
    return banner;
  }
  function renderBanner() {
    var b = ensureBanner();
    if (!b) return;
    var st = status(), cls = '', html = '';
    if (st.failed) {
      cls = 'warn';
      html = '<i class="fas fa-triangle-exclamation"></i> ' + st.failed +
        (st.failed === 1 ? ' modifica non sincronizzata' : ' modifiche non sincronizzate') + ' – tocca per i dettagli';
    } else if (st.offline) {
      cls = 'off';
      html = '<i class="fas fa-wifi"></i> Offline · ' + (st.pending
        ? st.pending + (st.pending === 1 ? ' modifica in attesa di invio' : ' modifiche in attesa di invio')
        : 'puoi continuare a lavorare');
    } else if (st.pending || st.syncing) {
      cls = 'sync';
      html = '<i class="fas fa-rotate"></i> Sincronizzazione in corso…' + (st.pending ? ' (' + st.pending + ')' : '');
    } else if (Date.now() - lastSyncedAt < 2500) {
      cls = 'ok';
      html = '<i class="fas fa-check"></i> Tutto sincronizzato';
    }
    if (!html) { b.className = 'offline-banner hidden'; return; }
    b.className = 'offline-banner ' + cls;
    b.innerHTML = html;
  }
  function onBannerClick() {
    if (!failed.length) return;
    var lines = failed.slice(-5).map(function (f) { return '• ' + f.type + ' su ' + f.table + ': ' + f.error; }).join('\n');
    if (window.confirm('Queste modifiche non sono state accettate dal server:\n\n' + lines +
        '\n\nScartarle? (i dati verranno riallineati con il server)')) {
      failed = [];
      persistFailed();
      emitStatus();
      try { window.dispatchEvent(new CustomEvent('offline:synced', { detail: { count: 0 } })); } catch (_) {}
    }
  }
  function emitStatus() {
    try { renderBanner(); } catch (_) {}
    try { window.dispatchEvent(new CustomEvent('offline:status', { detail: status() })); } catch (_) {}
  }

  // ---------------------------------------------------
  // Aggiornamento automatico (nuovi ordini per il ristoratore)
  // ---------------------------------------------------
  function sigOf(list) {
    return (list || []).map(function (o) { return o.id + ':' + (o.stato || '') + ':' + (o.stato_pagamento || ''); }).sort().join('|');
  }

  async function pollOrders() {
    if (currentRole() !== 'ristoratore') return;
    if ((typeof document !== 'undefined' && document.hidden) || !canTryNetwork() || outbox.length || flushing) return;
    var rid = currentRistoranteId();
    if (!rid) return;
    var res;
    try {
      res = await realClient.from('ordini').select('id,stato,stato_pagamento').eq('id_ristorante', rid);
    } catch (e) { res = { error: e, status: 0 }; }
    if (res.error) { if (isNetworkError(res.error, res.status)) netDown(); return; }
    netOk();
    var data = res.data || [];
    var sig = sigOf(data);
    var ids = new Set(data.map(function (o) { return String(o.id); }));
    if (pollRid !== rid || pollSig === null) {
      // base di confronto = ciò che l'app ha già a schermo
      var cr = currentRistoranteObj();
      var local = (cr && cr.ordini) || [];
      pollRid = rid;
      pollSig = sigOf(local);
      pollIds = new Set(local.map(function (o) { return String(o.id); }));
    }
    if (sig !== pollSig) {
      var newOrders = 0;
      ids.forEach(function (id) { if (!pollIds.has(id)) newOrders++; });
      pollSig = sig; pollIds = ids;
      try { window.dispatchEvent(new CustomEvent('offline:remote-change', { detail: { newOrders: newOrders } })); } catch (_) {}
    }
  }

  function callGlobal(name) {
    try { if (typeof window[name] === 'function') return window[name].apply(window, [].slice.call(arguments, 1)); }
    catch (e) { logErr(e); }
  }
  function beep() {
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      var ctx = new Ctx(), o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine'; o.frequency.value = 880; g.gain.value = 0.08;
      o.connect(g); g.connect(ctx.destination);
      o.start(); o.stop(ctx.currentTime + 0.18);
      setTimeout(function () { try { ctx.close(); } catch (_) {} }, 400);
    } catch (_) {}
  }
  function refreshRistoratore(full) {
    if (currentRole() !== 'ristoratore') return;
    callGlobal('renderOrdiniKanban');
    callGlobal('renderRistDashboard');
    callGlobal('renderTavoli');
    if (full) {
      var s = document.querySelector('#search-menu');
      callGlobal('renderMenuTable', s ? s.value : '');
    }
  }

  // ---------------------------------------------------
  // Avvio: eventi, Service Worker, installazione
  // ---------------------------------------------------
  function start() {
    window.addEventListener('online', retryNow);
    window.addEventListener('offline', emitStatus);
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) { retryNow(); pollOrders(); }
    });
    setInterval(function () { if (outbox.length) flush(); else emitStatus(); }, RETRY_EVERY);
    setInterval(pollOrders, POLL_EVERY);

    window.addEventListener('offline:synced', function () {
      pollSig = null;
      emitStatus();
      setTimeout(emitStatus, 2700);
      refreshRistoratore(true);
    });
    window.addEventListener('offline:remote-change', function (e) {
      if (e.detail && e.detail.newOrders > 0) {
        callGlobal('toast', 'Nuovo ordine ricevuto!');
        beep();
      }
      refreshRistoratore(false);
    });

    // Service Worker
    if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
      navigator.serviceWorker.register('sw.js').catch(function (e) { logErr(e); });
      navigator.serviceWorker.addEventListener('message', function (e) {
        if (e.data && e.data.type === 'SYNC') retryNow();
      });
    }

    // Pulsante "Installa app" (non per i clienti arrivati da QR)
    var deferred = null;
    window.addEventListener('beforeinstallprompt', function (e) {
      e.preventDefault();
      if (document.documentElement.classList.contains('qr-entry')) return;
      deferred = e;
      var btn = document.createElement('button');
      btn.id = 'pwa-install';
      btn.className = 'pwa-install';
      btn.innerHTML = '<i class="fas fa-download"></i> Installa app';
      btn.addEventListener('click', function () {
        btn.remove();
        if (deferred) { deferred.prompt(); deferred = null; }
      });
      document.body.appendChild(btn);
    });
    window.addEventListener('appinstalled', function () {
      var b = document.getElementById('pwa-install');
      if (b) b.remove();
    });

    emitStatus();
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
  }

  // ---------------------------------------------------
  // API pubblica
  // ---------------------------------------------------
  window.OFFLINE = {
    wrap: wrap,
    fetch: fetchWithTimeout,
    flush: flush,
    retryNow: retryNow,
    status: status,
    isPending: isPending,
    pendingCount: function () { return outbox.length; },
    saveSession: saveSession,
    loadSession: loadSession,
    beforeLogout: beforeLogout,
    onLogout: onLogout,
    ready: ready
  };
})();
