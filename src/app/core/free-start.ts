import { TrainingLine } from './lines';

export interface NextMove {
  san: string;
  lines: number;
}

/** Lines from the standard start position that follow the moves played and still have a move to go. */
export function linesFrom(lines: TrainingLine[], sans: string[]): TrainingLine[] {
  return lines.filter((line) => line.root.key === '' && line.moves.length > sans.length && sans.every((san, i) => line.moves[i].san === san));
}

/** The moves those lines continue with, most lines first. */
export function nextMoves(lines: TrainingLine[], ply: number): NextMove[] {
  const counts = new Map<string, number>();
  for (const line of lines) {
    const san = line.moves[ply]?.san;
    if (san) {
      counts.set(san, (counts.get(san) ?? 0) + 1);
    }
  }
  return [...counts.entries()].map(([san, count]) => ({ san, lines: count })).sort((a, b) => b.lines - a.lines);
}
