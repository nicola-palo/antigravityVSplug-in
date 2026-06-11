const vscode = require('vscode');
const cp = require('child_process');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { createProxy } = require('./proxy');

let outputChannel = null;
function getOutputChannel() {
  if (!outputChannel) {
    outputChannel = vscode.window.createOutputChannel('Antigravity Debug');
  }
  return outputChannel;
}

// ---------------------------------------------------------------------------
// Rilevamento del server Antigravity
// ---------------------------------------------------------------------------
// L'app Antigravity avvia un language server (language_server.exe con
// --override_ide_name antigravity) che serve la UI dell'Agent Manager in HTTPS
// su una porta casuale, con certificato self-signed. Troviamo quella porta:
// PID del processo -> porte in LISTEN -> probe HTTPS finché una risponde con
// la pagina di Antigravity. La UI viene poi servita alla webview attraverso il
// proxy locale (vedi proxy.js) che termina il TLS e inietta i bridge nativi.

let cachedServer = null; // { httpsPort, version }
let proxyInstance = null; // { port, targetPort, url, close }
let pendingWorkspacePath = null;
let viewProvider = null;

function execShell(file, args, timeoutMs) {
  return new Promise((resolve) => {
    cp.execFile(file, args, { timeout: timeoutMs || 8000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? '' : String(stdout || ''));
    });
  });
}

