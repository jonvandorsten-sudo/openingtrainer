import { TrainingLine } from './lines';
import { MoveRecords, averageMastery } from './progress';
import { MoveNode, Repertoire, formatMoves, moveNumber } from './repertoire';

/** One row of the move tree: a run of moves without branches. */
export interface TreeRow {
  depth: number;
  text: string;
  nodes: MoveNode[];
  end: MoveNode;
  leaf: boolean;
  lines: number;
  mastery: number | null;
}

export function treeRows(repertoire: Repertoire, lines: TrainingLine[], color: 'w' | 'b', moves: MoveRecords): TreeRow[] {
  const rows: TreeRow[] = [];
  const walk = (node: MoveNode, depth: number) => {
    for (const child of node.children) {
      const nodes = [child];
      let end = child;
      while (end.children.length === 1) {
        end = end.children[0];
        nodes.push(end);
      }
      const through = lines.filter((line) => line.moves.includes(end));
      rows.push({ depth, text: formatMoves(nodes), nodes, end, leaf: end.children.length === 0, lines: through.length, mastery: averageMastery(through, color, moves) });
      walk(end, depth + 1);
    }
  };
  repertoire.roots.forEach((root) => walk(root, 0));
  return rows;
}

export type RowRelation = 'current' | 'ancestor' | 'none';

/** Whether a row holds the given position, lies on the way to it, or neither. */
export function rowRelation(row: TreeRow, node: MoveNode | null): RowRelation {
  if (!node) {
    return 'none';
  }
  if (row.nodes.includes(node)) {
    return 'current';
  }
  for (let n = node.parent; n; n = n.parent) {
    if (n === row.end) {
      return 'ancestor';
    }
  }
  return 'none';
}

export interface RowMove {
  node: MoveNode;
  number: string;
  san: string;
}

/** The moves of a row with their move numbers, so each move can be clicked on its own. */
export function rowMoves(row: TreeRow): RowMove[] {
  return row.nodes.map((node, i) => ({
    node,
    number: node.color === 'w' ? `${moveNumber(node)}.` : i === 0 ? `${moveNumber(node)}...` : '',
    san: node.san,
  }));
}

/** The rows that stay visible when the rows in `collapsed` (keyed by their last move) hide what follows them. */
export function visibleTreeRows(rows: TreeRow[], collapsed: ReadonlySet<string>): TreeRow[] {
  if (collapsed.size === 0) {
    return rows;
  }
  return rows.filter((row) => {
    for (let node = row.nodes[0].parent; node; node = node.parent) {
      if (collapsed.has(node.key)) {
        return false;
      }
    }
    return true;
  });
}
