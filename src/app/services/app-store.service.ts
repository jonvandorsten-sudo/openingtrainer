import { Injectable, computed, inject, signal } from '@angular/core';
import { TrainingLine, extractLines, sideToColor } from '../core/lines';
import { writePgn } from '../core/pgn-writer';
import {
  LineRecords,
  MoveRecords,
  averageMastery,
  isMastered,
  nextLineRecord,
  mergeMoveRecords,
  nextMoveRecord,
} from '../core/progress';
import { OpeningBook } from '../core/openings';
import { QueueSource, dueLines, weakMoves } from '../core/queue';
import { ImportedGame, Platform } from '../core/game-tree';
import { COLOUR_TAG, Repertoire, Side, extendTree, findNode, parseRepertoire, promoteNode, removeNode, startRoot } from '../core/repertoire';
import { RepertoireScope, inScope, scopeFromSettings } from '../core/scope';
import { AttemptEvent, currentStreak, dayKey } from '../core/stats';
import { APP_NAME } from '../app-name';
import { BoardThemeName, PieceSetName } from '../core/board-theme';
import { LocalDatabase, openLocalDatabase } from './local-database';
import { TranslationService } from './translation.service';

export type Language = 'nl' | 'en' | 'de' | 'fr' | 'es' | 'it' | 'pt';

/** The languages of the interface, each named in its own language. */
export const LANGUAGES: { code: Language; name: string }[] = [
  { code: 'en', name: 'English' },
  { code: 'nl', name: 'Nederlands' },
  { code: 'de', name: 'Deutsch' },
  { code: 'fr', name: 'Français' },
  { code: 'es', name: 'Español' },
  { code: 'it', name: 'Italiano' },
  { code: 'pt', name: 'Português' },
];

export interface RepertoireRecord {
  id: string;
  name: string;
  side: Side;
  pgn: string;
  comments: Record<string, string>;
  createdAt: number;
  updatedAt: number;
  /** Set for repertoires generated against one player: how often they played each of their moves. */
  prep?: PrepInfo;
}

export interface PrepInfo {
  playerId: string;
  playerName: string;
  counts: Record<string, number>;
}

export interface ProgressRecord {
  repertoireId: string;
  lines: LineRecords;
  moves: MoveRecords;
}

export interface PlayerRecord {
  id: string;
  platform: Platform;
  username: string;
  games: ImportedGame[];
  fetchedAt: number;
}

export type EvalSource = 'stockfish' | 'pgn';

export interface Settings {
  language: Language;
  /** Which repertoires the views work over. */
  activeScope?: RepertoireScope;
  /** The repertoire in focus within the scope, e.g. the one shown in the Repertoire view. */
  activeRepertoireId: string | null;
  pickerCollapsed?: Side[];
  boardTheme: BoardThemeName;
  pieceSet: PieceSetName;
  /** The site the add-player dialog opens with: the one used last. */
  playerPlatform?: Platform;
  editTreeOpen?: boolean;
  dailyGoal: number;
  showEval: boolean;
  evalSource: EvalSource;
  engineDepth: number;
  replyDelayMs: number;
  masteryCount: number;
  /** Lines are trained up to this many full moves; 0 trains them to the end. */
  trainDepth: number;
  /** Play the opening moves you already know for you at the start of a line. */
  autoPlayKnown: boolean;
  firstReviewDays: number;
  reviewGrowth: number;
}

export interface Backup {
  app: 'opening-trainer';
  version: 1;
  exportedAt: string;
  repertoires: RepertoireRecord[];
  progress: ProgressRecord[];
  events: AttemptEvent[];
  settings: Settings;
  players?: PlayerRecord[];
}

export interface ImportRequest {
  pgn: string;
  name: string;
  side: Side;
  targetId: string | null;
}

export interface LineResult {
  repertoireId: string;
  line: TrainingLine;
  /** Drills that start mid-line are logged but do not reschedule the line. */
  partial: boolean;
  flawless: boolean;
  moves: number;
  missed: number;
  hints: number;
  durationMs: number;
}

export interface ActiveRepertoire {
  record: RepertoireRecord;
  repertoire: Repertoire;
  lines: TrainingLine[];
  color: 'w' | 'b';
}

/** A repertoire as it was before a change, kept so the change can be undone later. */
export interface HistoryEntry {
  at: number;
  kind: 'edit' | 'delete';
  record: RepertoireRecord;
  /** Kept for deleted repertoires, whose progress is removed with them. */
  progress?: ProgressRecord;
  lines: number;
}

