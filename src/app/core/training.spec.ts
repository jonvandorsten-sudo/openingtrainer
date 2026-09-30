import { Chess, DEFAULT_POSITION } from 'chess.js';
import { groupRepertoires, matchExisting, regroup, splitPgnGames } from './bulk-import';
import { ImportedGame, buildGameTree, filterGames, indexGame, mergeGames, movesAt, movetextToSans, parseProfile, positionHash } from './game-tree';
import { LineAttempt } from './line-attempt';
import { generatePrep, lineLikelihood } from './prep-generator';
import { extractLines, representativeLine, TrainingLine } from './lines';
import { writePgn } from './pgn-writer';
import { DAY_MS, knownPrefixStart, lineMastery, mergeMoveRecords, moveStreak, nextInterval, nextLineRecord, nextMoveRecord } from './progress';
import { QueueSource, TrainingQueue, WeightedQueue, buildQueue, drillItem, lineItem, lineWeights, randomQueue, weakMoves } from './queue';
import { linesFrom, nextMoves } from './free-start';
import { inScope, scopeFromSettings } from './scope';
import { rowRelation, treeRows, visibleTreeRows } from './tree-rows';
import { OpeningBook, positionKey } from './openings';
import { evalAt, evaluationAt, extendTree, findNode, formatMoves, knownDepth, mainContinuation, nodeAt, parseRepertoire, promoteNode, removeNode, startRoot, withoutRepetition } from './repertoire';
import { parseInfoLine } from './uci';
import { AttemptEvent, currentStreak, dayKey, longestStreak } from './stats';
import { CARO_KANN_WHITE_PGN, SICILIAN_BLACK_PGN } from './testing/fixtures';
import { BOARD_THEMES, boardImage, highlightOverlay } from './board-theme';

const sicilian = parseRepertoire(SICILIAN_BLACK_PGN);
const blackLines = extractLines(sicilian, 'black');
const NOW = new Date('2026-09-25T12:00:00').getTime();

function lineStartingWith(lines: TrainingLine[], prefix: string): TrainingLine {
  const line = lines.find((l) => formatMoves(l.moves).startsWith(prefix));
  if (!line) {
    throw new Error(`No line starts with ${prefix}`);
  }
  return line;
}

function playUntil(attempt: LineAttempt, stop: (attempt: LineAttempt) => boolean): void {
  while (!attempt.isComplete && !stop(attempt)) {
    if (attempt.isPlayerTurn) {
      expect(attempt.tryPlayerMove(attempt.expected!)?.verdict).toBe('correct');
    } else {
      expect(attempt.playOpponentMove()).not.toBeNull();
    }
  }
}

function event(day: string, overrides: Partial<AttemptEvent> = {}): AttemptEvent {
  return { repertoireId: 'r', lineKey: 'l', at: new Date(`${day}T12:00:00`).getTime(), day, flawless: true, moves: 5, missed: 0, hints: 0, durationMs: 1000, ...overrides };
}

describe('parseRepertoire', () => {
  it('reads every move of an exported repertoire including nested variations', () => {
    expect(sicilian.errors).toEqual([]);
    expect(sicilian.suggestedSide).toBe('black');

    const root = sicilian.roots[0];
    expect(root.children.map((c) => c.san)).toEqual(['e4']);
    const afterC5 = root.children[0].children[0];
    expect(afterC5.children.map((c) => c.san)).toEqual(['f4', 'f3', 'Nc3']);
  });

  it('keeps comments on the move they belong to', () => {
    const caro = parseRepertoire(CARO_KANN_WHITE_PGN);
    const bc4 = extractLines(caro, 'white')
      .flatMap((l) => l.moves)
      .find((m) => m.san === 'Bc4');
    expect(bc4?.comment).toBe('Covers f7 before Black can take there.');
  });

  it('reads centipawn "cp,depth" and standard pawn evaluations', () => {
    const repertoire = parseRepertoire('1.e4 {[%eval 20,53]} e5 { [%eval -0.35] } 2.Nf3 *');
    const e4 = repertoire.roots[0].children[0];
    expect(e4.eval).toBe(0.2);
    expect(e4.children[0].eval).toBe(-0.35);
    expect(evalAt(e4.children[0].children[0])).toBe(-0.35);
    expect(evaluationAt(e4)).toEqual({ value: 0.2, depth: 53, source: 'pgn' });
  });

  it('drops the reflowed second copy some exports add to every comment', () => {
    const first = 'In this line White keeps the centre closed and plays for a slow kingside attack.';
    const second = 'In this line White keeps the centre closed\nand plays for a slow kingside\nattack.';
    expect(withoutRepetition(`${first} ${second}`)).toBe(first);
    expect(withoutRepetition(first)).toBe(first);
  });

  it('merges identical moves from multiple games into one tree', () => {
    const repertoire = parseRepertoire('1.e4 e5 2.Nf3 *\n\n1.e4 e5 2.Bc4 *');
    expect(repertoire.gameCount).toBe(2);
    const e5 = repertoire.roots[0].children[0].children[0];
    expect(e5.children.map((c) => c.san)).toEqual(['Nf3', 'Bc4']);
  });

  it('reports illegal moves instead of silently dropping the rest of the file', () => {
    const repertoire = parseRepertoire('1.e4 e5 2.Ke3 Nc6 *');
    expect(repertoire.errors).toEqual(['1.e4 e5: Ke3']);
  });
});

