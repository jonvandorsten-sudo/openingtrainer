import { TrainingLine } from './lines';
import { LineRecords, MoveRecords, isDue, missRate } from './progress';
import { MoveNode } from './repertoire';

export type TrainingMode = 'free' | 'review' | 'weak' | 'all' | 'random';

export interface QueueItem {
  line: TrainingLine;
  startIndex: number;
  /** The repertoire the line belongs to and the colour you play in it; a session can mix repertoires. */
  repertoireId: string;
  color: 'w' | 'b';
  focus?: MoveNode;
  /** The start was moved past moves you know; the line still counts as trained from the beginning. */
  autoStart?: boolean;
}

/** One repertoire's lines with its progress, as input for a session over several repertoires. */
export interface QueueSource {
  id: string;
  color: 'w' | 'b';
  lines: TrainingLine[];
  records: LineRecords;
  moves: MoveRecords;
  counts?: Record<string, number>;
}

export interface WeakMove {
  node: MoveNode;
  line: TrainingLine;
  rate: number;
  attempts: number;
  misses: number;
}

export const WEAK_THRESHOLD = 0.2;
const RETRY_AFTER_ITEMS = 2;

export function dueLines(lines: TrainingLine[], records: LineRecords, now: number): TrainingLine[] {
  return lines.filter((line) => isDue(records[line.key], now));
}

/** Moves of the trained side you miss at least `threshold` of the time, worst first. */
export function weakMoves(lines: TrainingLine[], color: 'w' | 'b', moves: MoveRecords, threshold = WEAK_THRESHOLD): WeakMove[] {
  const seen = new Map<MoveNode, WeakMove>();
  for (const line of lines) {
    for (const node of line.moves) {
      if (node.color !== color || seen.has(node)) {
        continue;
      }
      const record = moves[node.key];
      const rate = missRate(record);
      if (record && rate !== null && rate >= threshold) {
        seen.set(node, { node, line, rate, attempts: record.attempts, misses: record.misses });
      }
    }
  }
  return [...seen.values()].sort((a, b) => b.rate - a.rate || b.misses - a.misses);
}

export function lineItem(source: Pick<QueueSource, 'id' | 'color'>, line: TrainingLine, startIndex = 0): QueueItem {
  return { line, startIndex, repertoireId: source.id, color: source.color };
}

export function drillItem(source: Pick<QueueSource, 'id' | 'color'>, line: TrainingLine, node: MoveNode): QueueItem {
  return { ...lineItem(source, line, Math.max(0, line.moves.indexOf(node) - 1)), focus: node };
}

/** The session order over all repertoires in scope; free start builds its own queue from the chosen position. */
export function buildQueue(mode: TrainingMode, sources: QueueSource[], now: number): QueueItem[] {
  switch (mode) {
    case 'review': {
      const dueAt = (item: QueueItem) => sources.find((s) => s.id === item.repertoireId)?.records[item.line.key]?.due ?? 0;
      return sources
        .flatMap((source) => dueLines(source.lines, source.records, now).map((line) => lineItem(source, line)))
        .sort((a, b) => dueAt(a) - dueAt(b) || a.line.index - b.line.index);
    }
    case 'weak':
      return sources
        .flatMap((source) => weakMoves(source.lines, source.color, source.moves).map((weak) => ({ weak, item: drillItem(source, weak.line, weak.node) })))
        .sort((a, b) => b.weak.rate - a.weak.rate || b.weak.misses - a.weak.misses)
        .map(({ item }) => item);
    case 'all':
    case 'random':
      return sources.flatMap((source) => source.lines.map((line) => lineItem(source, line)));
    case 'free':
      return [];
  }
}

/** Random mode over several repertoires: each repertoire weighs as much as its number of lines, split over its lines by frequency. */
export function randomQueue(sources: QueueSource[], random: () => number = Math.random): WeightedQueue {
  const items = sources.flatMap((source) => source.lines.map((line) => lineItem(source, line)));
  const weights = sources.flatMap((source) => lineWeights(source.lines, source.counts).map((weight) => weight * source.lines.length));
  return new WeightedQueue(items, weights, random);
}

