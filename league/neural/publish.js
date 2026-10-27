// Copies the neural season results into the site.
const fs = require('fs'); const path = require('path');
const DOCS = path.join(process.argv[2] || '/home/claude/professor-skieth', 'docs');
const SRC = path.join(__dirname, '..', 'output', 'neural-season');
fs.mkdirSync(path.join(DOCS, 'neural'), {recursive: true});
fs.copyFileSync(path.join(SRC, 'neural.json'), path.join(DOCS, 'data', 'neural.json'));
fs.copyFileSync(path.join(SRC, 'games.json.gz'), path.join(DOCS, 'neural', 'games.json.gz'));
console.log('neural season published');
