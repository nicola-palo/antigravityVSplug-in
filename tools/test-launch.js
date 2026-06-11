// Replica esatta dello spawn usato da extension.js per capire se il
// meccanismo di lancio (powershell -File launch.ps1) funziona da Node.
const cp = require('child_process');
const path = require('path');

const exe = path.join(process.env.LOCALAPPDATA || 'C:\\Users\\default\\AppData\\Local', 'Programs', 'Antigravity', 'Antigravity.exe');
const exeDir = path.dirname(exe);
const scriptPath = path.join(__dirname, '..', 'launch.ps1');
const folder = '';

console.log('scriptPath =', scriptPath);
const child = cp.spawn('powershell.exe', [
  '-NoProfile',
  '-ExecutionPolicy', 'Bypass',
  '-File', scriptPath,
  exe,
  exeDir,
  folder
], { detached: true, stdio: 'ignore' });
child.on('error', (e) => console.log('SPAWN ERROR:', e.message));
child.unref();
console.log('spawn avviato, pid =', child.pid);
setTimeout(() => process.exit(0), 1500);
