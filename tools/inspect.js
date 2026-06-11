// Strumento usa-e-getta: estrae il contesto attorno alle occorrenze di un
// pattern nel bundle main.js di Antigravity per capire la modalità iframe.
const fs = require('fs');
const s = fs.readFileSync(process.env.TEMP + '\\ag_main.js', 'utf8');
const pat = process.argv[2];
const span = Number(process.argv[3] || 300);
const max = Number(process.argv[4] || 12);
let i = -1, n = 0;
while ((i = s.indexOf(pat, i + 1)) !== -1 && n < max) {
  console.log('--- @' + i + ' ---');
  console.log(s.slice(Math.max(0, i - span), i + span).replace(/\n/g, ' '));
  console.log();
  n++;
}