/**
 * Chance of each line when every branch is chosen in proportion to its weight: the stored move frequencies of a
 * prepared player, or equal odds for moves without a frequency.
 */
export function lineWeights(lines: TrainingLine[], counts: Record<string, number> = {}): number[] {
  const onLines = new Set(lines.flatMap((line) => line.moves));
  const weightOf = (node: MoveNode) => counts[node.key] ?? 1;
  return lines.map((line) =>
    line.moves.reduce((chance, move) => {
      const siblings = move.parent?.children.filter((child) => onLines.has(child)) ?? [];
      const total = siblings.reduce((sum, child) => sum + weightOf(child), 0);
      return siblings.length > 1 && total > 0 ? (chance * weightOf(move)) / total : chance;
    }, 1),
  );
}

export interface SessionQueue {
  peek(): QueueItem | null;
  complete(item: QueueItem, flawless: boolean): void;
  skip(item: QueueItem): void;
}

/** Endless session that draws lines at random by weight, like playing the real opponent; a failed line returns after two others. */
export class WeightedQueue implements SessionQueue {
  private current: QueueItem | null = null;
  private previous: TrainingLine | null = null;
  private retries: { item: QueueItem; after: number }[] = [];

  constructor(
    private readonly items: QueueItem[],
    private readonly weights: number[],
    private readonly random: () => number = Math.random,
  ) {}

  peek(): QueueItem | null {
    this.current ??= this.draw();
    return this.current;
  }

  complete(item: QueueItem, flawless: boolean): void {
    this.current = null;
    this.previous = item.line;
    this.retries.forEach((retry) => retry.after--);
    if (!flawless) {
      this.retries.push({ item: { ...item, startIndex: 0, focus: undefined }, after: RETRY_AFTER_ITEMS });
    }
  }

  skip(item: QueueItem): void {
    this.current = null;
    this.previous = item.line;
  }

  private draw(): QueueItem | null {
    const due = this.retries.findIndex((retry) => retry.after <= 0);
    if (due >= 0) {
      return this.retries.splice(due, 1)[0].item;
    }
    const candidates = this.items.map((item, i) => ({ item, weight: this.weights[i] ?? 0 })).filter((c) => c.item.line !== this.previous || this.items.length === 1);
    const total = candidates.reduce((sum, c) => sum + c.weight, 0);
    if (candidates.length === 0 || total <= 0) {
      return null;
    }
    let roll = this.random() * total;
    for (const candidate of candidates) {
      roll -= candidate.weight;
      if (roll < 0) {
        return candidate.item;
      }
    }
    return candidates[candidates.length - 1].item;
  }
}

/** Order of the session: failed items come back after two others; in 'all' mode finished items rejoin at the end. */
export class TrainingQueue implements SessionQueue {
  private items: QueueItem[];

  constructor(
    items: QueueItem[],
    private readonly cycle: boolean,
  ) {
    this.items = [...items];
  }

  get remaining(): number {
    return this.items.length;
  }

  get all(): readonly QueueItem[] {
    return this.items;
  }

  peek(): QueueItem | null {
    return this.items[0] ?? null;
  }

  complete(item: QueueItem, flawless: boolean): void {
    this.remove(item);
    if (!flawless) {
      this.items.splice(Math.min(RETRY_AFTER_ITEMS, this.items.length), 0, item);
    } else if (this.cycle) {
      this.items.push(item);
    }
  }

  skip(item: QueueItem): void {
    this.remove(item);
    this.items.push(item);
  }

  putFirst(item: QueueItem): void {
    this.remove(item);
    this.items.unshift(item);
  }

  private remove(item: QueueItem): void {
    this.items = this.items.filter((queued) => queued !== item);
  }
}
