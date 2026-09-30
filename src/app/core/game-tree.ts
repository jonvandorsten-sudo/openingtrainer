import { Chess } from 'chess.js';
import { positionKey } from './openings';

export type Platform = 'lichess' | 'chesscom';
export type TimeClass = 'bullet' | 'blitz' | 'rapid' | 'classical' | 'daily';
export type GameResult = '1-0' | '0-1' | '1/2-1/2' | '*';

export interface ImportedGame {
  id: string;
  url: string;
  white: string;
  black: string;
  whiteElo?: number;
  blackElo?: number;
  result: GameResult;
  /** YYYY-MM-DD */
  date: string;
  timeClass: TimeClass;
  rated: boolean;
  moves: string[];
  /** Start time in ms; used to fetch only newer games when updating. */
  playedAt?: number;
  /** Hash of the position before each move, computed once at import so trees build without replaying games. */
  positions?: string[];
}

export interface GameFilter {
  color: 'both' | 'white' | 'black';
  timeClasses: TimeClass[];
  /** YYYY-MM-DD, inclusive; empty for no limit. */
  since: string;
}

export interface MoveStats {
  san: string;
  games: number;
  wins: number;
  draws: number;
  losses: number;
  lastPlayed: string;
  gameIds: string[];
}

/** Position hash → moves played there, with results from the player's point of view. */
export type GameTree = Map<string, Map<string, MoveStats>>;

export const MAX_PLIES = 40;
const MAX_GAME_IDS = 30;

export function playerColor(game: ImportedGame, player: string): 'white' | 'black' | null {
  const name = player.toLowerCase();
  if (game.white.toLowerCase() === name) {
    return 'white';
  }
  return game.black.toLowerCase() === name ? 'black' : null;
}

export function filterGames(games: ImportedGame[], player: string, filter: GameFilter): ImportedGame[] {
  return games.filter((game) => {
    const color = playerColor(game, player);
    return (
      color !== null &&
      (filter.color === 'both' || filter.color === color) &&
      (filter.timeClasses.length === 0 || filter.timeClasses.includes(game.timeClass)) &&
      (!filter.since || game.date >= filter.since)
    );
  });
}

/** 53-bit FNV-style hash of the position part of a FEN; collisions are negligible at the scale of a few million positions. */
export function positionHash(fen: string): string {
  const key = positionKey(fen);
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < key.length; i++) {
    const c = key.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619);
    h2 = Math.imul(h2 ^ c, 2246822519);
  }
  return ((h1 >>> 0) * 2097152 + ((h2 >>> 0) & 0x1fffff)).toString(36);
}

/** Replays a game once: normalises the moves and stores the position hash before each of them. */
export function indexGame(game: ImportedGame): ImportedGame {
  const chess = new Chess();
  const moves: string[] = [];
  const positions: string[] = [];
  for (const san of game.moves.slice(0, MAX_PLIES)) {
    const before = positionHash(chess.fen());
    try {
      moves.push(chess.move(san).san);
    } catch {
      break;
    }
    positions.push(before);
  }
  return { ...game, moves, positions };
}

/** Indexes games in slices so the page stays responsive while thousands of games are processed. */
export async function indexGames(games: ImportedGame[], onProgress: (done: number) => void): Promise<ImportedGame[]> {
  const indexed: ImportedGame[] = [];
  for (let i = 0; i < games.length; i++) {
    indexed.push(games[i].positions ? games[i] : indexGame(games[i]));
    if (i % 100 === 99) {
      onProgress(i + 1);
      await new Promise((resolve) => setTimeout(resolve));
    }
  }
  onProgress(games.length);
  return indexed;
}

/** Newer games first, duplicates (same id) dropped. */
export function mergeGames(existing: ImportedGame[], incoming: ImportedGame[]): ImportedGame[] {
  const byId = new Map<string, ImportedGame>();
  for (const game of [...incoming, ...existing]) {
    if (!byId.has(game.id)) {
      byId.set(game.id, game);
    }
  }
  return [...byId.values()].sort((a, b) => (b.playedAt ?? 0) - (a.playedAt ?? 0) || b.date.localeCompare(a.date));
}

/** Merges transpositions: moves are counted per position, not per move order. */
export function buildGameTree(games: ImportedGame[], player: string): GameTree {
  const tree: GameTree = new Map();
  for (const game of games) {
    const color = playerColor(game, player);
    if (!color) {
      continue;
    }
    const outcome = outcomeFor(game.result, color);
    const { moves, positions } = game.positions ? game : indexGame(game);
    for (let ply = 0; ply < positions!.length; ply++) {
      const key = positions![ply];
      const san = moves[ply];
      const atPosition = tree.get(key) ?? new Map<string, MoveStats>();
      tree.set(key, atPosition);
      let stats = atPosition.get(san);
      if (!stats) {
        stats = { san, games: 0, wins: 0, draws: 0, losses: 0, lastPlayed: '', gameIds: [] };
        atPosition.set(san, stats);
      }
      stats.games++;
      stats[outcome]++;
      if (game.date > stats.lastPlayed) {
        stats.lastPlayed = game.date;
      }
      if (stats.gameIds.length < MAX_GAME_IDS) {
        stats.gameIds.push(game.id);
      }
    }
  }
  return tree;
}

export function movesAt(tree: GameTree, fen: string): MoveStats[] {
  return [...(tree.get(positionHash(fen))?.values() ?? [])].sort((a, b) => b.games - a.games);
}

export function gamesAt(tree: GameTree, fen: string): string[] {
  return movesAt(tree, fen).flatMap((move) => move.gameIds);
}

export function score(stats: { wins: number; draws: number; games: number }): number {
  return stats.games === 0 ? 0 : Math.round((100 * (stats.wins + stats.draws / 2)) / stats.games);
}

function outcomeFor(result: GameResult, color: 'white' | 'black'): 'wins' | 'draws' | 'losses' {
  if (result === '1/2-1/2' || result === '*') {
    return 'draws';
  }
  return (result === '1-0') === (color === 'white') ? 'wins' : 'losses';
}

/** Moves of a PGN movetext as SAN, without numbers, comments, variations or result. */
export function movetextToSans(movetext: string): string[] {
  const withoutComments = movetext.replace(/\{[^}]*\}/g, ' ').replace(/;[^\n]*/g, ' ');
  let depth = 0;
  let mainline = '';
  for (const char of withoutComments) {
    if (char === '(') {
      depth++;
    } else if (char === ')') {
      depth = Math.max(0, depth - 1);
    } else if (depth === 0) {
      mainline += char;
    }
  }
  return mainline
    .split(/\s+/)
    .map((token) => token.replace(/^\d+\.(\.\.)?/, '').replace(/[!?]+$/, ''))
    .filter((token) => token && !/^\$\d+$/.test(token) && !/^(1-0|0-1|1\/2-1\/2|\*)$/.test(token));
}

/** Accepts pasted profile links such as lichess.org/@/Name or chess.com/member/name. */
export function parseProfile(value: string): { platform: Platform; username: string } | null {
  const lichess = /lichess\.org\/@\/([\w-]+)/i.exec(value);
  if (lichess) {
    return { platform: 'lichess', username: lichess[1] };
  }
  const chesscom = /chess\.com\/(?:member|players?)\/([\w-]+)/i.exec(value);
  return chesscom ? { platform: 'chesscom', username: chesscom[1] } : null;
}