describe('extractLines', () => {
  it('produces each branch as its own line, ending on a move of the trained side', () => {
    expect(blackLines.length).toBe(47);
    for (const line of blackLines) {
      expect(line.moves[line.moves.length - 1].color).toBe('b');
    }
    expect(new Set(blackLines.map((l) => l.key)).size).toBe(blackLines.length);
  });

  it('drops branches where the repertoire gives no answer for the trained side', () => {
    expect(blackLines.some((l) => formatMoves(l.moves) === '1.e4 c5')).toBe(false);
  });

  it('follows deeply nested variations to their end', () => {
    const prefix = '1.e4 c5 2.Nc3 Nc6 3.g3 Rb8 4.Bg2 b5 5.d3 g6 6.Be3 Bg7 7.Bxc5 Qa5 8.Be3 b4 9.Nce2 Bxb2 10.Rb1 b3+ 11.Bd2 bxc2 12.Qxc2 Nb4 13.Qb3 Qa3';
    const formatted = blackLines.map((l) => formatMoves(l.moves));
    expect(formatted).toContain(`${prefix} 14.Rxb2 Qxb2 15.Qxb2 Nxd3+`);
    expect(formatted).toContain(`${prefix} 14.Nf4 Qxb3 15.axb3 Bg7`);
  });

  it('groups lines by the first real branching move and names them by their last one', () => {
    expect(new Set(blackLines.map((l) => l.group))).toEqual(new Set(['3.g3', '3.f4', '3.Bb5']));
    const line = lineStartingWith(blackLines, '1.e4 c5 2.Nc3 Nc6 3.Bb5 Nd4 4.Bc4 e6 5.Nf3 Nf6 6.e5');
    expect(line.name).toBe('3.Bb5 · 6.e5');
  });

  it('names lines after the most specific opening in the book and groups them by family', () => {
    const book: OpeningBook = {
      [positionKey(sicilian.roots[0].children[0].children[0].fen)]: ['B20', 'Sicilian Defense'],
      [positionKey(findNode(sicilian, 'e4 c5 Nc3 Nc6 g3')!.fen)]: ['B24', 'Sicilian Defense: Closed, Fianchetto Variation'],
    };
    const named = extractLines(sicilian, 'black', 0, book);
    const closed = named.find((l) => formatMoves(l.moves).startsWith('1.e4 c5 2.Nc3 Nc6 3.g3 Rb8 4.Bg2 b5 5.f4 g6 6.Nf3 Bg7 7.d3 e6 8.O-O'))!;
    expect(closed.eco).toBe('B24');
    expect(closed.group).toBe('Sicilian Defense: Closed');
    expect(closed.name).toBe('Sicilian Defense: Closed, Fianchetto Variation · 13.gxf5');
    const grandPrix = named.find((l) => l.moves[4].san === 'f4')!;
    expect(grandPrix.eco).toBe('B20');
  });

  it('cuts lines at the configured number of moves and merges the resulting duplicates', () => {
    const short = extractLines(sicilian, 'black', 3);
    expect(short.map((l) => formatMoves(l.moves)).sort()).toEqual([
      '1.e4 c5 2.Nc3 Nc6 3.Bb5 Nd4',
      '1.e4 c5 2.Nc3 Nc6 3.f4 g6',
      '1.e4 c5 2.Nc3 Nc6 3.g3 Rb8',
    ]);
  });

  it('trains white lines starting with the first move', () => {
    const lines = extractLines(parseRepertoire(CARO_KANN_WHITE_PGN), 'white');
    expect(lines.length).toBe(2);
    expect(lines.every((l) => l.moves[0].san === 'e4')).toBe(true);
  });
});

describe('LineAttempt', () => {
  it('lets the opponent move first when training black', () => {
    const attempt = new LineAttempt(blackLines[0], 'b');
    expect(attempt.isPlayerTurn).toBe(false);
    expect(attempt.playOpponentMove()?.san).toBe('e4');
    expect(attempt.isPlayerTurn).toBe(true);
    expect(attempt.playOpponentMove()).toBeNull();
  });

  it('completes a line when every expected move is played', () => {
    const attempt = new LineAttempt(blackLines[5], 'b');
    playUntil(attempt, () => false);
    expect(attempt.wasFlawless).toBe(true);
    expect(attempt.correct).toBe(blackLines[5].moves.filter((m) => m.color === 'b').length);
  });

  it('rejects a wrong move, counts the mistake and reports the move as missed once found', () => {
    const attempt = new LineAttempt(lineStartingWith(blackLines, '1.e4 c5'), 'b');
    attempt.playOpponentMove();
    expect(attempt.tryPlayerMove({ from: 'e7', to: 'e5' })?.verdict).toBe('wrong');
    expect(attempt.playedMoves.length).toBe(1);
    const found = attempt.tryPlayerMove({ from: 'c7', to: 'c5' });
    expect(found).toMatchObject({ verdict: 'correct', missed: true });
    expect(attempt.mistakes).toBe(1);
  });

  it('recognises another repertoire move as an alternative, not a mistake', () => {
    const line = lineStartingWith(blackLines, '1.e4 c5 2.Nc3 Nc6 3.g3 Rb8 4.Bg2 b5 5.f4 g6 6.Nf3 Bg7 7.d3 b4');
    const attempt = new LineAttempt(line, 'b');
    playUntil(attempt, (a) => a.expected?.san === 'b4');
    expect(attempt.tryPlayerMove({ from: 'e7', to: 'e6' })?.verdict).toBe('alternative');
    expect(attempt.wasFlawless).toBe(true);
  });

  it('shows the piece first and the move second, only the second counting as a mistake', () => {
    const attempt = new LineAttempt(blackLines[0], 'b');
    attempt.playOpponentMove();
    expect(attempt.hint()).toEqual({ level: 1, square: 'c7' });
    expect(attempt.mistakes).toBe(0);
    expect(attempt.hint()).toMatchObject({ level: 2 });
    expect(attempt.mistakes).toBe(1);
    expect(attempt.hints).toBe(1);
  });

  it('counts peeking at the rest of the line as a single mistake', () => {
    const attempt = new LineAttempt(blackLines[0], 'b');
    attempt.peek();
    attempt.peek();
    expect(attempt.mistakes).toBe(1);
  });

  it('can start in the middle of a line for drills', () => {
    const line = blackLines[0];
    const target = line.moves[5];
    const item = drillItem({ id: 'black', color: 'b' }, line, target);
    const attempt = new LineAttempt(line, 'b', item.startIndex);
    expect(attempt.playOpponentMove()).toBe(line.moves[4]);
    expect(attempt.expected).toBe(target);
  });
});