export type ViewStateKey = 'explorer' | 'file' | 'fileHandle';

/** Settings that only remember how the screens look; changing them is not a change worth saving. */
const VIEW_SETTINGS = new Set<keyof Settings>(['language', 'activeScope', 'activeRepertoireId', 'pickerCollapsed', 'editTreeOpen', 'playerPlatform', 'boardTheme', 'pieceSet']);

const SETTINGS_KEY = 'settings';
const HISTORY_KEY = 'history';
const HISTORY_SIZE = 20;
const LEGACY_PGN_KEY = 'opening-trainer.last-pgn';

const DEFAULT_SETTINGS: Settings = {
  language: browserLanguage(),
  activeRepertoireId: null,
  dailyGoal: 20,
  showEval: true,
  evalSource: 'stockfish',
  engineDepth: 18,
  replyDelayMs: 450,
  masteryCount: 3,
  trainDepth: 0,
  autoPlayKnown: true,
  firstReviewDays: 1,
  reviewGrowth: 2.5,
  boardTheme: 'steen',
  pieceSet: 'staunty',
};

@Injectable({ providedIn: 'root' })
export class AppStore {
  private readonly translations = inject(TranslationService);
  private db!: LocalDatabase;
  private readonly parsed = new Map<string, { pgn: string; repertoire: Repertoire }>();
  private readonly lineCache = new Map<string, { pgn: string; side: Side; book: OpeningBook | null; depth: number; lines: TrainingLine[] }>();

  readonly ready = signal(false);
  readonly persistent = signal(true);
  readonly repertoires = signal<RepertoireRecord[]>([]);
  readonly progress = signal<Record<string, ProgressRecord>>({});
  readonly events = signal<AttemptEvent[]>([]);
  readonly players = signal<PlayerRecord[]>([]);
  readonly settings = signal<Settings>(DEFAULT_SETTINGS);
  readonly now = signal(Date.now());
  readonly openings = signal<OpeningBook | null>(null);
  /** Counts changes to the data that goes into a saved file; view state and UI preferences do not count. */
  readonly revision = signal(0);

  /** Recent changes, newest first, persisted so they survive a reload. */
  readonly history = signal<HistoryEntry[]>([]);
  readonly lastChange = computed<HistoryEntry | null>(() => this.history()[0] ?? null);

  readonly scope = computed<RepertoireScope>(() => {
    const settings = this.settings();
    const scope = scopeFromSettings(settings.activeScope, settings.activeRepertoireId);
    return scope.kind === 'one' && !this.repertoires().some((r) => r.id === scope.id) ? { kind: 'all' } : scope;
  });

  /** The repertoires in scope, White before Black; all of them when the scope matches none. */
  readonly scoped = computed<ActiveRepertoire[]>(() => {
    const scope = this.scope();
    const all = this.repertoires();
    const records = all.filter((record) => inScope(record, scope));
    return (records.length > 0 ? records : all)
      .slice()
      .sort((a, b) => (a.side === b.side ? 0 : a.side === 'white' ? -1 : 1))
      .map((record) => this.toActive(record));
  });

  /** The repertoire in focus within the scope: the one last selected, otherwise the first. */
  readonly active = computed<ActiveRepertoire | null>(() => {
    const scoped = this.scoped();
    return scoped.find((a) => a.record.id === this.settings().activeRepertoireId) ?? scoped[0] ?? null;
  });

  readonly queueSources = computed<QueueSource[]>(() =>
    this.scoped().map((active) => {
      const progress = this.progressOf(active.record.id);
      return { id: active.record.id, color: active.color, lines: active.lines, records: progress.lines, moves: progress.moves, counts: active.record.prep?.counts };
    }),
  );

  readonly lineCount = computed(() => this.scoped().reduce((sum, active) => sum + active.lines.length, 0));

  readonly dueCount = computed(() => {
    const now = this.now();
    return this.queueSources().reduce((sum, source) => sum + dueLines(source.lines, source.records, now).length, 0);
  });

  readonly weakCount = computed(() => this.queueSources().reduce((sum, source) => sum + weakMoves(source.lines, source.color, source.moves).length, 0));

  readonly streak = computed(() => currentStreak(this.events(), this.now()));

  readonly todayCount = computed(() => {
    const today = dayKey(this.now());
    return this.events().filter((e) => e.day === today).length;
  });

