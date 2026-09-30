import { DAY_MS } from './progress';

export interface AttemptEvent {
  repertoireId: string;
  lineKey: string;
  at: number;
  day: string;
  flawless: boolean;
  moves: number;
  missed: number;
  hints: number;
  durationMs: number;
}

export interface DailyActivity {
  day: string;
  lines: number;
  moves: number;
  missed: number;
}

export function dayKey(time: number): string {
  const date = new Date(time);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

export function daysBack(now: number, count: number): string[] {
  const start = startOfDay(now);
  return Array.from({ length: count }, (_, i) => dayKey(start - (count - 1 - i) * DAY_MS + DAY_MS / 2));
}

function startOfDay(time: number): number {
  const date = new Date(time);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

export function activityByDay(events: AttemptEvent[]): Map<string, DailyActivity> {
  const byDay = new Map<string, DailyActivity>();
  for (const event of events) {
    const entry = byDay.get(event.day) ?? { day: event.day, lines: 0, moves: 0, missed: 0 };
    entry.lines++;
    entry.moves += event.moves;
    entry.missed += event.missed;
    byDay.set(event.day, entry);
  }
  return byDay;
}

export function currentStreak(events: AttemptEvent[], now: number): number {
  const active = new Set(events.map((e) => e.day));
  let streak = 0;
  let cursor = startOfDay(now) + DAY_MS / 2;
  if (!active.has(dayKey(cursor))) {
    cursor -= DAY_MS;
  }
  while (active.has(dayKey(cursor))) {
    streak++;
    cursor -= DAY_MS;
  }
  return streak;
}

export function longestStreak(events: AttemptEvent[]): number {
  const days = [...new Set(events.map((e) => e.day))].sort();
  let best = 0;
  let run = 0;
  let previous: number | null = null;
  for (const day of days) {
    const time = new Date(`${day}T12:00:00`).getTime();
    run = previous !== null && Math.round((time - previous) / DAY_MS) === 1 ? run + 1 : 1;
    best = Math.max(best, run);
    previous = time;
  }
  return best;
}

export function accuracy(events: AttemptEvent[]): number | null {
  const moves = events.reduce((sum, e) => sum + e.moves, 0);
  if (moves === 0) {
    return null;
  }
  const missed = events.reduce((sum, e) => sum + e.missed, 0);
  return Math.round(100 * (1 - missed / moves));
}

export function eventsBetween(events: AttemptEvent[], from: number, to: number): AttemptEvent[] {
  return events.filter((e) => e.at >= from && e.at < to);
}

export function trainingTimeMs(events: AttemptEvent[]): number {
  return events.reduce((sum, e) => sum + e.durationMs, 0);
}

export function startOfWeek(now: number): number {
  const date = new Date(startOfDay(now));
  const weekday = (date.getDay() + 6) % 7;
  return date.getTime() - weekday * DAY_MS;
}
