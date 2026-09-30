import { TrainingLine } from './lines';
import { MoveNode } from './repertoire';

export const DAY_MS = 24 * 60 * 60 * 1000;

export interface LineRecord {
  streak: number;
  attempts: number;
  failures: number;
  intervalDays: number;
  due: number;
  lastSeen: number;
  masteredAt?: number;
}

export interface MoveRecord {
  attempts: number;
  misses: number;
  lastSeen: number;
  /** Times in a row the move was found without help; absent in records from before it was kept. */
  streak?: number;
}

export type LineRecords = Record<string, LineRecord>;
export type MoveRecords = Record<string, MoveRecord>;

/** Days until the first review, and how many times longer every next interval becomes. */
export interface ReviewSchedule {
  firstDays: number;
  growth: number;
}

export const DEFAULT_SCHEDULE: ReviewSchedule = { firstDays: 1, growth: 2.5 };

/** Spaced repetition: each flawless run pushes the next review further out (by default 1, 3, 8, 20 … days); a mistake makes the line due again. */
export function nextLineRecord(previous: LineRecord | undefined, flawless: boolean, now: number, masteryCount: number, schedule: ReviewSchedule = DEFAULT_SCHEDULE): LineRecord {
  const streak = flawless ? (previous?.streak ?? 0) + 1 : 0;
  const intervalDays = flawless ? nextInterval(previous?.intervalDays ?? 0, schedule) : 0;
  const wasMastered = (previous?.streak ?? 0) >= masteryCount;
  return {
    streak,
    attempts: (previous?.attempts ?? 0) + 1,
    failures: (previous?.failures ?? 0) + (flawless ? 0 : 1),
    intervalDays,
    due: now + intervalDays * DAY_MS,
    lastSeen: now,
    masteredAt: streak >= masteryCount ? (wasMastered ? previous?.masteredAt : now) : undefined,
  };
}

export function nextInterval(previous: number, schedule: ReviewSchedule = DEFAULT_SCHEDULE): number {
  if (previous <= 0) {
    return schedule.firstDays;
  }
  return Math.max(previous + 1, Math.round(previous * schedule.growth));
}

export function nextMoveRecord(previous: MoveRecord | undefined, missed: boolean, now: number): MoveRecord {
  return {
    attempts: (previous?.attempts ?? 0) + 1,
    misses: (previous?.misses ?? 0) + (missed ? 1 : 0),
    lastSeen: now,
    streak: missed ? 0 : moveStreak(previous) + 1,
  };
}

/** Times in a row the move was found; older records without a streak count as a streak when never missed. */
export function moveStreak(record: MoveRecord | undefined): number {
  if (!record) {
    return 0;
  }
  return record.streak ?? (record.misses === 0 ? record.attempts : 0);
}

/**
 * Where a line starts when the moves you already know are played for you: at the opponent move before your first
 * move found fewer than `needed` times in a row, and never later than your last move so every line trains something.
 */
export function knownPrefixStart(line: TrainingLine, color: 'w' | 'b', moves: MoveRecords, needed: number, from = 0): number {
  const own = line.moves.map((move, index) => ({ move, index })).filter(({ move, index }) => move.color === color && index >= from);
  if (own.length === 0) {
    return from;
  }
  const first = own.find(({ move }) => moveStreak(moves[move.key]) < needed) ?? own[own.length - 1];
  return Math.max(from, first.index - 1);
}

export function isDue(record: LineRecord | undefined, now: number): boolean {
  return !record || record.due <= now;
}

export function isMastered(record: LineRecord | undefined, masteryCount: number): boolean {
  return (record?.streak ?? 0) >= masteryCount;
}

export function missRate(record: MoveRecord | undefined): number | null {
  return record && record.attempts > 0 ? record.misses / record.attempts : null;
}

export function playerMoves(line: TrainingLine, color: 'w' | 'b'): MoveNode[] {
  return line.moves.filter((move) => move.color === color);
}

/** Share of the line's moves you find without help, over the moves you have practised; null when none are practised yet. */
export function lineMastery(line: TrainingLine, color: 'w' | 'b', moves: MoveRecords): number | null {
  const rates = playerMoves(line, color)
    .map((move) => missRate(moves[move.key]))
    .filter((rate): rate is number => rate !== null);
  if (rates.length === 0) {
    return null;
  }
  return Math.round(100 * (1 - rates.reduce((sum, rate) => sum + rate, 0) / rates.length));
}

export function averageMastery(lines: TrainingLine[], color: 'w' | 'b', moves: MoveRecords): number | null {
  const values = lines.map((line) => lineMastery(line, color, moves)).filter((m): m is number => m !== null);
  return values.length === 0 ? null : Math.round(values.reduce((sum, m) => sum + m, 0) / values.length);
}

/** Move records of several repertoires combined per position, keeping the longest streak; positions are keyed by their moves. */
export function mergeMoveRecords(all: MoveRecords[]): MoveRecords {
  const merged: MoveRecords = {};
  for (const records of all) {
    for (const [key, record] of Object.entries(records)) {
      if (moveStreak(record) > moveStreak(merged[key])) {
        merged[key] = record;
      }
    }
  }
  return merged;
}
