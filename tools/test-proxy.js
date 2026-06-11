// Proxy di prova: espone in HTTP semplice la UI di Antigravity servita in
// HTTPS con certificato self-signed. Uso: node test-proxy.js <portaHttps> <portaLocale>
const http = require('http');
const https = require('https');

const TARGET_PORT = Number(process.argv[2] || 50569);
const LOCAL_PORT = Number(process.argv[3] || 8123);
const TARGET_ORIGIN = `https://127.0.0.1:${TARGET_PORT}`;

const agent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });

const server = http.createServer((req, res) => {
  const headers = { ...req.headers };
  headers.host = `127.0.0.1:${TARGET_PORT}`;
  if (headers.origin) headers.origin = TARGET_ORIGIN;
  if (headers.referer) headers.referer = TARGET_ORIGIN + new URL(headers.referer).pathname;
  delete headers['accept-encoding']; // evita ri-compressioni strane

  const upstream = https.request({
    host: '127.0.0.1',
    port: TARGET_PORT,
    path: req.url,
    method: req.method,
    headers,
    agent
  }, (ur) => {
    const outHeaders = { ...ur.headers };
    // I cookie "Secure" non verrebbero accettati su http: tolgo l'attributo.
    if (outHeaders['set-cookie']) {
      outHeaders['set-cookie'] = outHeaders['set-cookie'].map((c) => c.replace(/;\s*Secure/gi, ''));
    }
    res.writeHead(ur.statusCode, outHeaders);
    ur.pipe(res);
  });
  upstream.on('error', (e) => {
    res.writeHead(502, { 'content-type': 'text/plain' });
    res.end('proxy error: ' + e.message);
  });
  req.pipe(upstream);
});

server.listen(LOCAL_PORT, '127.0.0.1', () => {
  console.log(`proxy attivo: http://127.0.0.1:${LOCAL_PORT}/ -> ${TARGET_ORIGIN}`);
});