  async init(): Promise<void> {
    this.db = await openLocalDatabase();
    this.persistent.set(this.db.persistent);
    const [repertoires, progress, events, settings, players] = await Promise.all([
      this.db.getAll<RepertoireRecord>('repertoires'),
      this.db.getAll<ProgressRecord>('progress'),
      this.db.getAll<AttemptEvent>('events'),
      this.db.getAll<{ key: string; value: Settings }>('settings'),
      this.db.getAll<PlayerRecord>('players'),
    ]);
    this.players.set(players.sort((a, b) => a.fetchedAt - b.fetchedAt));
    this.repertoires.set(repertoires.sort((a, b) => a.createdAt - b.createdAt));
    this.progress.set(Object.fromEntries(progress.map((p) => [p.repertoireId, p])));
    this.events.set(events.sort((a, b) => a.at - b.at));
    this.applySettings({ ...DEFAULT_SETTINGS, ...settings.find((s) => s.key === SETTINGS_KEY)?.value });
    this.history.set((settings.find((s) => s.key === HISTORY_KEY)?.value as unknown as HistoryEntry[] | undefined) ?? []);
    await this.importLegacyPgn();
    this.ready.set(true);
    navigator.storage?.persist?.().catch(() => undefined);
    setInterval(() => this.now.set(Date.now()), 60_000);
    void this.loadOpenings();
  }

  parse(record: RepertoireRecord): Repertoire {
    const cached = this.parsed.get(record.id);
    if (cached?.pgn === record.pgn) {
      return cached.repertoire;
    }
    const repertoire = parseRepertoire(record.pgn);
    this.parsed.set(record.id, { pgn: record.pgn, repertoire });
    return repertoire;
  }

  linesOf(record: RepertoireRecord): TrainingLine[] {
    const book = this.openings();
    const cached = this.lineCache.get(record.id);
    const depth = this.settings().trainDepth;
    if (cached && cached.pgn === record.pgn && cached.side === record.side && cached.book === book && cached.depth === depth) {
      return cached.lines;
    }
    const lines = extractLines(this.parse(record), record.side, depth, book);
    this.lineCache.set(record.id, { pgn: record.pgn, side: record.side, book, depth, lines });
    return lines;
  }

  toActive(record: RepertoireRecord): ActiveRepertoire {
    return { record, repertoire: this.parse(record), lines: this.linesOf(record), color: sideToColor(record.side) };
  }

  find(id: string | null): ActiveRepertoire | null {
    const record = this.repertoires().find((r) => r.id === id);
    return record ? this.toActive(record) : null;
  }

  progressOf(id: string): ProgressRecord {
    return this.progress()[id] ?? { repertoireId: id, lines: {}, moves: {} };
  }

  /** What you know per position over all your repertoires of one colour, as the same moves count wherever they occur. */
  knownMoves(color: 'w' | 'b'): MoveRecords {
    const side = color === 'w' ? 'white' : 'black';
    return mergeMoveRecords(this.repertoires().filter((r) => r.side === side).map((r) => this.progressOf(r.id).moves));
  }

  dueOf(record: RepertoireRecord): number {
    return dueLines(this.linesOf(record), this.progressOf(record.id).lines, this.now()).length;
  }

  async selectScope(scope: RepertoireScope): Promise<void> {
    await this.updateSettings({ activeScope: scope, activeRepertoireId: scope.kind === 'one' ? scope.id : this.settings().activeRepertoireId });
  }

  /** Puts a repertoire in focus, narrowing the scope to it only when it lies outside the scope. */
  async focusRepertoire(id: string): Promise<void> {
    const record = this.repertoires().find((r) => r.id === id);
    if (!record) {
      return;
    }
    await this.updateSettings(inScope(record, this.scope()) ? { activeRepertoireId: id } : { activeScope: { kind: 'one', id }, activeRepertoireId: id });
  }

  masteryOf(record: RepertoireRecord): number | null {
    return averageMastery(this.linesOf(record), sideToColor(record.side), this.progress()[record.id]?.moves ?? {});
  }

  masteredCount(record: RepertoireRecord): number {
    const lines = this.progress()[record.id]?.lines ?? {};
    return this.linesOf(record).filter((line) => isMastered(lines[line.key], this.settings().masteryCount)).length;
  }

