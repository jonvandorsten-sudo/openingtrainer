import { OpeningBook, openingAt, openingFamily } from './openings';
import { MoveNode, Repertoire, Side, formatMoves } from './repertoire';

export interface TrainingLine {
  key: string;
  index: number;
  root: MoveNode;
  moves: MoveNode[];
  /** ECO code of the most specific named opening on the line, empty when unknown. */
  eco: string;
  /** Opening family (or, without an opening book, the first branching move) used to group lines. */
  group: string;
  name: string;
}

export function sideToColor(side: Side): 'w' | 'b' {
  return side === 'white' ? 'w' : 'b';
}

/** Every distinct root-to-leaf path that contains at least one move of `side`, cut off after `maxMoves` full moves (0 = unlimited). */
export function extractLines(repertoire: Repertoire, side: Side, maxMoves = 0, book: OpeningBook | null = null): TrainingLine[] {
  const color = sideToColor(side);
  const maxPly = maxMoves > 0 ? maxMoves * 2 : Number.POSITIVE_INFINITY;
  const endpoints: { root: MoveNode; moves: MoveNode[] }[] = [];

  for (const root of repertoire.roots) {
    collectEndpoints(root, [], maxPly, (moves) => endpoints.push({ root, moves: endingOnPlayerMove(moves, color) }));
  }

  const kept = withoutPrefixLines(endpoints.filter((e) => e.moves.length > 0));
  const onSomeLine = new Set(kept.flatMap((line) => line.moves));
  return kept.map(({ root, moves }, index) => {
    const branches = moves.filter((node) => isBranch(node, onSomeLine));
    const firstBranch = branches[0] ? formatMoves([branches[0]]) : formatMoves(moves.slice(0, 2));
    const opening = openingAt(moves[moves.length - 1], book);
    const title = opening?.name ?? firstBranch;
    const lastBranch = branches.length > (opening ? 0 : 1) ? formatMoves([branches[branches.length - 1]]) : '';
    return {
      key: moves[moves.length - 1].key,
      index,
      root,
      moves,
      eco: opening?.eco ?? '',
      group: opening ? openingFamily(opening.name) : firstBranch,
      name: lastBranch ? `${title} · ${lastBranch}` : title,
    };
  });
}

function isBranch(node: MoveNode, onSomeLine: Set<MoveNode>): boolean {
  return (node.parent?.children.filter((sibling) => onSomeLine.has(sibling)).length ?? 0) > 1;
}

function collectEndpoints(node: MoveNode, path: MoveNode[], maxPly: number, emit: (moves: MoveNode[]) => void): void {
  const children = node.children.filter((child) => child.ply <= maxPly);
  if (children.length === 0) {
    emit(path);
    return;
  }
  for (const child of children) {
    collectEndpoints(child, [...path, child], maxPly, emit);
  }
}

function endingOnPlayerMove(moves: MoveNode[], color: 'w' | 'b'): MoveNode[] {
  let end = moves.length;
  while (end > 0 && moves[end - 1].color !== color) {
    end--;
  }
  return moves.slice(0, end);
}

function withoutPrefixLines<T extends { moves: MoveNode[] }>(lines: T[]): T[] {
  const coveredByLongerLine = new Set<MoveNode>();
  for (const line of lines) {
    const last = line.moves[line.moves.length - 1];
    for (let n = last.parent; n; n = n.parent) {
      coveredByLongerLine.add(n);
    }
  }

  const seenEnds = new Set<MoveNode>();
  return lines.filter((line) => {
    const last = line.moves[line.moves.length - 1];
    if (coveredByLongerLine.has(last) || seenEnds.has(last)) {
      return false;
    }
    seenEnds.add(last);
    return true;
  });
}

/** The first line of the opening most lines belong to, so a repertoire opens at what it is mainly about. */
export function representativeLine(lines: TrainingLine[]): TrainingLine | null {
  const counts = new Map<string, number>();
  for (const line of lines) {
    counts.set(mainOpeningOf(line), (counts.get(mainOpeningOf(line)) ?? 0) + 1);
  }
  const [main] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] ?? [];
  return lines.find((line) => mainOpeningOf(line) === main) ?? null;
}

function mainOpeningOf(line: TrainingLine): string {
  return line.name.split(/[:·]/)[0].trim();
}
