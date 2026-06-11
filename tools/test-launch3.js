// Testa la nuova funzione spawnExe importandola indirettamente: ne replica
// il corpo per validare lancio semplice e lancio con cartella.
const cp = require('child_process');
const path = require('path');

const exe = path.join(process.env.LOCALAPPDATA || 'C:\\Users\\default\\AppData\\Local', 'Programs', 'Antigravity', 'Antigravity.exe');
const folder = process.argv[3] || null;

function spawnExe(exe, folder) {
  return new Promise((resolve, reject) => {
    const args = folder ? [folder] : [];
    const child = cp.spawn(exe, args, { detached: true, stdio: 'ignore', cwd: path.dirname(exe) });
    let settled = false;
    child.on('error', (e) => { if (!settled) { settled = true; reject(e); } });
    setTimeout(() => { if (!settled) { settled = true; child.unref(); resolve(true); } }, 200);
  });
}

spawnExe(exe, folder)
  .then(() => { console.log('spawnExe OK (folder=' + folder + ')'); setTimeout(() => process.exit(0), 500); })
  .catch((e) => { console.log('spawnExe ERRORE:', e.message); process.exit(1); });
