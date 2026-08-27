// Proxy locale HTTP -> HTTPS verso il language server di Antigravity.
//
// Perché esiste: l'app Antigravity carica la propria UI da
// https://127.0.0.1:<porta> con un certificato self-signed di cui si fida via
// Electron (setCertificateVerifyProc). Una webview di VS Code non può fidarsi
// di quel certificato, quindi qui terminiamo noi il TLS (in Node, dove
// possiamo accettarlo esplicitamente) e riserviamo la UI in HTTP semplice.
//
// In più la UI richiede i bridge nativi del preload Electron (in particolare
// window.nativeStorage, senza il quale non renderizza nulla): iniettiamo nello
// HTML uno shim che li fornisce — storage persistito da questo proxy,
// openExternal/showOpenDialog inoltrati alla webview madre via postMessage.
//
// Dalla 2.11.0 la UI costruisce alcuni client gRPC con URL ASSOLUTI verso
// https://127.0.0.1:<portaLS> invece che relativi alla pagina: nella webview
// quelle chiamate andrebbero dritte al language server saltando il proxy e
// fallirebbero (certificato non fidato + CORS). Lo shim patcha quindi
// window.fetch e window.WebSocket riscrivendo quegli URL sulla propria origine
// (cioè questo proxy). Per il trasporto WebSocket opzionale
// (/connect-websocket) qui sotto c'è anche il tunnel degli upgrade.

const http = require('http');
const https = require('https');
const tls = require('tls');
const fs = require('fs');
const path = require('path');

