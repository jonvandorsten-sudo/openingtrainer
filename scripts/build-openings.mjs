// Builds public/openings.json from the Lichess chess-openings TSVs (CC0).
// Each entry: position -> [eco, name, weight]. Weight is the number of named openings at or below that position,
// a measure of how established a move is; positions that are only on the way to named openings have an empty name.
// Source: https://github.com/lichess-org/chess-openings — refresh data/lichess-openings/*.tsv and rerun:
//   node scripts/build-openings.mjs
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Chess } from 'chess.js';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');
const SOURCE = join(ROOT, 'data', 'lichess-openings');
const TARGET = join(ROOT, 'public', 'openings.json');

const book = {};
let rows = 0;
for (const file of readdirSync(SOURCE).filter((f) => f.endsWith('.tsv')).sort()) {
  const lines = readFileSync(join(SOURCE, file), 'utf8').split('\n').slice(1);
  for (const line of lines) {
    const [eco, name, pgn] = line.split('\t');
    if (!pgn) continue;
    const chess = new Chess();
    for (const token of pgn.trim().split(/\s+/)) {
      if (/^\d+\./.test(token)) continue;
      chess.move(token);
      const key = positionKey(chess.fen());
      const entry = (book[key] ??= ['', '', 0]);
      entry[2]++;
    }
    const final = book[positionKey(chess.fen())];
    final[0] = eco;
    final[1] = name;
    rows++;
  }
}

writeFileSync(TARGET, JSON.stringify(book));
const named = Object.values(book).filter((entry) => entry[1]).length;
console.log(`${rows} openings, ${named} named positions, ${Object.keys(book).length} positions in total -> ${TARGET}`);

function positionKey(fen) {
  return fen.split(' ').slice(0, 3).join(' ');
}
