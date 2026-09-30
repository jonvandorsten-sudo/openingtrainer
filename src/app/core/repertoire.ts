import { parse } from '@mliebelt/pgn-parser';
import { Chess, DEFAULT_POSITION } from 'chess.js';

export type Side = 'white' | 'black';

export interface MoveNode {
  key: string;
  san: string;
  from: string;
  to: string;
  promotion?: string;
  color: 'w' | 'b';
  ply: number;
  fen: string;
  comment?: string;
  /** Engine evaluation in pawns from White's point of view, when the PGN carries one. */
  eval?: number;
  evalDepth?: number;
  parent: MoveNode | null;
  children: MoveNode[];
}

export interface Repertoire {
  roots: MoveNode[];
  gameCount: number;
  headers: Record<string, string>;
  suggestedSide?: Side;
  errors: string[];
}

interface ParsedMove {
  notation?: { notation?: string };
  variations?: ParsedMove[][];
  commentMove?: string;
  commentAfter?: string;
  commentDiag?: { eval?: string | number };
}

interface ParsedGame {
  tags?: Record<string, unknown>;
  moves?: ParsedMove[];
}

export function parseRepertoire(pgnText: string): Repertoire {
  const games = parse(pgnText, { startRule: 'games' }) as unknown as ParsedGame[];
  const roots = new Map<string, MoveNode>();
  const errors: string[] = [];
  let suggestedSide: Side | undefined;

  for (const game of games) {
    const startFen = typeof game.tags?.['FEN'] === 'string' ? (game.tags['FEN'] as string) : DEFAULT_POSITION;
    const root = roots.get(startFen) ?? createRoot(startFen);
    roots.set(startFen, root);
    addMoves(root, game.moves ?? [], errors);
    suggestedSide ??= colourFromTags(game.tags);
  }

  return {
    roots: [...roots.values()],
    gameCount: games.length,
    headers: stringTags(games[0]?.tags),
    suggestedSide,
    errors,
  };
}

function createRoot(fen: string): MoveNode {
  const chess = new Chess(fen);
  const turn = chess.turn();
  return {
    key: fen === DEFAULT_POSITION ? '' : `${fen}|`,
    san: '',
    from: '',
    to: '',
    color: turn === 'w' ? 'b' : 'w',
    ply: (chess.moveNumber() - 1) * 2 + (turn === 'w' ? 0 : 1),
    fen,
    parent: null,
    children: [],
  };
}

/** The PGN tag this app writes for the colour you play in a repertoire. */
export const COLOUR_TAG = 'RepertoireColour';

/** Tags that carry the repertoire colour: ours, and the one some training sites export. */
const COLOUR_TAGS = [COLOUR_TAG, 'ChesstempoRepertoireColour', 'ChesstempoRepertoireColor'];

export function colourFromTags(tags: Record<string, unknown> | undefined): Side | undefined {
  const value = String(COLOUR_TAGS.map((tag) => tags?.[tag]).find((v) => v !== undefined) ?? '').toLowerCase();
  return value === 'white' || value === 'black' ? value : undefined;
}

function stringTags(tags: Record<string, unknown> | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(tags ?? {})) {
    if (typeof value === 'string') {
      result[name] = value;
    }
  }
  return result;
}

function addMoves(start: MoveNode, moves: ParsedMove[], errors: string[]): void {
  let current = start;
  for (const move of moves) {
    const san = move.notation?.notation;
    const next = san ? playMove(current, san, errors) : null;
    for (const variation of move.variations ?? []) {
      addMoves(current, variation, errors);
    }
    if (!next) {
      return;
    }
    appendComment(next, move.commentMove);
    appendComment(next, move.commentAfter);
    if (next.eval === undefined) {
      const evaluation = parseEval(move.commentDiag?.eval);
      next.eval = evaluation?.value;
      next.evalDepth = evaluation?.depth;
    }
    current = next;
  }
}

/** Adds the moves (SAN) below `start`, reusing existing nodes; returns the last node, or null when a move is illegal. */
export function extendTree(start: MoveNode, sans: string[]): MoveNode | null {
  const errors: string[] = [];
  let node = start;
  for (const san of sans) {
    const next = playMove(node, san, errors);
    if (!next) {
      return null;
    }
    node = next;
  }
  return node;
}

/** Adds a copy of a move from another tree below `parent` (no replay needed, the position is already known). */
export function adoptMove(parent: MoveNode, move: MoveNode): MoveNode {
  const existing = parent.children.find((child) => child.san === move.san);
  if (existing) {
    return existing;
  }
  const node: MoveNode = {
    key: parent.key ? `${parent.key} ${move.san}` : move.san,
    san: move.san,
    from: move.from,
    to: move.to,
    promotion: move.promotion,
    color: move.color,
    ply: parent.ply + 1,
    fen: move.fen,
    parent,
    children: [],
  };
  parent.children.push(node);
  return node;
}

export function removeNode(node: MoveNode): void {
  if (node.parent) {
    node.parent.children = node.parent.children.filter((child) => child !== node);
  }
}

export function startRoot(repertoire: Repertoire): MoveNode {
  return repertoire.roots.find((root) => root.fen === DEFAULT_POSITION) ?? repertoire.roots[0];
}

