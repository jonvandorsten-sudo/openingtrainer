import { TrainingLine, extractLines } from './lines';
import { OpeningBook, openingAt } from './openings';
import { writePgn } from './pgn-writer';
import { COLOUR_TAG, Repertoire, Side, adoptMove, colourFromTags, formatMoves, parseRepertoire, startRoot } from './repertoire';

export interface SourceFile {
  name: string;
  text: string;
}

export interface ImportItem {
  name: string;
  side: Side;
  pgn: string;
  games: number;
  lines: number;
  errors: number;
  /** The parsed tree, kept so regrouping does not parse large files again. */
  parsed?: Repertoire;
}

export interface ExistingRepertoire {
  id: string;
  name: string;
  side: Side;
}

/** Splits a PGN file into its games; a new game starts at a tag line that follows movetext. */
export function splitPgnGames(text: string): string[] {
  const games: string[] = [];
  let current: string[] = [];
  let inMoves = false;
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    const isTag = /^\s*\[\w+\s+"/.test(line);
    if (isTag && inMoves) {
      games.push(current.join('\n').trim());
      current = [];
      inMoves = false;
    }
    if (!isTag && line.trim() !== '') {
      inMoves = true;
    }
    current.push(line);
  }
  if (current.join('').trim()) {
    games.push(current.join('\n').trim());
  }
  return games;
}

/**
 * Turns exported files into repertoires: games with the same name and colour form one repertoire,
 * so one big export and many small files both end up as one repertoire per exported repertoire.
 */
export function groupRepertoires(files: SourceFile[], defaultSide: Side): ImportItem[] {
  const groups = new Map<string, { name: string; side: Side; games: string[] }>();
  for (const file of files) {
    const games = splitPgnGames(file.text).filter((game) => /\d\s*\.|\*/.test(game));
    for (const game of games) {
      const tags = readTags(game);
      const side = sideFromTags(tags) ?? defaultSide;
      const name = nameFromTags(tags, side) ?? file.name.replace(/\.pgn$/i, '');
      const key = `${side}|${name.toLowerCase()}`;
      const group = groups.get(key) ?? { name, side, games: [] };
      group.games.push(game);
      groups.set(key, group);
    }
  }
  return [...groups.values()].map(({ name, side, games }) => {
    const pgn = `${games.join('\n\n')}\n`;
    try {
      const repertoire = parseRepertoire(pgn);
      return { name, side, pgn, games: games.length, lines: extractLines(repertoire, side).length, errors: repertoire.errors.length, parsed: repertoire };
    } catch {
      return { name, side, pgn, games: games.length, lines: 0, errors: games.length };
    }
  });
}

export type Grouping = 'source' | 'opening' | 'side';

/**
 * Regroups imported repertoires: as exported, collected per main opening (the part of the book name before the
 * colon, across all source repertoires of the same colour), or one repertoire per colour.
 */
export function regroup(items: ImportItem[], grouping: Grouping, book: OpeningBook | null, sideNames: Record<Side, string>): ImportItem[] {
  if (grouping === 'source') {
    return items;
  }
  const groups = new Map<string, { name: string; side: Side; lines: TrainingLine[]; games: number }>();
  for (const item of items) {
    const lines = extractLines(item.parsed ?? parseRepertoire(item.pgn), item.side, 0, book);
    for (const line of lines) {
      const name = grouping === 'side' ? sideNames[item.side] : mainOpening(line, book);
      const key = `${item.side}|${name}`;
      const group = groups.get(key) ?? { name, side: item.side, lines: [], games: 0 };
      group.lines.push(line);
      groups.set(key, group);
    }
    for (const key of new Set(lines.map((line) => `${item.side}|${grouping === 'side' ? sideNames[item.side] : mainOpening(line, book)}`))) {
      groups.get(key)!.games += item.games;
    }
  }
  return [...groups.values()]
    .sort((a, b) => (a.side === b.side ? a.name.localeCompare(b.name) : a.side === 'white' ? -1 : 1))
    .map(({ name, side, lines, games }) => fromLines(name, side, lines, games));
}

/** Builds a repertoire from lines of possibly different sources; shared moves merge, comments of all sources are kept. */
function fromLines(name: string, side: Side, lines: TrainingLine[], games: number): ImportItem {
  const repertoire = parseRepertoire('*');
  const root = startRoot(repertoire);
  for (const line of lines) {
    let node = root;
    for (const move of line.moves) {
      const child = adoptMove(node, move);
      if (move.comment && !child.comment?.includes(move.comment)) {
        child.comment = child.comment ? `${child.comment}\n\n${move.comment}` : move.comment;
      }
      child.eval ??= move.eval;
      child.evalDepth ??= move.evalDepth;
      node = child;
    }
  }
  const colour = side === 'white' ? 'White' : 'Black';
  const headers: Record<string, string> = { Event: name, [colour]: name, [COLOUR_TAG]: colour };
  const pgn = `${writePgn(repertoire, { headers })}\n`;
  return { name, side, pgn, games, lines: extractLines(repertoire, side).length, errors: 0 };
}

function mainOpening(line: TrainingLine, book: OpeningBook | null): string {
  const opening = openingAt(line.moves[line.moves.length - 1], book);
  return opening ? opening.name.split(':')[0].trim() : formatMoves(line.moves.slice(0, 2));
}

/** An import updates an existing repertoire with the same name and colour instead of adding a duplicate. */
export function matchExisting(item: ImportItem, existing: ExistingRepertoire[]): ExistingRepertoire | null {
  return existing.find((r) => r.side === item.side && r.name.trim().toLowerCase() === item.name.trim().toLowerCase()) ?? null;
}

function readTags(game: string): Record<string, string> {
  return Object.fromEntries([...game.matchAll(/^\s*\[(\w+)\s+"([^"]*)"\]/gm)].map((m) => [m[1], m[2]]));
}

function sideFromTags(tags: Record<string, string>): Side | null {
  return colourFromTags(tags) ?? null;
}

/** Some exports put the repertoire name in the White or Black tag of the side you play; others use Event. */
function nameFromTags(tags: Record<string, string>, side: Side): string | null {
  const candidates = [side === 'white' ? tags['White'] : tags['Black'], tags['Event']];
  return candidates.find((c) => c && c.trim() && c !== '?' && !/^(white|black) repertoire$/i.test(c.trim()))?.trim() ?? null;
}