  commentFor(repertoireId: string, nodeKey: string, fallback: string | undefined): string {
    return this.repertoires().find((r) => r.id === repertoireId)?.comments[nodeKey] ?? fallback ?? '';
  }

  async importPgn(request: ImportRequest): Promise<RepertoireRecord> {
    parseRepertoire(request.pgn);
    const now = Date.now();
    const existing = this.repertoires().find((r) => r.id === request.targetId);
    const record: RepertoireRecord = existing
      ? { ...existing, pgn: `${existing.pgn.trim()}\n\n${request.pgn.trim()}\n`, updatedAt: now }
      : { id: newId(), name: request.name.trim() || '?', side: request.side, pgn: request.pgn, comments: {}, createdAt: now, updatedAt: now };
    await this.saveRepertoire(record);
    await this.focusRepertoire(record.id);
    return record;
  }

  async createRepertoire(name: string, side: Side): Promise<RepertoireRecord> {
    const now = Date.now();
    const colour = side === 'white' ? 'White' : 'Black';
    const pgn = `[Event "${name.trim().replace(/"/g, "'")}"]\n[${COLOUR_TAG} "${colour}"]\n\n*\n`;
    const record: RepertoireRecord = { id: newId(), name: name.trim() || '?', side, pgn, comments: {}, createdAt: now, updatedAt: now };
    await this.saveRepertoire(record);
    await this.focusRepertoire(record.id);
    return record;
  }

  async saveGeneratedRepertoire(name: string, side: Side, pgn: string, prep: PrepInfo): Promise<RepertoireRecord> {
    const now = Date.now();
    const existing = this.repertoires().find((r) => r.prep?.playerId === prep.playerId && r.side === side);
    const record: RepertoireRecord = existing
      ? { ...existing, name, pgn, prep, updatedAt: now }
      : { id: newId(), name, side, pgn, comments: {}, createdAt: now, updatedAt: now, prep };
    await this.saveRepertoire(record);
    await this.focusRepertoire(record.id);
    return record;
  }

  /** Adds a line (SAN moves from the start position) to a repertoire; an existing line it starts with is extended. */
  async addLine(id: string, sans: string[]): Promise<boolean> {
    return this.edit(id, (repertoire) => extendTree(startRoot(repertoire), sans) !== null);
  }

  /** Adds several replies after the given moves, e.g. the opponent's most common answers. */
  async addReplies(id: string, prefix: string[], replies: string[]): Promise<boolean> {
    return this.edit(id, (repertoire) => {
      const node = extendTree(startRoot(repertoire), prefix);
      return node !== null && replies.every((reply) => extendTree(node, [reply]) !== null);
    });
  }

  /** Removes a move and everything after it. */
  async removeMove(id: string, nodeKey: string): Promise<boolean> {
    return this.edit(id, (repertoire) => {
      const node = findNode(repertoire, nodeKey);
      if (!node?.parent) {
        return false;
      }
      removeNode(node);
      return true;
    });
  }

  /** Makes a move the main line among its siblings. */
  async promoteMove(id: string, nodeKey: string): Promise<boolean> {
    return this.edit(id, (repertoire) => {
      const node = findNode(repertoire, nodeKey);
      return !!node && promoteNode(node);
    });
  }

  /** Restores the repertoire as it was before the last change. */
  async undoLastChange(): Promise<void> {
    const entry = this.lastChange();
    if (entry) {
      await this.restore(entry);
    }
  }

  /** Puts a repertoire back as it was before a change: its moves and comments, or the whole repertoire when it was deleted. */
  async restore(entry: HistoryEntry): Promise<void> {
    const current = this.repertoires().find((r) => r.id === entry.record.id);
    await this.saveHistory(this.history().filter((e) => e !== entry));
    await this.saveRepertoire(current ? { ...current, pgn: entry.record.pgn, comments: entry.record.comments, updatedAt: Date.now() } : entry.record);
    if (!current && entry.progress) {
      await this.saveProgress(entry.progress);
    }
  }

  async loadViewState<T>(key: ViewStateKey): Promise<T | null> {
    const rows = await this.db.getAll<{ key: string; value: T }>('settings');
    return rows.find((row) => row.key === key)?.value ?? null;
  }

  async saveViewState(key: ViewStateKey, value: unknown): Promise<void> {
    await this.db.put('settings', { key, value });
  }

  async savePlayer(player: PlayerRecord): Promise<void> {
    this.players.update((list) => [...list.filter((p) => p.id !== player.id), player]);
    this.touch();
    await this.db.put('players', player);
  }