async function findLanguageServerPids() {
  if (process.platform === 'win32') {
    const out = await execShell('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      "Get-CimInstance Win32_Process -Filter 'Name=''language_server.exe''' -ErrorAction SilentlyContinue | Select-Object ProcessId, CommandLine | ConvertTo-Json"
    ]);
    if (!out.trim()) return [];
    try {
      const data = JSON.parse(out);
      const list = Array.isArray(data) ? data : [data];
      return list
        .filter((p) => p && p.CommandLine && p.CommandLine.includes('override_ide_name antigravity'))
        .map((p) => p.ProcessId)
        .filter((n) => Number.isFinite(n));
    } catch {
      return [];
    }
  }
  // macOS / Linux
  const out = await execShell('/bin/sh', ['-c', "ps -axo pid=,command= | grep language_server | grep 'override_ide_name antigravity' | grep -v grep"]);
  return out.split(/\r?\n/)
    .map((l) => parseInt(l.trim().split(/\s+/)[0], 10))
    .filter((n) => Number.isFinite(n));
}

async function findListeningPorts(pids) {
  const ports = new Set();
  if (process.platform === 'win32') {
    const out = await execShell('netstat.exe', ['-ano', '-p', 'TCP']);
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(/TCP\s+(?:127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):(\d+)\s+\S+\s+LISTENING\s+(\d+)/);
      if (m && pids.includes(parseInt(m[2], 10))) ports.add(parseInt(m[1], 10));
    }
  } else {
    for (const pid of pids) {
      const out = await execShell('/bin/sh', ['-c', `lsof -nP -a -iTCP -sTCP:LISTEN -p ${pid} 2>/dev/null`]);
      for (const line of out.split(/\r?\n/)) {
        const m = line.match(/:(\d+)\s+\(LISTEN\)/);
        if (m) ports.add(parseInt(m[1], 10));
      }
    }
  }
  return [...ports];
}

// Probe in HTTPS: è la porta che serve davvero la UI (quella HTTP serve gli
// stessi asset ma non l'API gRPC, e la pagina resterebbe vuota).
function probeHttpsPort(port) {
  return new Promise((resolve) => {
    const req = https.get({ host: '127.0.0.1', port, path: '/', timeout: 1500, rejectUnauthorized: false }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; if (body.length > 65536) req.destroy(); });
      res.on('end', () => {
        if (res.statusCode === 200 && (body.includes('__APP_CONFIG__') || body.includes('Antigravity'))) {
          const vm = body.match(/"appVersion"\s*:\s*"([^"]+)"/);
          resolve({ httpsPort: port, version: vm ? vm[1] : '' });
        } else {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

async function discoverServer() {
  const cfgPort = vscode.workspace.getConfiguration('antigravityPanel').get('port') || 0;
  if (cfgPort > 0) {
    const hit = await probeHttpsPort(cfgPort);
    cachedServer = hit;
    return hit;
  }
  if (cachedServer) {
    const still = await probeHttpsPort(cachedServer.httpsPort);
    if (still) { cachedServer = still; return still; }
    cachedServer = null;
  }
  const pids = await findLanguageServerPids();
  if (!pids.length) return null;
  const ports = await findListeningPorts(pids);
  const probes = await Promise.all(ports.map(probeHttpsPort));
  const hit = probes.find(Boolean) || null;
  cachedServer = hit;
  return hit;
}

let extensionContext = null;

async function ensureProxy(targetPort) {
  if (proxyInstance && proxyInstance.targetPort === targetPort) return proxyInstance;
  if (proxyInstance) {
    await proxyInstance.close().catch(() => {});
    proxyInstance = null;
  }
  const storageDir = extensionContext.globalStorageUri.fsPath;
  proxyInstance = await createProxy({
    targetPort,
    storageFile: path.join(storageDir, 'storage.json'),
    seedFile: process.platform === 'win32'
      ? path.join(process.env.APPDATA || '', 'Antigravity', 'app_storage.json')
      : path.join(process.env.HOME || '', 'Library', 'Application Support', 'Antigravity', 'app_storage.json')
  });
  return proxyInstance;
}

// ---------------------------------------------------------------------------
// Avvio dell'app Antigravity
// ---------------------------------------------------------------------------

function findExecutable() {
  let cfg = vscode.workspace.getConfiguration('antigravityPanel').get('executablePath');
  if (cfg) {
    cfg = cfg.trim().replace(/^["']|["']$/g, '');
    if (fs.existsSync(cfg)) return cfg;
  }
  if (process.platform === 'win32') {
    const p = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Antigravity', 'Antigravity.exe');
    if (fs.existsSync(p)) return p;
  } else if (process.platform === 'darwin') {
    if (fs.existsSync('/Applications/Antigravity.app')) return '/Applications/Antigravity.app';
  }
  return null;
}

function workspaceFolder() {
  const ws = vscode.workspace.workspaceFolders;
  return ws && ws.length ? ws[0].uri.fsPath : null;
}

async function selectExecutablePath() {
  const options = {
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    openLabel: 'Seleziona Antigravity',
    filters: {}
  };

  if (process.platform === 'win32') {
    options.filters['Eseguibili (*.exe)'] = ['exe'];
  } else if (process.platform === 'darwin') {
    options.filters['Applicazioni (*.app)'] = ['app'];
  }

  const selected = await vscode.window.showOpenDialog(options);
  if (selected && selected.length) {
    const pickedPath = selected[0].fsPath;
    await vscode.workspace.getConfiguration('antigravityPanel').update('executablePath', pickedPath, vscode.ConfigurationTarget.Global);
    return pickedPath;
  }
  return null;
}

// Avvia l'eseguibile direttamente (niente script intermedi): lo spawn diretto
// del .exe è l'unico metodo che parte in modo affidabile dall'extension host —
// passare per `powershell -File launch.ps1` con stdio ignorato e processo
// detached NON avvia l'app (verificato). Su macOS si usa `open -a`.
// Restituisce una Promise che rifiuta se lo spawn fallisce subito (es. ENOENT).
function spawnExe(exe, folder) {
  return new Promise((resolve, reject) => {
    let child;
    if (process.platform === 'darwin') {
      const args = ['-a', exe];
      if (folder) args.push(folder);
      child = cp.spawn('open', args, { detached: true, stdio: 'ignore' });
    } else {
      const args = folder ? [folder] : [];
      child = cp.spawn(exe, args, { detached: true, stdio: 'ignore', cwd: path.dirname(exe) });
    }
    let settled = false;
    child.on('error', (e) => { if (!settled) { settled = true; reject(e); } });
    // Se entro 200 ms non è arrivato un errore (ENOENT/EACCES), consideriamo
    // lo spawn riuscito e stacchiamo il figlio dal processo dell'editor.
    setTimeout(() => {
      if (!settled) {
        settled = true;
        child.unref();
        resolve(true);
      }
    }, 200);
  });
}

async function launchApp(withFolder) {
  let exe = findExecutable();
  if (!exe) {
    const pick = await vscode.window.showErrorMessage(
      'Antigravity non trovato. Vuoi selezionare il percorso dell\'eseguibile?',
      'Seleziona file...',
      'Annulla'
    );
    if (pick === 'Seleziona file...') {
      exe = await selectExecutablePath();
      if (!exe) return false;
    } else {
      return false;
    }
  }

  const folder = withFolder ? workspaceFolder() : null;
  try {
    await spawnExe(exe, folder);
    return true;
  } catch (e) {
    const pick = await vscode.window.showErrorMessage(
      'Impossibile avviare Antigravity: ' + e.message + '. Il percorso configurato potrebbe essere errato. Vuoi selezionarne un altro?',
      'Seleziona file...',
      'Annulla'
    );
    if (pick === 'Seleziona file...') {
      const newExe = await selectExecutablePath();
      if (newExe) {
        try {
          await spawnExe(newExe, folder);
          return true;
        } catch (err2) {
          vscode.window.showErrorMessage('Impossibile avviare Antigravity anche con il nuovo percorso: ' + err2.message);
          return false;
        }
      }
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// Webview (sidebar e scheda editor)
// ---------------------------------------------------------------------------

function getNonce() {
  return [...Array(24)].map(() => 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[Math.floor(Math.random() * 62)]).join('');
}

function webviewHtml(opts) {
  const nonce = getNonce();
  const inTab = !!(opts && opts.inTab);
  const csp = [
    "default-src 'none'",
    'frame-src http://127.0.0.1:* http://localhost:*',
    "style-src 'unsafe-inline'",
    `script-src 'nonce-${nonce}'`,
    "img-src data:",
    "font-src data:"
  ].join('; ');
  return `<!DOCTYPE html>
<html lang="it">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
  :root {
    --ag-bg: #131314;
    --ag-surface: #1e1f20;
    --ag-border: #2d2f31;
    --ag-text: #e3e3e3;
    --ag-text-dim: #9aa0a6;
    --ag-blue: #8ab4f8;
    --ag-accent: #a8c7fa;
    --ag-green: #6dd58c;
    --ag-red: #f28b82;
  }
  html, body { height: 100%; margin: 0; padding: 0; background: var(--ag-bg); overflow: hidden; }
  body { font-family: 'Google Sans', 'Segoe UI', system-ui, sans-serif; color: var(--ag-text); display: flex; flex-direction: column; }
  #bar {
    height: 34px; flex: 0 0 34px; display: flex; align-items: center; gap: 8px;
    padding: 0 10px; background: var(--ag-surface); border-bottom: 1px solid var(--ag-border);
    user-select: none;
  }
  #bar .logo { width: 16px; height: 16px; flex: 0 0 16px; }
  #bar .title { font-size: 12px; font-weight: 600; letter-spacing: .2px; }
  #bar .ver { font-size: 10px; color: var(--ag-text-dim); }
  #bar .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--ag-red); transition: background .3s; }
  #bar .dot.on { background: var(--ag-green); }
  #bar .spacer { flex: 1; }
  .btn {
    background: transparent; color: var(--ag-text-dim); border: 1px solid transparent;
    border-radius: 6px; padding: 3px 8px; font-size: 11px; cursor: pointer;
    font-family: inherit; white-space: nowrap;
  }
  .btn:hover { background: rgba(138,180,248,.12); color: var(--ag-accent); }
  .btn.primary {
    background: var(--ag-blue); color: #062e6f; font-weight: 600;
    border-radius: 100px; padding: 8px 20px; font-size: 13px;
  }
  .btn.primary:hover { background: var(--ag-accent); color: #062e6f; }
  #frame { flex: 1; border: none; width: 100%; display: none; background: var(--ag-bg); }
  #landing { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px; padding: 24px; text-align: center; }
  #landing .biglogo { width: 64px; height: 64px; opacity: .95; }
  #landing h1 { font-size: 20px; font-weight: 500; margin: 0; }
  #landing p { font-size: 12.5px; color: var(--ag-text-dim); margin: 0; max-width: 340px; line-height: 1.5; }
  #landing .row { display: flex; gap: 10px; margin-top: 8px; flex-wrap: wrap; justify-content: center; }
  .spin {
    width: 18px; height: 18px; border: 2px solid var(--ag-border); border-top-color: var(--ag-blue);
    border-radius: 50%; animation: r 1s linear infinite; display: none;
  }
  @keyframes r { to { transform: rotate(360deg); } }
</style>
</head>
<body>
  <div id="bar">
    <svg class="logo" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <ellipse cx="12" cy="14" rx="9" ry="4.5" stroke="#8ab4f8" stroke-width="1.6"/>
      <path d="M12 16.5V4.5" stroke="#e3e3e3" stroke-width="1.8" stroke-linecap="round"/>
      <path d="M8.5 8L12 4.5L15.5 8" stroke="#e3e3e3" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
      <circle cx="20.2" cy="11.2" r="1.3" fill="#a8c7fa"/>
    </svg>
    <span class="title">Antigravity</span>
    <span class="ver" id="ver"></span>
    <span class="dot" id="dot"></span>
    <span class="spacer"></span>
    <div class="spin" id="spin"></div>
    <button class="btn" id="bProject" title="Apri la cartella del progetto corrente nell'app Antigravity">Apri progetto</button>
    ${inTab ? '' : '<button class="btn" id="bTab" title="Apri in una scheda editor (più spazio)">⧉</button>'}
    <button class="btn" id="bReload" title="Ricarica">↻</button>
  </div>
  <iframe id="frame" allow="clipboard-read; clipboard-write; microphone"></iframe>
  <div id="landing">
    <svg class="biglogo" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <ellipse cx="12" cy="14" rx="9" ry="4.5" stroke="#8ab4f8" stroke-width="1.2"/>
      <path d="M12 16.5V4.5" stroke="#e3e3e3" stroke-width="1.4" stroke-linecap="round"/>
      <path d="M8.5 8L12 4.5L15.5 8" stroke="#e3e3e3" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
      <circle cx="20.2" cy="11.2" r="1.1" fill="#a8c7fa"/>
    </svg>
    <h1>Antigravity</h1>
    <p id="msg">Ricerca dell'app Antigravity in corso…</p>
    <div class="row" id="actions" style="display:none">
      <button class="btn primary" id="bLaunch">Avvia Antigravity</button>
      <button class="btn" id="bConfigure" style="border:1px solid var(--ag-border); border-radius:100px; padding:8px 20px; font-size:13px;">Seleziona percorso...</button>
      <button class="btn" id="bRetry" style="border:1px solid var(--ag-border); border-radius:100px; padding:8px 20px; font-size:13px;">Riprova</button>
    </div>
  </div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  function send(msg) { vscode.postMessage(msg); }

  $('bProject').addEventListener('click', () => send({ type: 'openProject' }));
  $('bReload').addEventListener('click', () => { send({ type: 'retry' }); const f = $('frame'); if (f.src) f.src = f.src; });
  const bTab = $('bTab'); if (bTab) bTab.addEventListener('click', () => send({ type: 'openTab' }));
  $('bLaunch').addEventListener('click', () => { send({ type: 'launch' }); setSearching('Avvio di Antigravity…'); });
  $('bConfigure').addEventListener('click', () => { send({ type: 'configurePath' }); });
  $('bRetry').addEventListener('click', () => { send({ type: 'retry' }); setSearching('Nuova ricerca…'); });

  function setSearching(text) {
    $('landing').style.display = 'flex';
    $('frame').style.display = 'none';
    $('actions').style.display = 'none';
    $('spin').style.display = 'block';
    $('dot').classList.remove('on');
    $('msg').textContent = text || 'Ricerca dell\\'app Antigravity in corso…';
  }
  function setNotFound() {
    $('landing').style.display = 'flex';
    $('frame').style.display = 'none';
    $('actions').style.display = 'flex';
    $('spin').style.display = 'none';
    $('dot').classList.remove('on');
    $('msg').textContent = 'Antigravity non è in esecuzione. Avvialo per usare l\\'Agent Manager qui dentro: stessa app, stessi account, stesse conversazioni.';
  }
  function setConnected(url, version) {
    const f = $('frame');
    if (f.src !== url) f.src = url;
    f.style.display = 'block';
    $('landing').style.display = 'none';
    $('spin').style.display = 'none';
    $('dot').classList.add('on');
    $('ver').textContent = version ? 'v' + version : '';
  }

  window.addEventListener('message', (e) => {
    const m = e.data || {};
    // Messaggi dallo shim dentro l'iframe di Antigravity: inoltrali all'estensione.
    if (m.__agpanel) {
      if (m.type === 'open-external') send({ type: 'openExternal', url: m.url });
      else if (m.type === 'open-dialog') send({ type: 'openDialog', id: m.id });
      else if (m.type === 'console-log') send({ type: 'consoleLog', message: m.message });
      return;
    }
    // Messaggi dall'estensione.
    if (m.type === 'state') {
      if (m.state === 'searching') setSearching(m.text);
      else if (m.state === 'connected') setConnected(m.url, m.version);
      else setNotFound();
    } else if (m.type === 'dialogResult') {
      const f = $('frame');
      if (f.contentWindow) f.contentWindow.postMessage({ __agpanel: true, type: 'response', id: m.id, result: m.result }, '*');
    } else if (m.type === 'openWorkspace') {
      const f = $('frame');
      if (f.contentWindow) f.contentWindow.postMessage({ __agpanel: true, type: 'openWorkspace', path: m.path }, '*');
    }
  });

  $('frame').addEventListener('load', () => {
    send({ type: 'iframeLoaded' });
  });

  send({ type: 'ready' });
</script>
</body>
</html>`;
}

// Gestione comune dei messaggi della webview + ciclo di connessione
function wireWebview(webview, context) {
  let disposed = false;
  let pollTimer = null;

  function post(msg) { if (!disposed) webview.postMessage(msg); }

  async function connect(silent) {
    if (!silent) post({ type: 'state', state: 'searching' });
    try {
      const server = await discoverServer();
      if (disposed) return;
      if (server) {
        const proxy = await ensureProxy(server.httpsPort);
        post({ type: 'state', state: 'connected', url: proxy.url, version: server.version });
      } else {
        const auto = vscode.workspace.getConfiguration('antigravityPanel').get('autoLaunch');
        if (auto && findExecutable()) {
          await launchApp(true);
          waitForServer();
        } else {
          post({ type: 'state', state: 'notfound' });
        }
      }
    } catch (e) {
      post({ type: 'state', state: 'notfound' });
      vscode.window.showErrorMessage('Antigravity Panel: ' + e.message);
    }
  }

  // Dopo l'avvio dell'app il server impiega qualche secondo: polling fino a 90 s.
  function waitForServer() {
    post({ type: 'state', state: 'searching', text: 'Avvio di Antigravity, attendo il server…' });
    const start = Date.now();
    clearInterval(pollTimer);
    pollTimer = setInterval(async () => {
      const server = await discoverServer();
      if (disposed) { clearInterval(pollTimer); return; }
      if (server) {
        clearInterval(pollTimer);
        try {
          const proxy = await ensureProxy(server.httpsPort);
          post({ type: 'state', state: 'connected', url: proxy.url, version: server.version });
        } catch {
          post({ type: 'state', state: 'notfound' });
        }
      } else if (Date.now() - start > 90000) {
        clearInterval(pollTimer);
        post({ type: 'state', state: 'notfound' });
      }
    }, 2500);
  }

  webview.onDidReceiveMessage(async (m) => {
    switch (m && m.type) {
      case 'ready':
      case 'retry':
        connect();
        if (pendingWorkspacePath) {
          webview.postMessage({ type: 'openWorkspace', path: pendingWorkspacePath });
          pendingWorkspacePath = null;
        }
        break;
      case 'iframeLoaded': {
        const folder = workspaceFolder();
        if (folder) {
          post({ type: 'openWorkspace', path: folder });
        }
        break;
      }
      case 'launch':
        if (await launchApp(true)) waitForServer();
        else post({ type: 'state', state: 'notfound' });
        break;
      case 'configurePath':
        vscode.commands.executeCommand('antigravityPanel.configurePath');
        break;
      case 'openProject':
        vscode.commands.executeCommand('antigravityPanel.openProject');
        break;
      case 'consoleLog':
        getOutputChannel().appendLine(m.message);
        break;
      case 'openTab':
        vscode.commands.executeCommand('antigravityPanel.openTab');
        break;
      case 'openExternal':
        if (m.url && /^(https?|antigravity[\w-]*):/i.test(m.url)) {
          vscode.env.openExternal(vscode.Uri.parse(m.url));
        }
        break;
      case 'openDialog': {
        const picked = await vscode.window.showOpenDialog({
          canSelectFolders: true,
          canSelectFiles: false,
          canSelectMany: false,
          openLabel: 'Apri cartella in Antigravity'
        });
        post({ type: 'dialogResult', id: m.id, result: picked && picked.length ? picked[0].fsPath : undefined });
        break;
      }
    }
  }, null, context.subscriptions);

  return {
    reconnect: () => connect(),
    dispose: () => { disposed = true; clearInterval(pollTimer); }
  };
}

class AntigravityViewProvider {
  constructor(context) {
    this.context = context;
    this.wire = null;
    this.view = null;
  }
  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = webviewHtml({ inTab: false });
    this.wire = wireWebview(view.webview, this.context);
    view.onDidDispose(() => {
      if (this.wire) this.wire.dispose();
      this.view = null;
    });
  }
}

let tabPanel = null;

function sendOpenWorkspace(folder) {
  let sent = false;
  if (tabPanel) {
    tabPanel.webview.postMessage({ type: 'openWorkspace', path: folder });
    sent = true;
  }
  if (viewProvider && viewProvider.view) {
    viewProvider.view.webview.postMessage({ type: 'openWorkspace', path: folder });
    sent = true;
  }
  return sent;
}

function openTab(context) {
  if (tabPanel) { tabPanel.reveal(); return; }
  tabPanel = vscode.window.createWebviewPanel(
    'antigravityPanel.tab', 'Antigravity', vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true }
  );
  tabPanel.webview.html = webviewHtml({ inTab: true });
  const wire = wireWebview(tabPanel.webview, context);
  tabPanel.onDidDispose(() => { wire.dispose(); tabPanel = null; });
}

// ---------------------------------------------------------------------------
// Attivazione
// ---------------------------------------------------------------------------

function activate(context) {
  extensionContext = context;
  viewProvider = new AntigravityViewProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('antigravityPanel.view', viewProvider, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('antigravityPanel.openTab', () => openTab(context)),

    vscode.commands.registerCommand('antigravityPanel.openProject', async () => {
      const folder = workspaceFolder();
      if (!folder) {
        vscode.window.showWarningMessage('Nessuna cartella aperta in questa finestra.');
        return;
      }
      pendingWorkspacePath = folder;
      sendOpenWorkspace(folder);
      if (await launchApp(true)) {
        vscode.window.setStatusBarMessage('$(rocket) Progetto inviato ad Antigravity: ' + folder, 5000);
      }
    }),

    vscode.commands.registerCommand('antigravityPanel.launchApp', async () => {
      await launchApp(false);
    }),

    vscode.commands.registerCommand('antigravityPanel.configurePath', async () => {
      const currentPath = vscode.workspace.getConfiguration('antigravityPanel').get('executablePath') || 'Non configurato';
      const pick = await vscode.window.showInformationMessage(
        `Percorso attuale: ${currentPath}\nVuoi selezionare un nuovo percorso per l'eseguibile di Antigravity?`,
        'Seleziona file...',
        'Annulla'
      );
      if (pick === 'Seleziona file...') {
        const newPath = await selectExecutablePath();
        if (newPath) {
          vscode.window.showInformationMessage(`Percorso di Antigravity aggiornato: ${newPath}`);
        }
      }
    }),

    vscode.commands.registerCommand('antigravityPanel.reconnect', () => {
      cachedServer = null;
      if (viewProvider && viewProvider.wire) viewProvider.wire.reconnect();
    })
  );

  // Voce nella status bar: stato della connessione, clic per aprire la scheda.
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
  status.command = 'antigravityPanel.openTab';
  status.text = '$(rocket) Antigravity';
  status.tooltip = 'Apri l\'Agent Manager di Antigravity';
  status.show();
  context.subscriptions.push(status);

  async function refreshStatus() {
    const server = await discoverServer();
    status.text = server ? '$(rocket) Antigravity ✓' : '$(rocket) Antigravity ○';
    status.tooltip = server
      ? 'Antigravity connesso (porta ' + server.httpsPort + ') — clicca per aprire l\'Agent Manager'
      : 'Antigravity non in esecuzione — clicca per aprire il pannello';
  }
  refreshStatus();
  const statusTimer = setInterval(refreshStatus, 30000);
  context.subscriptions.push({ dispose: () => clearInterval(statusTimer) });
}

function deactivate() {
  if (proxyInstance) {
    proxyInstance.close().catch(() => {});
    proxyInstance = null;
  }
}

module.exports = { activate, deactivate };