describe('spaced repetition', () => {
  it('pushes reviews further out after each flawless run and resets on a mistake', () => {
    let record = nextLineRecord(undefined, true, NOW, 2);
    expect(record.intervalDays).toBe(1);
    record = nextLineRecord(record, true, NOW, 2);
    expect(record.intervalDays).toBe(3);
    expect(record.masteredAt).toBe(NOW);
    record = nextLineRecord(record, true, NOW + DAY_MS, 2);
    expect(record.intervalDays).toBe(8);
    expect(record.masteredAt).toBe(NOW);
    record = nextLineRecord(record, false, NOW, 2);
    expect(record).toMatchObject({ streak: 0, intervalDays: 0, due: NOW, masteredAt: undefined, failures: 1 });
  });

  it('reviews only lines that are due, including new ones', () => {
    const lines = blackLines.slice(0, 3);
    const records = { [lines[0].key]: nextLineRecord(undefined, true, NOW, 2) };
    const queue = buildQueue('review', [{ id: 'black', color: 'b', lines, records, moves: {} }], NOW);
    expect(queue.map((item) => item.line)).toEqual([lines[1], lines[2]]);
  });

  it('brings a failed line back after two others', () => {
    const items = blackLines.slice(0, 5).map((line) => lineItem({ id: 'black', color: 'b' }, line));
    const queue = new TrainingQueue(items, false);
    queue.complete(items[0], false);
    expect(queue.all.indexOf(items[0])).toBe(2);
    queue.complete(items[1], true);
    expect(queue.all.includes(items[1])).toBe(false);
  });

  it('keeps cycling through everything in "all" mode', () => {
    const items = blackLines.slice(0, 2).map((line) => lineItem({ id: 'black', color: 'b' }, line));
    const queue = new TrainingQueue(items, true);
    queue.complete(items[0], true);
    expect(queue.all).toEqual([items[1], items[0]]);
  });
});

describe('weak spots and mastery', () => {
  const line = blackLines[0];
  const [first, second] = line.moves.filter((m) => m.color === 'b');
  let moves = {};
  moves = { ...moves, [first.key]: nextMoveRecord(undefined, false, NOW) };
  moves = { ...moves, [second.key]: nextMoveRecord(nextMoveRecord(undefined, true, NOW), false, NOW) };

  it('lists moves missed at least a fifth of the time, worst first', () => {
    const weak = weakMoves(blackLines, 'b', moves);
    expect(weak.map((w) => w.node)).toEqual([second]);
    expect(weak[0].rate).toBe(0.5);
  });

  it('scores a line by the practised moves only', () => {
    expect(lineMastery(line, 'b', moves)).toBe(75);
    expect(lineMastery(blackLines[40], 'b', {})).toBeNull();
  });
});

describe('streaks', () => {
  it('counts consecutive days up to today or yesterday', () => {
    const events = [event('2026-09-22'), event('2026-09-23'), event('2026-09-24')];
    expect(currentStreak(events, NOW)).toBe(3);
    expect(currentStreak([...events, event(dayKey(NOW))], NOW)).toBe(4);
    expect(currentStreak([event('2026-09-20')], NOW)).toBe(0);
  });

  it('finds the longest run of training days', () => {
    expect(longestStreak([event('2026-09-01'), event('2026-09-02'), event('2026-09-10'), event('2026-09-11'), event('2026-09-12')])).toBe(3);
  });
});

describe('writePgn', () => {
  it('writes a repertoire that reads back to the same tree, with edited comments', () => {
    const target = blackLines[3].moves[4];
    const pgn = writePgn(sicilian, { headers: { Event: 'Test' }, comments: { [target.key]: 'My note' } });
    const reread = parseRepertoire(pgn);
    expect(reread.errors).toEqual([]);
    expect(extractLines(reread, 'black').map((l) => l.key)).toEqual(blackLines.map((l) => l.key));
    const copy = extractLines(reread, 'black')[3].moves[4];
    expect(copy.comment).toBe('My note');
  });
});