function buildShim() {
  return `<script>(function () {
  if (window.nativeStorage) return; // dentro l'app Electron vera: non serve nulla

  // --- Diagnostica: errori runtime verso la webview madre -------------------
  function fmt(v) {
    try {
      if (v instanceof Error) return v.stack || v.message;
      if (typeof v === 'object' && v !== null) return JSON.stringify(v).substring(0, 500);
      return String(v);
    } catch (e) { return String(v); }
  }
  function post(type, data) {
    try {
      if (window.parent !== window) {
        var m = { __agpanel: true, type: type };
        if (data) { for (var k in data) m[k] = data[k]; }
        window.parent.postMessage(m, '*');
      }
    } catch (e) {}
  }
  function log(msg) { post('console-log', { message: msg }); }

  window.addEventListener('error', function (ev) {
    log('[runtime error] ' + (ev.message || fmt(ev.error)) +
      (ev.filename ? (' @' + ev.filename + ':' + ev.lineno + ':' + ev.colno) : ''));
  });
  window.addEventListener('unhandledrejection', function (ev) {
    log('[unhandled rejection] ' + fmt(ev.reason));
  });
  ['error', 'warn'].forEach(function (level) {
    var original = console[level].bind(console);
    console[level] = function () {
      try { log('console.' + level + ': ' + [].slice.call(arguments).map(fmt).join(' ')); } catch (e) {}
      original.apply(null, arguments);
    };
  });

  // --- Bridge di rete (2.11.0+): URL assoluti -> questa origine -------------
  // La UI usa baseUrl assoluti tipo "https://127.0.0.1:<portaLS>"; li
  // riscriviamo sul percorso relativo così le chiamate passano da qui.
  var ABS_HOST_RE = /^https?:\\/\\/(?:127\\.0\\.0\\.1|localhost|\\[::1\\])(?::\\d+)?(?=\\/|$)/i;
  function rewriteHttpUrl(raw) {
    var m = ABS_HOST_RE.exec(String(raw || ''));
    if (!m) return raw;
    var rest = String(raw).slice(m[0].length);
    return rest && rest.charAt(0) === '/' ? rest : '/';
  }
  var origFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    try {
      var url = null;
      if (typeof input === 'string' || input instanceof URL) url = String(input);
      else if (input && input.url) url = input.url;
      if (url) {
        var rel = rewriteHttpUrl(url);
        if (rel !== url) {
          if (typeof input === 'string' || input instanceof URL) {
            return origFetch(rel, init);
          }
          try { return origFetch(new Request(rel, input), init); } catch (e) {}
        }
      }
    } catch (e) {}
    return origFetch(input, init);
  };
  var WS_RE = /^(wss?):\\/\\/(?:127\\.0\\.0\\.1|localhost|\\[::1\\]):?\\d*(\\/[^?#]*)(?:[?#].*)?$/i;
  function rewriteWsUrl(raw) {
    var m = WS_RE.exec(String(raw || ''));
    if (!m) return String(raw || '');
    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return proto + '\\/\\/' + location.host + m[2];
  }
  var OrigWS = window.WebSocket;
  function PatchedWebSocket(url, protocols) {
    return protocols !== undefined
      ? new OrigWS(rewriteWsUrl(url), protocols)
      : new OrigWS(rewriteWsUrl(url));
  }
  PatchedWebSocket.prototype = OrigWS.prototype;
  ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'].forEach(function (k) {
    try { PatchedWebSocket[k] = OrigWS[k]; } catch (e) {}
  });
  window.WebSocket = PatchedWebSocket;

  // --- RPC di servizio e bridge nativi ---------------------------------------
  function rpc(p, body) {
    return fetch('/__agpanel/' + p, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {})
    }).then(function (r) { return r.json(); });
  }

  // Canale richiesta/risposta con la webview che ci incornicia.
  var reqId = 0, pending = {};
  function parentRequest(type, data) {
    if (window.parent === window) return Promise.resolve(undefined);
    return new Promise(function (resolve) {
      var id = ++reqId;
      pending[id] = resolve;
      var m = { id: id };
      for (var k in data) m[k] = data[k];
      post(type, m);
      setTimeout(function () { if (pending[id]) { pending[id](undefined); delete pending[id]; } }, 120000);
    });
  }

  function triggerOpenFolder() {
    log('triggerOpenFolder called. Pending workspace: ' + window.__pendingWorkspace);
    var attempts = 0;
    var timer = setInterval(function () {
      var elements = document.querySelectorAll('button, div, span, a');
      var target = null;
      var matches = [];
      var allTexts = [];
      for (var i = 0; i < elements.length; i++) {
        var el = elements[i];
        var text = (el.textContent || '').trim();
        if (text) {
          allTexts.push(el.tagName + '[' + text.substring(0, 40) + ']');
        }
        if (text.indexOf('Open Folder') !== -1 || text.indexOf('Apri cartella') !== -1 || text.indexOf('Add Folder') !== -1 || text.indexOf('Aggiungi cartella') !== -1) {
          matches.push(el.tagName + '.' + el.className + ' ("' + text.substring(0, 30) + '")');
          var hasChildMatch = false;
          for (var j = 0; j < el.children.length; j++) {
            var childText = el.children[j].textContent || '';
            if (childText.indexOf('Open Folder') !== -1 || childText.indexOf('Apri cartella') !== -1 || childText.indexOf('Add Folder') !== -1 || childText.indexOf('Aggiungi cartella') !== -1) {
              hasChildMatch = true;
              break;
            }
          }
          if (!hasChildMatch) {
            target = el;
            break;
          }
        }
      }
      log('Attempt ' + attempts + ': Found ' + elements.length + ' elements. Matches: ' + JSON.stringify(matches));
      if (allTexts.length > 0 && attempts === 0) {
        log('Sample of DOM elements: ' + allTexts.slice(0, 100).join(', '));
      }
      if (target) {
        log('Target found: ' + target.tagName + '.' + target.className + ' text: "' + target.textContent.trim() + '". Clicking!');
        target.click();
        try {
          var event = new MouseEvent('click', {
            view: window,
            bubbles: true,
            cancelable: true
          });
          target.dispatchEvent(event);
          log('Dispatched native click event successfully.');
        } catch (e) {
          log('Failed to dispatch native click event: ' + e.message);
        }
        clearInterval(timer);
        return;
      }
      attempts++;
      if (attempts > 15) {
        log('Timeout reached. Open Folder button not found.');
        clearInterval(timer);
      }
    }, 1000);
  }

  window.addEventListener('message', function (e) {
    var m = e.data;
    if (m && m.__agpanel) {
      if (m.type === 'response' && pending[m.id]) {
        pending[m.id](m.result);
        delete pending[m.id];
      }
      if (m.type === 'openWorkspace') {
        window.__pendingWorkspace = m.path;
        triggerOpenFolder();
      }
    }
  });

  window.nativeStorage = {
    getItems: function () { return rpc('storage/get').then(function (o) { return o || {}; }); },
    updateItems: function (changes) { return rpc('storage/update', changes).then(function () {}); },
    onChanged: function () { return function () {}; }
  };
  window.electronNative = {
    getZoomLevel: function () { return 1; },
    zoomIn: function () {}, zoomOut: function () {}, resetZoom: function () {},
    setTitleBarOverlay: function () { return Promise.resolve(); },
    minimize: function () { return Promise.resolve(); },
    maximize: function () { return Promise.resolve(); },
    unmaximize: function () { return Promise.resolve(); },
    isMaximized: function () { return Promise.resolve(false); },
    close: function () { return Promise.resolve(); },
    toggleDevTools: function () { return Promise.resolve(); },
    openExternal: function (url) { post('open-external', { url: url }); return Promise.resolve(); }
  };
  window.nativeNotifications = {
    send: function () { return Promise.resolve(); },
    openSystemPreferences: function () { return Promise.resolve(); },
    onClicked: function () { return function () {}; }
  };
  window.electronUpdater = {
    onStateChanged: function () { return function () {}; },
    // Richiesto dalla 2.11.0 all'avvio (R0b): senza getState() la UI esce con
    // "TypeError: a.getState is not a function" e non monta nulla.
    getState: function () { return Promise.resolve({ type: 'disabled' }); },
    applyUpdate: function () { return Promise.resolve(); },
    quitAndInstall: function () { return Promise.resolve(); },
    checkForUpdates: function () { return Promise.resolve(); }
  };
  window.deepLink = {
    onDeepLink: function () { return function () {}; },
    getStoredDeepLink: function () { return Promise.resolve(null); }
  };
  window.wizardAPI = {
    // Nomi reali del preload 2.11.0 (wizard:complete / wizard:setup-complete).
    completeWizard: function () { return Promise.resolve(); },
    onSetupComplete: function () { return function () {}; }
  };
  window.__electronLog = {
    send: function () {},
    info: function () {}, warn: function () {}, error: function () {},
    handle: function () { return function () {}; },
    toIpcRenderer: function () { return null; }
  };
  window.agent = { updateActiveAgentCount: function () { return Promise.resolve(); } };
  window.ide = { isInstalled: function () { return Promise.resolve(true); } };
  window.extensions = { sendAuthorities: function () { return Promise.resolve(); } };
  window.logs = { getElectronLogs: function () { return Promise.resolve(''); } };
  // showOpenDialog deve risolvere al percorso (stringa) della cartella scelta.
  window.dialog = {
    showOpenDialog: function () {
      if (window.__pendingWorkspace) {
        var p = window.__pendingWorkspace;
        window.__pendingWorkspace = null;
        return Promise.resolve(p);
      }
      return parentRequest('open-dialog', {});
    },
    showOpenMultipleFolderDialog: function () {
      return this.showOpenDialog().then(function (p) { return p ? [p] : []; });
    }
  };
})();</script>`;
}

