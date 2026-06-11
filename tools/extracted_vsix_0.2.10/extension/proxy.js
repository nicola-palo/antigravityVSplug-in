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

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

function buildShim() {
  return `<script>(function () {
  if (window.nativeStorage) return; // dentro l'app Electron vera: non serve nulla

  function rpc(p, body) {
    return fetch('/__agpanel/' + p, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {})
    }).then(function (r) { return r.json(); });
  }

  // Canale richiesta/risposta con la webview che ci incornicia.
  var reqId = 0, pending = {};
  function post(type, data) {
    try {
      if (window.parent !== window) {
        var m = { __agpanel: true, type: type };
        for (var k in data) m[k] = data[k];
        window.parent.postMessage(m, '*');
      }
    } catch (e) { /* niente parent: ambiente di test */ }
  }
  function log(msg) {
    post('console-log', { message: msg });
  }
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
    applyUpdate: function () { return Promise.resolve(); },
    quitAndInstall: function () { return Promise.resolve(); },
    checkForUpdates: function () { return Promise.resolve(); }
  };
  window.deepLink = {
    onDeepLink: function () { return function () {}; },
    getStoredDeepLink: function () { return Promise.resolve(null); }
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
    }
  };
})();</script>`;
}

// Header hop-by-hop da non inoltrare mai.
const HOP_BY_HOP = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'];

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

  const server = http.createServer((req, res) => {
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

    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (!HOP_BY_HOP.includes(k.toLowerCase())) headers[k] = v;
    }
    headers.host = `127.0.0.1:${targetPort}`;
    // Il server applica controlli CSRF basati su Origin: presentiamo la sua.
    if (headers.origin) headers.origin = targetOrigin;
    if (headers.referer) {
      try { headers.referer = targetOrigin + new URL(headers.referer).pathname; } catch { delete headers.referer; }
    }
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
      if (!isHtml) {
        res.writeHead(ur.statusCode, outHeaders);
        ur.pipe(res);
        return;
      }
      // HTML (la shell della SPA, ~2 KB): bufferizza e inietta lo shim in testa.
      const chunks = [];
      ur.on('data', (c) => chunks.push(c));
      ur.on('end', () => {
        let html = Buffer.concat(chunks).toString('utf8');
        const at = html.search(/<head[^>]*>/i);
        if (at !== -1) {
          const end = html.indexOf('>', at) + 1;
          html = html.slice(0, end) + shim + html.slice(end);
        } else {
          html = shim + html;
        }
        const buf = Buffer.from(html, 'utf8');
        outHeaders['content-length'] = String(buf.length);
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

  return new Promise((resolve, reject) => {
    server.on('error', reject);
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