describe('parseInfoLine', () => {
  it('converts scores to the point of view of White', () => {
    expect(parseInfoLine('info depth 14 seldepth 20 multipv 1 score cp 35 nodes 1000 pv e2e4', 'w')).toEqual({ depth: 14, value: 0.35 });
    expect(parseInfoLine('info depth 14 seldepth 20 multipv 1 score cp 35 nodes 1000 pv e7e5', 'b')).toEqual({ depth: 14, value: -0.35 });
  });

  it('reports forced mates for the right side', () => {
    expect(parseInfoLine('info depth 9 score mate 3 pv d8h4', 'b')).toEqual({ depth: 9, value: -99, mate: -3 });
    expect(parseInfoLine('info depth 9 score mate -2 pv e1e2', 'w')).toEqual({ depth: 9, value: -99, mate: -2 });
  });

  it('ignores lines without a score, current-move updates and secondary lines', () => {
    expect(parseInfoLine('info string NNUE evaluation enabled', 'w')).toBeNull();
    expect(parseInfoLine('info depth 10 currmove e2e4 currmovenumber 1', 'w')).toBeNull();
    expect(parseInfoLine('info depth 10 multipv 2 score cp 10 pv d2d4', 'w')).toBeNull();
    expect(parseInfoLine('bestmove e2e4 ponder e7e5', 'w')).toBeNull();
  });
});

describe('game tree', () => {
  const game = (id: string, white: string, black: string, result: ImportedGame['result'], moves: string, date = '2026-09-01', timeClass: ImportedGame['timeClass'] = 'blitz'): ImportedGame => ({
    id, url: `https://example.org/${id}`, white, black, result, date, timeClass, rated: true, moves: moves.split(' '),
  });
  const games = [
    game('a', 'Magnus', 'x', '1-0', 'e4 c5 Nf3 d6'),
    game('b', 'Magnus', 'y', '0-1', 'Nf3 c5 e4 d6'),
    game('c', 'z', 'magnus', '1/2-1/2', 'd4 Nf6', '2025-01-01', 'rapid'),
  ];

  it('counts moves per position, merging transpositions, with results for the player', () => {
    const tree = buildGameTree(filterGames(games, 'magnus', { color: 'white', timeClasses: [], since: '' }), 'magnus');
    expect(movesAt(tree, DEFAULT_POSITION).map((m) => [m.san, m.games])).toEqual([['e4', 1], ['Nf3', 1]]);
    const chess = new Chess();
    ['e4', 'c5', 'Nf3'].forEach((m) => chess.move(m));
    const d6 = movesAt(tree, chess.fen());
    expect(d6).toEqual([expect.objectContaining({ san: 'd6', games: 2, wins: 1, losses: 1 })]);
  });

  it('filters by colour, time control and date', () => {
    expect(filterGames(games, 'Magnus', { color: 'black', timeClasses: [], since: '' }).map((g) => g.id)).toEqual(['c']);
    expect(filterGames(games, 'Magnus', { color: 'white', timeClasses: ['rapid'], since: '' })).toEqual([]);
    expect(filterGames(games, 'Magnus', { color: 'white', timeClasses: [], since: '2026-01-01' }).length).toBe(2);
  });

  it('gives the same tree from pre-indexed games, with transpositions sharing one position', () => {
    const plain = buildGameTree(games, 'magnus');
    const indexed = buildGameTree(games.map(indexGame), 'magnus');
    const chess = new Chess();
    ['e4', 'c5', 'Nf3'].forEach((m) => chess.move(m));
    expect(movesAt(indexed, chess.fen())).toEqual(movesAt(plain, chess.fen()));
    expect(indexGame(games[0]).positions![3]).toBe(indexGame(games[1]).positions![3]);
    expect(indexGame(games[0]).positions![2]).not.toBe(indexGame(games[1]).positions![2]);
    expect(positionHash(DEFAULT_POSITION)).not.toBe(positionHash(chess.fen()));
  });

  it('merges updates newest first without duplicates', () => {
    const older = { ...games[0], playedAt: 1 };
    const newer = { ...games[1], playedAt: 2 };
    expect(mergeGames([older], [newer, older]).map((g) => g.id)).toEqual(['b', 'a']);
  });

  it('recognises pasted profile links', () => {
    expect(parseProfile('https://lichess.org/@/some-player')).toEqual({ platform: 'lichess', username: 'some-player' });
    expect(parseProfile('https://www.chess.com/member/hikaru')).toEqual({ platform: 'chesscom', username: 'hikaru' });
    expect(parseProfile('some-player')).toBeNull();
  });

  it('reads the main line from PGN movetext with clocks, variations and results', () => {
    expect(movetextToSans('1. e4 {[%clk 0:03:00]} 1... c5 (1... e5 2. Nf3) 2. Nf3?! d6 $1 3. d4 1-0')).toEqual(['e4', 'c5', 'Nf3', 'd6', 'd4']);
  });
});

describe('repertoire editing', () => {
  it('adds and removes moves and keeps everything else when written back to PGN', () => {
    const repertoire = parseRepertoire(CARO_KANN_WHITE_PGN);
    const root = startRoot(repertoire);
    expect(extendTree(root, ['e4', 'c6', 'Nc3', 'd5', 'Nf3'])).not.toBeNull();
    expect(extendTree(root, ['e4', 'Ke7'])).toBeNull();
    removeNode(findNode(repertoire, 'e4 c6 Nc3 d5 Qf3 Nf6')!);
    const reread = parseRepertoire(writePgn(repertoire, { headers: repertoire.headers }));
    expect(findNode(reread, 'e4 c6 Nc3 d5 Nf3')).not.toBeNull();
    expect(findNode(reread, 'e4 c6 Nc3 d5 Qf3 Nf6')).toBeNull();
    expect(findNode(reread, 'e4 c6 Nc3 d5 Qf3 dxe4 Nxe4 Nf6 Bc4')?.comment).toBe('Covers f7 before Black can take there.');
    expect(reread.suggestedSide).toBe('white');
  });
});