// Header hop-by-hop da non inoltrare mai.
const HOP_BY_HOP = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'];

// La UI carica font (icone Material Symbols, Google Sans) dagli host Google.
// Dalla webview quelle richieste possono fallire (rete dell'editor); le
// riscriviamo su questo proxy che le esegue noi server-side.
const EXTERNAL_HOST_RE = /https?:\/\/((?:[a-z0-9-]+\.)*(?:gstatic\.com|googleapis\.com))(\/[^"'\s\\)]*)?/gi;
const TEXTUAL_TYPES = /text\/html|text\/css|javascript|ecmascript/i;

function rewriteExternalHosts(str) {
  return str.replace(EXTERNAL_HOST_RE, '/__agpanel/ext/$1$2');
}

function handleExternalFetch(req, res) {
  // URL: /__agpanel/ext/<host>/<path>?<query>
  const m = /^\/__agpanel\/ext\/([^/?#]+)(\/[^#]*)?(?:\?.*)?$/.exec(req.url);
  if (!m) { res.writeHead(400); res.end(); return; }
  const host = m[1].toLowerCase();
  if (!/(^|\.)gstatic\.com$|(^|\.)googleapis\.com$/.test(host)) {
    res.writeHead(403); res.end('host non consentito'); return;
  }
  const qIndex = req.url.indexOf('?');
  const query = qIndex >= 0 ? req.url.slice(qIndex) : '';
  const upstreamPath = (m[2] || '/') + query;
  const headers = {};
  for (const k of ['accept', 'accept-language', 'range', 'origin', 'referer']) {
    if (req.headers[k]) headers[k] = req.headers[k];
  }
  headers['user-agent'] = req.headers['user-agent'] || 'Mozilla/5.0 AntigravityPanel';
  if (headers.origin && host.includes('googleapis')) headers.origin = `https://${host}`;
  headers.host = host;

  const upReq = https.request({ host, path: upstreamPath, method: req.method, headers }, (ur) => {
    // Pipe binario fedele: preserviamo content-encoding così com'è.
    const out = {};
    for (const [k, v] of Object.entries(ur.headers)) {
      if (!HOP_BY_HOP.includes(k.toLowerCase())) out[k] = v;
    }
    out['access-control-allow-origin'] = '*';
    res.writeHead(ur.statusCode, out);
    ur.pipe(res);
  });
  upReq.on('error', (e) => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
    res.end('ext fetch error: ' + e.message);
  });
  if (req.method === 'POST' || req.method === 'PUT') {
    req.pipe(upReq);
  } else {
    upReq.end();
  }
}

function createProxy(options) {
  const targetPort = options.targetPort;
  const storageFile = options.storageFile;
  const targetOrigin = `https://127.0.0.1:${targetPort}`;
  const agent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });
  const shim = buildShim();

  function readStorage() {
    try { return JSON.parse(fs.readFileSync(storageFile, 'utf8')); } catch { return null; }
  }
  function writeStorage(obj) {
    try {
      fs.mkdirSync(path.dirname(storageFile), { recursive: true });
      fs.writeFileSync(storageFile, JSON.stringify(obj, null, 2));
    } catch { /* lo storage è best-effort */ }
  }
  function ensureStorage() {
    let items = readStorage();
    if (items) return items;
    // Primo avvio: semina dallo storage dell'app, così onboarding e
    // preferenze già fatte nell'app non vengono richieste di nuovo.
    items = {};
    if (options.seedFile) {
      try { items = JSON.parse(fs.readFileSync(options.seedFile, 'utf8')) || {}; } catch { /* ok */ }
    }
    writeStorage(items);
    return items;
  }

  function upstreamHeaders(reqHeaders) {
    const headers = {};
    for (const [k, v] of Object.entries(reqHeaders)) {
      if (!HOP_BY_HOP.includes(k.toLowerCase())) headers[k.toLowerCase()] = v;
    }
    headers.host = `127.0.0.1:${targetPort}`;
    // Il server applica controlli CSRF basati su Origin: presentiamo la sua.
    if (headers.origin) headers.origin = targetOrigin;
    if (headers.referer) {
      try { headers.referer = targetOrigin + new URL(headers.referer).pathname; } catch { delete headers.referer; }
    }
    return headers;
  }

  const server = http.createServer((req, res) => {
    // Rilancio dei font/risorse Google scaricati server-side.
    if (req.url.startsWith('/__agpanel/ext/')) {
      handleExternalFetch(req, res);
      return;
    }
    // Endpoint interni dello shim.
    if (req.url.startsWith('/__agpanel/')) {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        try {
          if (req.url === '/__agpanel/storage/get') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify(ensureStorage()));
          } else if (req.url === '/__agpanel/storage/update') {
            const changes = JSON.parse(body || '{}');
            const items = ensureStorage();
            for (const [k, v] of Object.entries(changes)) {
              if (v === null) delete items[k];
              else items[k] = v;
            }
            writeStorage(items);
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end('{}');
          } else {
            res.writeHead(404);
            res.end();
          }
        } catch (e) {
          res.writeHead(500, { 'content-type': 'text/plain' });
          res.end(String(e));
        }
      });
      return;
    }

    const headers = upstreamHeaders(req.headers);
    delete headers['accept-encoding']; // risposta non compressa, così possiamo iniettare

    const upstream = https.request({
      host: '127.0.0.1',
      port: targetPort,
      path: req.url,
      method: req.method,
      headers,
      agent
    }, (ur) => {
      const outHeaders = {};
      for (const [k, v] of Object.entries(ur.headers)) {
        if (!HOP_BY_HOP.includes(k.toLowerCase())) outHeaders[k] = v;
      }
      if (outHeaders['set-cookie']) {
        outHeaders['set-cookie'] = outHeaders['set-cookie'].map((c) => c.replace(/;\s*Secure/gi, ''));
      }
      const isHtml = String(ur.headers['content-type'] || '').includes('text/html');
      const isTextual = isHtml || TEXTUAL_TYPES.test(String(ur.headers['content-type'] || ''));
      if (!isTextual) {
        // Header-only: solo charset esplicito per JSON/testo, byte intatti.
        const ct0 = String(ur.headers['content-type'] || '');
        if (ct0 && /json|text\//i.test(ct0) && !/charset=/i.test(ct0)) {
          outHeaders['content-type'] = ct0.replace(/;\s*$/, '') + '; charset=UTF-8';
        }
        res.writeHead(ur.statusCode, outHeaders);
        ur.pipe(res);
        return;
      }
      // HTML/CSS/JS della shell: bufferizziamo per riscrivere gli URL esterni
      // e (solo HTML) iniettare lo shim in testa.
      const chunks = [];
      ur.on('data', (c) => chunks.push(c));
      ur.on('end', () => {
        let buf = Buffer.concat(chunks);
        let str = buf.toString('utf8');
        str = rewriteExternalHosts(str);
        if (isHtml) {
          const at = str.search(/<head[^>]*>/i);
          if (at !== -1) {
            const end = str.indexOf('>', at) + 1;
            str = str.slice(0, end) + shim + str.slice(end);
          } else {
            str = shim + str;
          }
        }
        buf = Buffer.from(str, 'utf8');
        outHeaders['content-length'] = String(buf.length);
        // Encoding esplicito: senza charset il renderer può interpretare i
        // caratteri-icona (Material Symbols / PUA) come Windows-1252 e
        // mostrarli come mojibake (⧉, ↻...).
        const ct = String(outHeaders['content-type'] || '');
        if (ct && !/charset=/i.test(ct)) {
          outHeaders['content-type'] = ct.replace(/;\s*$/, '') + '; charset=UTF-8';
        }
        res.writeHead(ur.statusCode, outHeaders);
        res.end(buf);
      });
    });
    upstream.on('error', (e) => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
      res.end('Antigravity proxy error: ' + e.message);
    });
    req.pipe(upstream);
  });

  // Tunnel WebSocket (es. /connect-websocket): ricevuto l'upgrade dal browser,
  // apriamo una connessione TLS al language server, gli giriamo la richiesta
  // di upgrade con Host/Origin riscritti e poi incanalamo i byte in entrambe
  // le direzioni.
  server.on('upgrade', (req, clientSocket, head) => {
    const headers = upstreamHeaders(req.headers);
    // Hop-by-hop via HOP_BY_HOP già scartati; per l'upgrade servono questi:
    headers.connection = 'Upgrade';
    headers.upgrade = req.headers.upgrade || 'websocket';

    const requestLines = [`${req.method} ${req.url} HTTP/1.1`];
    for (const [k, v] of Object.entries(headers)) requestLines.push(`${k}: ${v}`);
    const requestText = requestLines.join('\r\n') + '\r\n\r\n';

    const ups = tls.connect({
      host: '127.0.0.1',
      port: targetPort,
      rejectUnauthorized: false,
      servername: '127.0.0.1'
    }, () => {
      ups.write(requestText);
      if (head && head.length) ups.write(head);
    });

    let switched = false;
    ups.on('data', (chunk) => {
      if (switched) return;
      switched = true;
      const txt = chunk.toString('latin1');
      const idx = txt.indexOf('\r\n\r\n');
      if (idx === -1 || !/^HTTP\/1\.1 101/i.test(txt)) {
        // Upstream ha rifiutato l'upgrade: inoltra la risposta e chiudi.
        clientSocket.write(chunk);
        clientSocket.destroy();
        ups.destroy();
        return;
      }
      clientSocket.write(chunk.slice(0, idx + 4));
      if (chunk.length > idx + 4) ups.unshift(chunk.slice(idx + 4));
      ups.pipe(clientSocket);
      clientSocket.pipe(ups);
    });

    const cleanup = () => {
      try { clientSocket.destroy(); } catch { /* ignora */ }
      try { ups.destroy(); } catch { /* ignora */ }
    };
    ups.on('error', cleanup);
    clientSocket.on('error', cleanup);
    clientSocket.on('close', cleanup);
    ups.on('close', cleanup);
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.on('close', () => {
      // Diagnostica: ci serve sapere se/il perché il listener muore mentre
      // l'estensione è ancora viva (refuso o shutdown anomalo dell'host).
      try { options.onClosed && options.onClosed(); } catch { /* mai bloccare */ }
    });
    server.listen(options.localPort || 0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        targetPort,
        url: `http://127.0.0.1:${server.address().port}/`,
        close: () => new Promise((r) => server.close(r))
      });
    });
  });
}

module.exports = { createProxy };

// Uso da CLI per i test: node proxy.js <portaHttpsTarget> [portaLocale]
if (require.main === module) {
  createProxy({
    targetPort: Number(process.argv[2] || 50569),
    localPort: Number(process.argv[3] || 0),
    storageFile: path.join(__dirname, 'tools', 'storage.json'),
    seedFile: path.join(process.env.APPDATA || '', 'Antigravity', 'app_storage.json')
  }).then((p) => console.log('proxy attivo: ' + p.url + ' -> https://127.0.0.1:' + p.targetPort));
}