  async deletePlayer(id: string): Promise<void> {
    this.players.update((list) => list.filter((p) => p.id !== id));
    this.touch();
    await this.db.delete('players', id);
  }

  /** Replaces the moves of a repertoire with a fresh export; progress and own comments stay, as they are keyed by move path. */
  async replacePgn(id: string, pgn: string): Promise<void> {
    const record = this.repertoires().find((r) => r.id === id);
    if (record) {
      parseRepertoire(pgn);
      await this.remember('edit', record);
      await this.saveRepertoire({ ...record, pgn, updatedAt: Date.now() });
    }
  }

  async renameRepertoire(id: string, name: string): Promise<void> {
    const record = this.repertoires().find((r) => r.id === id);
    if (record && name.trim()) {
      await this.saveRepertoire({ ...record, name: name.trim(), updatedAt: Date.now() });
    }
  }

  private touch(): void {
    this.revision.update((n) => n + 1);
  }

  async deleteRepertoire(id: string): Promise<void> {
    const record = this.repertoires().find((r) => r.id === id);
    if (record) {
      await this.remember('delete', record, this.progress()[id]);
    }
    await this.db.delete('repertoires', id);
    await this.db.delete('progress', id);
    this.repertoires.update((list) => list.filter((r) => r.id !== id));
    this.touch();
    this.progress.update(({ [id]: _removed, ...rest }) => rest);
    if (this.settings().activeRepertoireId === id) {
      await this.updateSettings({ activeRepertoireId: this.repertoires()[0]?.id ?? null });
    }
  }

  async setComment(repertoireId: string, nodeKey: string, text: string): Promise<void> {
    const record = this.repertoires().find((r) => r.id === repertoireId);
    if (record) {
      await this.saveRepertoire({ ...record, comments: { ...record.comments, [nodeKey]: text }, updatedAt: Date.now() });
    }
  }

  async resetProgress(id: string): Promise<void> {
    await this.saveProgress({ repertoireId: id, lines: {}, moves: {} });
  }

  recordMove(repertoireId: string, nodeKey: string, missed: boolean): void {
    const progress = this.progressOf(repertoireId);
    void this.saveProgress({
      ...progress,
      moves: { ...progress.moves, [nodeKey]: nextMoveRecord(progress.moves[nodeKey], missed, Date.now()) },
    });
  }

  recordLine(result: LineResult): void {
    const progress = this.progressOf(result.repertoireId);
    const now = Date.now();
    if (!result.partial) {
      const lines = {
        ...progress.lines,
        [result.line.key]: nextLineRecord(progress.lines[result.line.key], result.flawless, now, this.settings().masteryCount, {
          firstDays: this.settings().firstReviewDays,
          growth: this.settings().reviewGrowth,
        }),
      };
      void this.saveProgress({ ...progress, lines });
    }

    const event: AttemptEvent = {
      repertoireId: progress.repertoireId,
      lineKey: result.line.key,
      at: now,
      day: dayKey(now),
      flawless: result.flawless,
      moves: result.moves,
      missed: result.missed,
      hints: result.hints,
      durationMs: result.durationMs,
    };
    this.events.update((events) => [...events, event]);
    this.now.set(now);
    this.touch();
    void this.db.add('events', event);
  }

  async updateSettings(patch: Partial<Settings>): Promise<void> {
    const settings = { ...this.settings(), ...patch };
    if (Object.keys(patch).some((key) => !VIEW_SETTINGS.has(key as keyof Settings))) {
      this.touch();
    }
    this.applySettings(settings);
    await this.db.put('settings', { key: SETTINGS_KEY, value: settings });
  }

  exportPgn(record: RepertoireRecord): string {
    const headers: Record<string, string> = { Event: record.name, Site: APP_NAME, [COLOUR_TAG]: record.side === 'white' ? 'White' : 'Black' };
    return writePgn(this.parse(record), { headers, comments: record.comments });
  }

  exportBackup(): Backup {
    return {
      app: 'opening-trainer',
      version: 1,
      exportedAt: new Date().toISOString(),
      repertoires: this.repertoires(),
      progress: Object.values(this.progress()),
      events: this.events(),
      settings: this.settings(),
      players: this.players(),
    };
  }