describe('generatePrep', () => {
  const texts = {
    playerMove: (name: string, games: number, total: number) => `${name} ${games}/${total}`,
    databaseMove: (share: number) => `db ${share}`,
    engineReply: (value: string) => `expects ${value}`,
    fromRepertoire: 'rep',
    engineMove: (value: string) => `engine ${value}`,
    exploitMove: (name: string, value: string, score: number) => `exploit ${score}`,
  };
  const game = (id: string, moves: string, result: ImportedGame['result'] = '1-0'): ImportedGame => ({
    id, url: '', white: 'P', black: 'me', result, date: '2026-01-01', timeClass: 'blitz', rated: true, moves: moves.split(' '),
  });
  const tree = buildGameTree(
    [game('1', 'e4 c5 Nf3 d6'), game('2', 'e4 c5 Nf3 Nc6'), game('3', 'e4 c5 Nc3 Nc6'), game('4', 'd4 d5 c4 e6')].map(indexGame),
    'P',
  );
  const firstLegalMove = async (fen: string) => [{ san: new Chess(fen).moves()[0], value: 0.1 }];
  const options = { side: 'black' as const, maxMoves: 3, minGames: 1, minShare: 0, maxReplies: 3, useRepertoire: true, exploit: false, fill: 'none' as const, engineDepth: 10, maxOwnMoves: 50 };

  it('follows the player where they move and answers from the repertoire first, the engine otherwise', async () => {
    const own = parseRepertoire('1.e4 c5 2.Nf3 d6 *');
    const result = await generatePrep(options, { playerName: 'P', tree, repertoire: own, engine: firstLegalMove, database: null, onProgress: () => undefined, isCancelled: () => false }, texts);
    const root = startRoot(result.repertoire);
    expect(root.children.map((c) => c.san)).toEqual(['e4', 'd4']);
    expect(findNode(result.repertoire, 'e4 c5')?.comment).toBe('rep');
    expect(findNode(result.repertoire, 'e4 c5')!.children.map((c) => c.san)).toEqual(['Nf3', 'Nc3']);
    expect(findNode(result.repertoire, 'e4 c5 Nf3')?.comment).toBe('P 2/3');
    expect(findNode(result.repertoire, 'e4 c5 Nf3 d6')?.comment).toBe('rep');
    expect(findNode(result.repertoire, 'd4')!.children[0].comment).toMatch(/^engine/);
    expect(result.counts['e4']).toBe(3);
  });

  it('ranks lines by how likely the player is to play them', async () => {
    const result = await generatePrep(options, { playerName: 'P', tree, repertoire: parseRepertoire('1.e4 c5 2.Nf3 d6 2.Nc3 Nc6 *'), engine: firstLegalMove, database: null, onProgress: () => undefined, isCancelled: () => false }, texts);
    const lines = extractLines(result.repertoire, 'black');
    const chances = Object.fromEntries(lines.map((l) => [formatMoves(l.moves), lineLikelihood(l.moves, result.counts)]));
    expect(chances['1.e4 c5 2.Nf3 d6']).toBeCloseTo(0.75 * (2 / 3));
    expect(chances['1.e4 c5 2.Nc3 Nc6']).toBeCloseTo(0.75 * (1 / 3));
  });

  it('continues with the move Stockfish expects where the player has no games', async () => {
    const result = await generatePrep({ ...options, maxMoves: 4, fill: 'engine' }, { playerName: 'P', tree, repertoire: parseRepertoire('1.e4 c5 2.Nf3 d6 *'), engine: firstLegalMove, database: null, onProgress: () => undefined, isCancelled: () => false }, texts);
    const deepest = extractLines(result.repertoire, 'black').map((l) => l.moves.length);
    expect(Math.max(...deepest)).toBe(8);
    expect(findNode(result.repertoire, 'e4 c5 Nf3 d6')!.children[0].comment).toBe('expects +0.10');
  });

  it('prefers an equally good move the player scores badly against when exploiting', async () => {
    const lost = [game('5', 'e4 e5', '0-1'), game('6', 'e4 e5', '0-1'), game('7', 'e4 e5', '0-1'), game('8', 'e4 c5', '1-0'), game('9', 'e4 c5', '1-0'), game('10', 'e4 c5', '1-0')];
    const exploitTree = buildGameTree(lost.map(indexGame), 'P');
    const engine = async () => [{ san: 'c5', value: 0.3 }, { san: 'e5', value: 0.35 }];
    const result = await generatePrep({ ...options, maxMoves: 1, useRepertoire: false, exploit: true }, { playerName: 'P', tree: exploitTree, repertoire: null, engine, database: null, onProgress: () => undefined, isCancelled: () => false }, texts);
    expect(findNode(result.repertoire, 'e4')!.children.map((c) => c.san)).toEqual(['e5']);
    expect(findNode(result.repertoire, 'e4 e5')?.comment).toBe('exploit 0');
  });
});