function playMove(parent: MoveNode, san: string, errors: string[]): MoveNode | null {
  const known = parent.children.find((child) => child.san === san);
  if (known) {
    return known;
  }
  const chess = new Chess(parent.fen);
  let played;
  try {
    played = chess.move(san);
  } catch {
    errors.push(`${describePath(parent) || '(start)'}: ${san}`);
    return null;
  }

  const existing = parent.children.find((child) => child.san === played.san);
  if (existing) {
    return existing;
  }

  const node: MoveNode = {
    key: parent.key ? `${parent.key} ${played.san}` : played.san,
    san: played.san,
    from: played.from,
    to: played.to,
    promotion: played.promotion,
    color: played.color,
    ply: parent.ply + 1,
    fen: chess.fen(),
    parent,
    children: [],
  };
  parent.children.push(node);
  return node;
}

/** Some exports write centipawns as "cp,depth"; standard PGN writes pawns ("0.25", "#3" for mate). */
function parseEval(raw: string | number | undefined): { value: number; depth?: number } | undefined {
  if (raw === undefined || raw === null || raw === '') {
    return undefined;
  }
  if (typeof raw === 'number') {
    return { value: raw };
  }
  if (raw.startsWith('#')) {
    return { value: raw.startsWith('#-') ? -99 : 99 };
  }
  const [first, depth] = raw.split(',');
  const number = Number(first);
  if (!Number.isFinite(number)) {
    return undefined;
  }
  return raw.includes(',') ? { value: number / 100, depth: Number(depth) || undefined } : { value: number };
}

function appendComment(node: MoveNode, raw: string | undefined): void {
  const text = raw ? withoutRepetition(raw.replace(/\s+/g, ' ').trim()) : '';
  if (!text || node.comment?.includes(text)) {
    return;
  }
  node.comment = node.comment ? `${node.comment}\n\n${text}` : text;
}

/** Some exports repeat every comment (once reflowed); keep the first copy. */
export function withoutRepetition(text: string): string {
  const probe = normalized(text).slice(0, 40);
  if (probe.length < 40) {
    return text;
  }
  const lower = text.toLowerCase();
  for (let at = lower.indexOf(probe.slice(0, 12), 40); at > 0; at = lower.indexOf(probe.slice(0, 12), at + 1)) {
    const second = text.slice(at);
    if (normalized(second).startsWith(probe) && Math.abs(second.length - at) < at * 0.2) {
      return text.slice(0, at).trim();
    }
  }
  return text;
}

function normalized(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ');
}

export function pathTo(node: MoveNode): MoveNode[] {
  const path: MoveNode[] = [];
  for (let n: MoveNode | null = node; n?.parent; n = n.parent) {
    path.unshift(n);
  }
  return path;
}

export interface Evaluation {
  value: number;
  depth?: number;
  source?: 'pgn' | 'engine';
  mate?: number;
  /** Depth the engine is still working towards; absent when the value is final. */
  targetDepth?: number;
}

export function evaluationAt(node: MoveNode | null): Evaluation | null {
  for (let n = node; n; n = n.parent) {
    if (n.eval !== undefined) {
      return { value: n.eval, depth: n.evalDepth, source: 'pgn' };
    }
  }
  return null;
}

export function evalAt(node: MoveNode | null): number | null {
  return evaluationAt(node)?.value ?? null;
}

export function hasEvals(repertoire: Repertoire): boolean {
  return repertoire.roots.some((root) => walk(root, (node) => node.eval !== undefined) !== null);
}

export function moveNumber(node: MoveNode): number {
  return Math.ceil(node.ply / 2);
}

export function formatMoves(nodes: MoveNode[]): string {
  return nodes
    .map((node, i) => {
      if (node.color === 'w') {
        return `${moveNumber(node)}.${node.san}`;
      }
      return i === 0 ? `${moveNumber(node)}...${node.san}` : node.san;
    })
    .join(' ');
}

export function findNode(repertoire: Repertoire, key: string): MoveNode | null {
  for (const root of repertoire.roots) {
    const found = walk(root, (node) => node.key === key);
    if (found) {
      return found;
    }
  }
  return null;
}

function walk(node: MoveNode, predicate: (node: MoveNode) => boolean): MoveNode | null {
  if (predicate(node)) {
    return node;
  }
  for (const child of node.children) {
    const found = walk(child, predicate);
    if (found) {
      return found;
    }
  }
  return null;
}

function describePath(node: MoveNode): string {
  return formatMoves(pathTo(node));
}

/** The node reached by playing `sans` from the start position, or null when the repertoire does not contain them. */
export function nodeAt(repertoire: Repertoire, sans: string[]): MoveNode | null {
  let node: MoveNode | undefined = startRoot(repertoire);
  for (const san of sans) {
    node = node?.children.find((child) => child.san === san);
  }
  return node ?? null;
}

/** How many of the leading moves are already in the repertoire. */
export function knownDepth(repertoire: Repertoire, sans: string[]): number {
  let node: MoveNode | undefined = startRoot(repertoire);
  let depth = 0;
  for (const san of sans) {
    node = node?.children.find((child) => child.san === san);
    if (!node) {
      break;
    }
    depth++;
  }
  return depth;
}

/** Makes the move the main line: the first child of its parent. */
export function promoteNode(node: MoveNode): boolean {
  const siblings = node.parent?.children;
  if (!siblings || siblings[0] === node) {
    return false;
  }
  siblings.splice(siblings.indexOf(node), 1);
  siblings.unshift(node);
  return true;
}

/** The moves after `node` when every branch follows its main line. */
export function mainContinuation(node: MoveNode): MoveNode[] {
  const moves: MoveNode[] = [];
  for (let next = node.children[0]; next; next = next.children[0]) {
    moves.push(next);
  }
  return moves;
}
