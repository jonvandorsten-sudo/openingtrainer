import { Chess } from 'chess.js';
import { GameTree, movesAt, score } from './game-tree';
import { MoveNode, Repertoire, extendTree, findNode, parseRepertoire, startRoot } from './repertoire';

export interface PrepOptions {
  /** Colour you play against the prepared player. */
  side: 'white' | 'black';
  /** Stop after this many full moves. */
  maxMoves: number;
  /** A reply of the player is included when played at least this often… */
  minGames: number;
  /** …and in at least this share (0–100) of their games in that position. */
  minShare: number;
  maxReplies: number;
  useRepertoire: boolean;
  /** Among good engine moves, prefer the one this player scores worst against. */
  exploit: boolean;
  /** Where the player has no games: popular database moves, the engine's expected reply, or stop. */
  fill: PrepFill;
  engineDepth: number;
  /** Safety limit for the number of positions where you are to move. */
  maxOwnMoves: number;
}

export type PrepFill = 'none' | 'database' | 'engine';

export interface EngineCandidate {
  san: string;
  /** Pawns from White's point of view. */
  value: number;
}

export interface DatabaseMove {
  san: string;
  share: number;
}

export interface PrepDependencies {
  playerName: string;
  tree: GameTree;
  repertoire: Repertoire | null;
  engine: (fen: string, depth: number) => Promise<EngineCandidate[]>;
  database: ((fen: string) => Promise<DatabaseMove[]>) | null;
  onProgress: (positions: number) => void;
  isCancelled: () => boolean;
}

export interface PrepResult {
  repertoire: Repertoire;
  /** Weight of each opponent move among its siblings (games played, database share or 1 for an engine guess), keyed by node key. */
  counts: Record<string, number>;
  ownMoves: number;
}

export interface PrepTexts {
  playerMove: (name: string, games: number, total: number, score: number) => string;
  databaseMove: (share: number) => string;
  engineReply: (value: string) => string;
  fromRepertoire: string;
  engineMove: (value: string) => string;
  exploitMove: (name: string, value: string, score: number, games: number) => string;
}

/** Tolerance in pawns within which a move counts as "as good as the engine's best" for exploiting. */
const EXPLOIT_MARGIN = 0.4;
const EXPLOIT_MIN_GAMES = 3;
const DATABASE_MIN_SHARE = 25;
const DATABASE_MAX_REPLIES = 2;

/** Builds a repertoire against one player: their real replies, your answers from your repertoire or the engine. */
export async function generatePrep(options: PrepOptions, deps: PrepDependencies, texts: PrepTexts): Promise<PrepResult> {
  const repertoire = parseRepertoire('*');
  const root = startRoot(repertoire);
  const myColor = options.side === 'white' ? 'w' : 'b';
  const maxPly = options.maxMoves * 2;
  const counts: Record<string, number> = {};
  let ownMoves = 0;
  let visited = 0;

  const visit = async (node: MoveNode, sans: string[]): Promise<void> => {
    if (deps.isCancelled() || node.ply >= maxPly) {
      return;
    }
    deps.onProgress(++visited);
    const turn = new Chess(node.fen).turn();

    if (turn === myColor) {
      if (ownMoves >= options.maxOwnMoves) {
        return;
      }
      ownMoves++;
      const choice = await chooseOwnMove(node, sans);
      if (!choice) {
        return;
      }
      const child = extendTree(node, [choice.san]);
      if (child) {
        child.comment = choice.comment;
        if (choice.value !== undefined) {
          child.eval = choice.value;
        }
        await visit(child, [...sans, child.san]);
      }
      return;
    }

    const stats = movesAt(deps.tree, node.fen);
    const total = stats.reduce((sum, m) => sum + m.games, 0);
    let replies = stats
      .filter((m) => m.games >= options.minGames && (100 * m.games) / total >= options.minShare)
      .slice(0, options.maxReplies)
      .map((m) => ({ san: m.san, comment: texts.playerMove(deps.playerName, m.games, total, score(m)), count: m.games }));

    if (replies.length === 0 && options.fill === 'database' && deps.database) {
      const popular = await deps.database(node.fen).catch(() => []);
      replies = popular
        .filter((m) => m.share >= DATABASE_MIN_SHARE)
        .slice(0, DATABASE_MAX_REPLIES)
        .map((m) => ({ san: m.san, comment: texts.databaseMove(Math.round(m.share)), count: Math.round(m.share) }));
    }
    if (replies.length === 0 && options.fill !== 'none') {
      const expected = (await deps.engine(node.fen, options.engineDepth))[0];
      if (expected) {
        replies = [{ san: expected.san, comment: texts.engineReply(formatValue(expected.value)), count: 1 }];
      }
    }

    for (const reply of replies) {
      const child = extendTree(node, [reply.san]);
      if (child) {
        child.comment = reply.comment;
        counts[child.key] = reply.count;
        await visit(child, [...sans, child.san]);
      }
    }
  };

  const chooseOwnMove = async (node: MoveNode, sans: string[]): Promise<{ san: string; comment: string; value?: number } | null> => {
    if (options.useRepertoire && deps.repertoire) {
      const known = sans.length === 0 ? startRoot(deps.repertoire) : findNode(deps.repertoire, sans.join(' '));
      const main = known?.children[0];
      if (main) {
        return { san: main.san, comment: texts.fromRepertoire, value: main.eval };
      }
    }
    const candidates = await deps.engine(node.fen, options.engineDepth);
    if (candidates.length === 0) {
      return null;
    }
    const sign = myColor === 'w' ? 1 : -1;
    const best = candidates[0];
    if (options.exploit) {
      const theirResults = movesAt(deps.tree, node.fen);
      const exploitable = candidates
        .filter((c) => sign * (best.value - c.value) <= EXPLOIT_MARGIN)
        .map((c) => ({ candidate: c, stats: theirResults.find((m) => m.san === c.san) }))
        .filter((c) => c.stats && c.stats.games >= EXPLOIT_MIN_GAMES)
        .sort((a, b) => score(a.stats!) - score(b.stats!));
      const pick = exploitable[0];
      if (pick && score(pick.stats!) < 50) {
        return {
          san: pick.candidate.san,
          value: pick.candidate.value,
          comment: texts.exploitMove(deps.playerName, formatValue(pick.candidate.value), score(pick.stats!), pick.stats!.games),
        };
      }
    }
    return { san: best.san, value: best.value, comment: texts.engineMove(formatValue(best.value)) };
  };

  await visit(root, []);
  return { repertoire, counts, ownMoves };
}

/** Probability (0–1) that the player follows this line, from the counts stored with the preparation. */
export function lineLikelihood(moves: MoveNode[], counts: Record<string, number>): number {
  let likelihood = 1;
  for (const move of moves) {
    if (!(move.key in counts) || !move.parent) {
      continue;
    }
    const siblings = move.parent.children.reduce((sum, child) => sum + (counts[child.key] ?? 0), 0);
    if (siblings > 0) {
      likelihood *= (counts[move.key] ?? 0) / siblings;
    }
  }
  return likelihood;
}

function formatValue(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}`;
}