describe('random mode', () => {
  const repertoire = parseRepertoire('1.e4 c5 (1...e5 2.Nf3) 2.Nf3 (2.Nc3) *');
  const lines = extractLines(repertoire, 'white');

  it('splits chances equally at every branch without frequencies', () => {
    const weights = lineWeights(lines);
    expect(weights.reduce((a, b) => a + b, 0)).toBeCloseTo(1);
    const byLine = Object.fromEntries(lines.map((l, i) => [formatMoves(l.moves), weights[i]]));
    expect(byLine['1.e4 e5 2.Nf3']).toBeCloseTo(0.5);
    expect(byLine['1.e4 c5 2.Nf3']).toBeCloseTo(0.25);
  });

  it('follows the stored frequencies of a prepared player', () => {
    const weights = lineWeights(lines, { 'e4 c5': 3, 'e4 e5': 1 });
    const byLine = Object.fromEntries(lines.map((l, i) => [formatMoves(l.moves), weights[i]]));
    expect(byLine['1.e4 e5 2.Nf3']).toBeCloseTo(0.25);
  });

  it('draws by weight, avoids repeating a line and brings a failed line back after two others', () => {
    const rolls = [0.99, 0.0, 0.0, 0.0, 0.0];
    const items = lines.map((line) => lineItem({ id: 'white', color: 'w' }, line));
    const queue = new WeightedQueue(items, [0.5, 0.5, 0, 0].slice(0, lines.length), () => rolls.shift() ?? 0);
    const first = queue.peek()!;
    queue.complete(first, false);
    const second = queue.peek()!;
    expect(second.line).not.toBe(first.line);
    queue.complete(second, true);
    const third = queue.peek()!;
    queue.complete(third, true);
    expect(queue.peek()!.line).toBe(first.line);
  });
});

describe('bulk import', () => {
  it('splits a file with several games into separate games', () => {
    expect(splitPgnGames(`${SICILIAN_BLACK_PGN}\n\n${CARO_KANN_WHITE_PGN}`)).toHaveLength(2);
  });

  it('makes one repertoire per exported repertoire, from many files or one combined file', () => {
    const fromFiles = groupRepertoires([{ name: 'a.pgn', text: SICILIAN_BLACK_PGN }, { name: 'b.pgn', text: CARO_KANN_WHITE_PGN }], 'white');
    const combined = groupRepertoires([{ name: 'all.pgn', text: `${SICILIAN_BLACK_PGN}\n${CARO_KANN_WHITE_PGN}` }], 'white');
    for (const items of [fromFiles, combined]) {
      expect(items.map((i) => [i.name, i.side, i.lines])).toEqual([
        ['Closed Sicilian test', 'black', 47],
        ['Caro Kann', 'white', 2],
      ]);
    }
  });

  it('keeps chapters of the same repertoire together and falls back to the file name', () => {
    const chapter = (moves: string) => `[Event "Chapter"]\n[White "?"]\n[Black "Najdorf"]\n[RepertoireColour "Black"]\n\n${moves} *`;
    const items = groupRepertoires([{ name: 'x.pgn', text: `${chapter('1.e4 c5 2.Nf3 d6')}\n\n${chapter('1.e4 c5 2.c3 Nf6')}` }, { name: 'Mijn lijnen.pgn', text: '1.d4 d5 2.c4 e6 *' }], 'black');
    expect(items.map((i) => [i.name, i.games, i.lines])).toEqual([
      ['Najdorf', 2, 2],
      ['Mijn lijnen', 1, 1],
    ]);
  });

  it('collects lines of several source repertoires per main opening and colour', () => {
    const chapter = (name: string, moves: string) => `[Event "x"]\n[Black "${name}"]\n[RepertoireColour "Black"]\n\n${moves} *`;
    const files = [{ name: 'all.pgn', text: [chapter('Najdorf', '1.e4 c5 2.Nf3 d6'), chapter('Alapin', '1.e4 c5 2.c3 Nf6'), chapter('Dutch', '1.d4 f5')].join('\n\n') }];
    const afterC5 = parseRepertoire('1.e4 c5 *').roots[0].children[0].children[0].fen;
    const afterF5 = parseRepertoire('1.d4 f5 *').roots[0].children[0].children[0].fen;
    const book: OpeningBook = { [positionKey(afterC5)]: ['B20', 'Sicilian Defense', 10], [positionKey(afterF5)]: ['A80', 'Dutch Defense', 5] };
    const base = groupRepertoires(files, 'black');
    expect(base.map((i) => i.name)).toEqual(['Najdorf', 'Alapin', 'Dutch']);
    const perOpening = regroup(base, 'opening', book, { white: 'W', black: 'Z' });
    expect(perOpening.map((i) => [i.name, i.lines, i.games])).toEqual([['Dutch Defense', 1, 1], ['Sicilian Defense', 2, 2]]);
    expect(regroup(base, 'side', book, { white: 'W', black: 'Z' }).map((i) => [i.name, i.lines])).toEqual([['Z', 3]]);
  });

  it('matches an existing repertoire by name and colour for updating', () => {
    const [item] = groupRepertoires([{ name: 'a.pgn', text: CARO_KANN_WHITE_PGN }], 'white');
    expect(matchExisting(item, [{ id: '1', name: 'caro kann ', side: 'white' }])?.id).toBe('1');
    expect(matchExisting(item, [{ id: '2', name: 'Caro Kann', side: 'black' }])).toBeNull();
  });
});