  async importBackup(json: string): Promise<void> {
    const backup = JSON.parse(json) as Partial<Backup>;
    if (backup.app !== 'opening-trainer' || !Array.isArray(backup.repertoires)) {
      throw new Error('not-a-backup');
    }
    const settings = { ...DEFAULT_SETTINGS, ...backup.settings };
    await this.db.replaceAll({
      repertoires: backup.repertoires,
      progress: backup.progress ?? [],
      events: backup.events ?? [],
      settings: [{ key: SETTINGS_KEY, value: settings }],
      players: backup.players ?? [],
    });
    this.players.set(backup.players ?? []);
    this.history.set([]);
    this.parsed.clear();
    this.repertoires.set(backup.repertoires);
    this.progress.set(Object.fromEntries((backup.progress ?? []).map((p) => [p.repertoireId, p])));
    this.events.set(backup.events ?? []);
    this.applySettings(settings);
  }

  async clearAll(): Promise<void> {
    await this.db.replaceAll({});
    this.parsed.clear();
    this.repertoires.set([]);
    this.progress.set({});
    this.events.set([]);
    this.players.set([]);
    this.history.set([]);
    this.applySettings({ ...DEFAULT_SETTINGS, language: this.settings().language });
  }

  private async loadOpenings(): Promise<void> {
    try {
      const response = await fetch('openings.json');
      if (response.ok) {
        this.openings.set((await response.json()) as OpeningBook);
      }
    } catch {
      // without the book lines are named after their moves
    }
  }

  /** The first version kept only the last PGN in localStorage; carry it over once. */
  private async importLegacyPgn(): Promise<void> {
    let pgn: string | null = null;
    try {
      const raw = localStorage.getItem(LEGACY_PGN_KEY);
      pgn = raw ? (JSON.parse(raw) as string) : null;
      localStorage.removeItem(LEGACY_PGN_KEY);
    } catch {
      return;
    }
    if (!pgn || this.repertoires().length > 0) {
      return;
    }
    try {
      const repertoire = parseRepertoire(pgn);
      const side = repertoire.suggestedSide ?? 'white';
      const name = (side === 'white' ? repertoire.headers['White'] : repertoire.headers['Black']) ?? repertoire.headers['Event'];
      await this.importPgn({ pgn, name: name && name !== '?' ? name : 'Repertoire', side, targetId: null });
    } catch {
      // unreadable legacy data is dropped
    }
  }

  /** Re-parses the repertoire, applies the change and stores the result as PGN; comment overrides and progress keep their keys. */
  private async edit(id: string, change: (repertoire: Repertoire) => boolean): Promise<boolean> {
    const record = this.repertoires().find((r) => r.id === id);
    if (!record) {
      return false;
    }
    const repertoire = parseRepertoire(record.pgn);
    if (!change(repertoire)) {
      return false;
    }
    const pgn = writePgn(repertoire, { headers: repertoire.headers });
    await this.remember('edit', record);
    await this.saveRepertoire({ ...record, pgn, updatedAt: Date.now() });
    return true;
  }

  private async remember(kind: HistoryEntry['kind'], record: RepertoireRecord, progress?: ProgressRecord): Promise<void> {
    const entry: HistoryEntry = { at: Date.now(), kind, record, progress, lines: this.linesOf(record).length };
    await this.saveHistory([entry, ...this.history()].slice(0, HISTORY_SIZE));
  }

  private async saveHistory(history: HistoryEntry[]): Promise<void> {
    this.history.set(history);
    await this.db.put('settings', { key: HISTORY_KEY, value: history });
  }

  private applySettings(settings: Settings): void {
    this.settings.set(settings);
    this.translations.setLocale(settings.language);
    document.documentElement.lang = settings.language;
  }

  private async saveRepertoire(record: RepertoireRecord): Promise<void> {
    this.repertoires.update((list) => (list.some((r) => r.id === record.id) ? list.map((r) => (r.id === record.id ? record : r)) : [...list, record]));
    this.touch();
    await this.db.put('repertoires', record);
  }

  private async saveProgress(progress: ProgressRecord): Promise<void> {
    this.progress.update((all) => ({ ...all, [progress.repertoireId]: progress }));
    this.touch();
    await this.db.put('progress', progress);
  }
}

function newId(): string {
  return crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function browserLanguage(): Language {
  const preferred = navigator.language?.toLowerCase().slice(0, 2);
  return LANGUAGES.find((language) => language.code === preferred)?.code ?? 'en';
}
