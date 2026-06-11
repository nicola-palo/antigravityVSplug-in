// Confronta i metodi di lancio. Uso: node test-launch2.js <metodo>
//   direct   = cp.spawn(exe) diretto
//   psbypass = powershell -ExecutionPolicy Bypass -File launch.ps1
//   psplain  = powershell -File launch.ps1 (senza Bypass)
const cp = require('child_process');
const path = require('path');

const exe = 'c:\\Users\\nicola.palo\\AppData\\Local\\Programs\\Antigravity\\Antigravity.exe';
const exeDir = path.dirname(exe);
const scriptPath = path.join(__dirname, '..', 'launch.ps1');
const method = process.argv[2] || 'direct';

let child;
if (method === 'direct') {
  child = cp.spawn(exe, [], { detached: true, stdio: 'ignore', cwd: exeDir });
} else if (method === 'psbypass') {
  child = cp.spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, exe, exeDir, ''], { detached: true, stdio: 'ignore' });
} else if (method === 'psplain') {
  child = cp.spawn('powershell.exe', ['-NoProfile', '-File', scriptPath, exe, exeDir, ''], { detached: true, stdio: 'ignore' });
}
child.on('error', (e) => console.log(method + ' SPAWN ERROR:', e.message));
child.unref();
console.log(method + ' spawn pid =', child.pid);
setTimeout(() => process.exit(0), 1500);