describe('repertoire scope', () => {
  const white = { id: 'w1', side: 'white' as const };
  const black = { id: 'b1', side: 'black' as const };

  it('selects all repertoires, those of one colour or a single one', () => {
    expect([white, black].filter((r) => inScope(r, { kind: 'all' }))).toEqual([white, black]);
    expect([white, black].filter((r) => inScope(r, { kind: 'side', side: 'black' }))).toEqual([black]);
    expect([white, black].filter((r) => inScope(r, { kind: 'one', id: 'w1' }))).toEqual([white]);
  });

  it('turns the old single active repertoire into a scope of one', () => {
    expect(scopeFromSettings(undefined, 'b1')).toEqual({ kind: 'one', id: 'b1' });
    expect(scopeFromSettings(undefined, null)).toEqual({ kind: 'all' });
    expect(scopeFromSettings({ kind: 'side', side: 'white' }, 'b1')).toEqual({ kind: 'side', side: 'white' });
  });
});

describe('sessions over several repertoires', () => {
  const whiteLines = extractLines(parseRepertoire(CARO_KANN_WHITE_PGN), 'white');
  const sources: QueueSource[] = [
    { id: 'white', color: 'w', lines: whiteLines, records: {}, moves: {} },
    { id: 'black', color: 'b', lines: blackLines.slice(0, 3), records: {}, moves: {} },
  ];

  it('reviews the lines of every repertoire, each with its own colour', () => {
    const queue = buildQueue('review', sources, NOW);
    expect(queue).toHaveLength(whiteLines.length + 3);
    expect(new Set(queue.map((item) => `${item.repertoireId}:${item.color}`))).toEqual(new Set(['white:w', 'black:b']));
  });

  it('draws random lines from all repertoires, weighted by their number of lines', () => {
    let roll = 0;
    const queue = randomQueue(sources, () => (roll = (roll + 0.37) % 1));
    const seen = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const item = queue.peek()!;
      seen.add(item.repertoireId);
      queue.complete(item, true);
    }
    expect(seen).toEqual(new Set(['white', 'black']));
  });
});

describe('free start', () => {
  const lines = extractLines(parseRepertoire('1.e4 c5 2.Nc3 (2.Nf3 d6) Nc6 (2...e6 3.g3) 3.g3 *'), 'white');

  it('keeps the lines that follow the moves played and still have a move to go', () => {
    expect(linesFrom(lines, ['e4', 'c5']).map((l) => formatMoves(l.moves))).toEqual(['1.e4 c5 2.Nc3 Nc6 3.g3', '1.e4 c5 2.Nc3 e6 3.g3', '1.e4 c5 2.Nf3']);
    expect(linesFrom(lines, ['e4', 'c5', 'Nf3'])).toEqual([]);
    expect(linesFrom(lines, ['d4'])).toEqual([]);
  });

  it('counts the lines behind every next move', () => {
    expect(nextMoves(linesFrom(lines, ['e4', 'c5']), 2)).toEqual([
      { san: 'Nc3', lines: 2 },
      { san: 'Nf3', lines: 1 },
    ]);
  });
});

describe('editing helpers', () => {
  it('finds positions by their moves and how much of a new line is already known', () => {
    const repertoire = parseRepertoire('1.e4 c5 2.Nc3 (2.Nf3) *');
    expect(nodeAt(repertoire, ['e4', 'c5', 'Nf3'])?.key).toBe('e4 c5 Nf3');
    expect(nodeAt(repertoire, ['e4', 'e5'])).toBeNull();
    expect(knownDepth(repertoire, ['e4', 'c5', 'd4', 'cxd4'])).toBe(2);
  });

  it('makes a move the main line, which PGN writes first', () => {
    const repertoire = parseRepertoire('1.e4 c5 2.Nc3 (2.Nf3) *');
    expect(promoteNode(nodeAt(repertoire, ['e4', 'c5', 'Nf3'])!)).toBe(true);
    expect(writePgn(repertoire, { headers: {} })).toContain('2. Nf3 (2. Nc3)');
    expect(promoteNode(nodeAt(repertoire, ['e4'])!)).toBe(false);
  });

  it('marks the tree row holding the position and the rows leading to it', () => {
    const repertoire = parseRepertoire('1.e4 c5 2.Nc3 (2.Nf3 d6 3.d4) *');
    const rows = treeRows(repertoire, extractLines(repertoire, 'white'), 'w', {});
    const node = nodeAt(repertoire, ['e4', 'c5', 'Nf3', 'd6'])!;
    expect(rows.map((row) => [row.text, rowRelation(row, node)])).toEqual([
      ['1.e4 c5', 'ancestor'],
      ['2.Nc3', 'none'],
      ['2.Nf3 d6 3.d4', 'current'],
    ]);
  });
});

describe('review schedule and known moves', () => {
  it('follows the chosen first interval and growth', () => {
    const intervals: number[] = [];
    for (let days = 0; intervals.length < 4; intervals.push(days)) {
      days = nextInterval(days, { firstDays: 2, growth: 2 });
    }
    expect(intervals).toEqual([2, 4, 8, 16]);
    expect(nextLineRecord(undefined, true, NOW, 3, { firstDays: 2, growth: 2 }).due).toBe(NOW + 2 * DAY_MS);
  });

  it('counts how often in a row a move was found, also for records kept before streaks existed', () => {
    let record = nextMoveRecord(undefined, false, NOW);
    record = nextMoveRecord(record, false, NOW);
    expect(moveStreak(record)).toBe(2);
    expect(moveStreak(nextMoveRecord(record, true, NOW))).toBe(0);
    expect(moveStreak({ attempts: 4, misses: 0, lastSeen: NOW })).toBe(4);
    expect(moveStreak({ attempts: 4, misses: 1, lastSeen: NOW })).toBe(0);
  });

  it('starts a line at the opponent move before your first move that is not known yet', () => {
    const [line] = extractLines(parseRepertoire('1.e4 c5 2.Nf3 d6 3.d4 cxd4 4.Nxd4 *'), 'white');
    const known = (count: number) => Object.fromEntries(line.moves.filter((m) => m.color === 'w').slice(0, count).map((m) => [m.key, { attempts: 3, misses: 0, lastSeen: NOW, streak: 3 }]));
    expect(knownPrefixStart(line, 'w', {}, 3)).toBe(0);
    expect(knownPrefixStart(line, 'w', known(2), 3)).toBe(3);
    expect(line.moves[3].san).toBe('d6');
    expect(knownPrefixStart(line, 'w', known(2), 4)).toBe(0);
    expect(knownPrefixStart(line, 'w', known(4), 3)).toBe(5);
  });
});

describe('representativeLine', () => {
  it('opens a repertoire at the opening most of its lines belong to, not at a side line that comes first', () => {
    const book: OpeningBook = {};
    const lines = extractLines(parseRepertoire('1.e4 c5 (1...e6 2.d4 d5 3.Nc3 (3.e5 c5 4.c3) Nf6 4.Bg5) 2.Nf3 *'), 'white', 0, book);
    const named = lines.map((line) => ({ ...line, name: line.moves[1].san === 'e6' ? 'French Defense: Classical' : 'Sicilian Defense' }));
    expect(representativeLine(named)?.moves[1].san).toBe('e6');
    expect(representativeLine([])).toBeNull();
  });
});

describe('knowledge shared between repertoires', () => {
  it('counts a position you know from one repertoire in the others of that colour', () => {
    const french = { e4: { attempts: 3, misses: 0, lastSeen: NOW, streak: 3 } };
    const sicilian = { e4: { attempts: 5, misses: 2, lastSeen: NOW, streak: 0 }, 'e4 c5 Nf3': { attempts: 1, misses: 0, lastSeen: NOW, streak: 1 } };
    const merged = mergeMoveRecords([sicilian, french]);
    expect(moveStreak(merged['e4'])).toBe(3);
    expect(moveStreak(merged['e4 c5 Nf3'])).toBe(1);
  });
});

describe('board themes', () => {
  const mix = (overlay: string, base: string) => {
    const [r, g, b, a] = overlay.match(/[\d.]+/g)!.map(Number);
    const hex = parseInt(base.slice(1), 16);
    const under = [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255];
    return [r, g, b].map((c, i) => Math.round(c * a + under[i] * (1 - a)));
  };
  const channels = (hex: string) => [0, 2, 4].map((i) => parseInt(hex.slice(1 + i, 3 + i), 16));

  it('finds one highlight that gives the chosen colours on light and dark squares', () => {
    for (const theme of Object.values(BOARD_THEMES)) {
      const overlay = highlightOverlay(theme.light, theme.dark, theme.lastMoveLight, theme.lastMoveDark);
      mix(overlay, theme.light).forEach((c, i) => expect(Math.abs(c - channels(theme.lastMoveLight)[i])).toBeLessThanOrEqual(24));
      mix(overlay, theme.dark).forEach((c, i) => expect(Math.abs(c - channels(theme.lastMoveDark)[i])).toBeLessThanOrEqual(24));
    }
  });

  it('draws the board with a8 light and a1 dark', () => {
    const svg = decodeURIComponent(boardImage('#ffffff', '#000000'));
    expect(svg).toContain('M1 0h1v1H1z');
    expect(svg).toContain('M0 7h1v1H0z');
    expect(svg).not.toContain('M0 0h1v1H0z');
  });
});

describe('tree navigation', () => {
  const repertoire = parseRepertoire('1.e4 c5 2.Nc3 (2.Nf3 d6 3.d4) Nc6 3.g3 *');

  it('hides the rows below a collapsed row, and only those', () => {
    const rows = treeRows(repertoire, extractLines(repertoire, 'white'), 'w', {});
    expect(visibleTreeRows(rows, new Set()).map((row) => row.text)).toEqual(['1.e4 c5', '2.Nc3 Nc6 3.g3', '2.Nf3 d6 3.d4']);
    expect(visibleTreeRows(rows, new Set(['e4 c5'])).map((row) => row.text)).toEqual(['1.e4 c5']);
    expect(visibleTreeRows(rows, new Set(['e4 c5 Nc3 Nc6 g3'])).map((row) => row.text)).toHaveLength(3);
  });

  it('follows the main line from a move to the end', () => {
    expect(formatMoves(mainContinuation(nodeAt(repertoire, ['e4'])!))).toBe('1...c5 2.Nc3 Nc6 3.g3');
    expect(mainContinuation(nodeAt(repertoire, ['e4', 'c5', 'Nf3', 'd6', 'd4'])!)).toEqual([]);
  });
});
