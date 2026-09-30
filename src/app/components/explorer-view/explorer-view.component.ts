import { Component, HostListener, OnDestroy, computed, effect, inject, signal, untracked } from '@angular/core';
import { Chess } from 'chess.js';
import { DrawShape } from 'chessground/draw';
import { Key } from 'chessground/types';
import { linesFrom } from '../../core/free-start';
import { GameFilter, ImportedGame, TimeClass, buildGameTree, filterGames, gamesAt, movesAt, playerColor, score } from '../../core/game-tree';
import { positionKey } from '../../core/openings';
import { PlayedMove, fenAfter, isLegalSan, replaySans, sanOfBoardMove, turnOf } from '../../core/played';
import { MoveNode, Side, nodeAt, startRoot } from '../../core/repertoire';
import { EngineLine } from '../../core/uci';
import { TranslatePipe } from '../../pipes/translate.pipe';
import { ActiveRepertoire, AppStore, PlayerRecord } from '../../services/app-store.service';
import { EngineService } from '../../services/engine.service';
import { ExplorerDatabase, ExplorerResult, LichessError, LichessService } from '../../services/lichess.service';
import { NavigationService } from '../../services/navigation.service';
import { ImportError, PlayerImportService } from '../../services/player-import.service';
import { PrepService } from '../../services/prep.service';
import { BoardMove, BoardPosition, ChessBoardComponent } from '../chess-board/chess-board.component';
import { EvalBarComponent } from '../eval-bar/eval-bar.component';
import { PlayerDialogComponent } from '../player-dialog/player-dialog.component';
import { PrepDialogComponent } from '../prep-dialog/prep-dialog.component';
import { SideSwatchComponent } from '../shell/side-swatch.component';
import { RepertoireEditorComponent } from './repertoire-editor.component';

export type Source = 'book' | ExplorerDatabase | `player:${string}`;

export interface SourceMove {
  san: string;
  games?: number;
  white?: number;
  draws?: number;
  black?: number;
  /** Share of the games at this position, 0–100. */
  share?: number;
  score?: number;
  label?: string;
  lastPlayed?: string;
}

/** A repertoire in scope that contains the current position. */
export interface RepertoireHere {
  active: ActiveRepertoire;
  node: MoveNode;
  lines: number;
  trainable: number;
  yourMove: boolean;
}

/** Opponent moves none of your repertoires of one colour answers here, and the repertoires they can be added to. */
export interface GapGroup {
  side: Side;
  gaps: SourceMove[];
  targets: RepertoireHere[];
}

interface ExplorerState {
  source: Source;
  filter: GameFilter;
  sans: string[];
  orientation?: 'white' | 'black';
}

const MULTI_PV = 3;
const EXPLORER_DEBOUNCE_MS = 400;
const MIN_GAP_SHARE = 5;
const MAX_GAPS = 3;
const STATE_SAVE_DELAY_MS = 500;
const TIME_CLASSES: TimeClass[] = ['bullet', 'blitz', 'rapid', 'classical', 'daily'];

@Component({
  selector: 'app-explorer-view',
  standalone: true,
  imports: [ChessBoardComponent, EvalBarComponent, PlayerDialogComponent, PrepDialogComponent, RepertoireEditorComponent, SideSwatchComponent, TranslatePipe],
  templateUrl: './explorer-view.component.html',
  styleUrl: './explorer-view.component.scss',
})
export class ExplorerViewComponent implements OnDestroy {
  readonly store = inject(AppStore);
  readonly lichess = inject(LichessService);
  private readonly engine = inject(EngineService);
  readonly nav = inject(NavigationService);
  readonly importer = inject(PlayerImportService);
  readonly prep = inject(PrepService);
  readonly timeClasses = TIME_CLASSES;

  private readonly redo = signal<string[]>([]);
  readonly source = signal<Source>('book');
  readonly playerDialog = signal(false);
  readonly prepDialog = signal(false);
  readonly filter = signal<GameFilter>({ color: 'white', timeClasses: [], since: '' });
  readonly explorer = signal<ExplorerResult | null>(null);
  readonly explorerError = signal<LichessError['kind'] | null>(null);
  readonly explorerLoading = signal(false);
  readonly explorerStatus = signal<number | null>(null);
  readonly busy = signal(false);
  readonly updateMessage = signal<{ key: string; n?: number } | null>(null);
  private restored = false;
  private stateTimer?: ReturnType<typeof setTimeout>;
  private explorerTimer?: ReturnType<typeof setTimeout>;

  readonly path = computed<PlayedMove[]>(() => replaySans(this.nav.workPosition()));
  readonly sans = computed(() => this.path().map((p) => p.san));
  readonly fen = computed(() => fenAfter(this.path()));
  readonly turn = computed(() => turnOf(this.fen()));
  readonly orientation = this.nav.boardOrientation;

  /** The repertoire being edited, when edit mode is on and the repertoire still exists. */
  readonly editTarget = computed(() => this.store.find(this.nav.editTarget()));

  readonly board = computed<BoardPosition>(() => {
    const last = this.path().at(-1);
    return { fen: this.fen(), lastMove: last ? [last.from, last.to] : undefined, movable: true, shapes: this.arrows() };
  });

  /** The most specific named opening on the way to the position; none at the start position. */
  readonly opening = computed(() => {
    const book = this.store.openings();
    const path = this.path();
    if (!book) {
      return null;
    }
    for (let i = path.length - 1; i >= 0; i--) {
      const entry = book[positionKey(path[i].fen)];
      if (entry?.[1]) {
        return { eco: entry[0], name: entry[1] };
      }
    }
    return null;
  });

  readonly engineLines = computed(() => {
    const evaluation = this.engine.evaluation();
    if (!evaluation || evaluation.fen !== this.fen()) {
      return [];
    }
    return evaluation.lines.map((line) => ({ ...line, sans: uciToSans(this.fen(), line.pv).slice(0, 8) }));
  });

  readonly evaluation = computed(() => {
    const evaluation = this.engine.evaluation();
    if (!evaluation || evaluation.fen !== this.fen()) {
      return null;
    }
    return { value: evaluation.value, depth: evaluation.depth, mate: evaluation.mate, source: 'engine' as const, targetDepth: evaluation.done ? undefined : evaluation.targetDepth };
  });

  readonly player = computed<PlayerRecord | null>(() => {
    const source = this.source();
    return source.startsWith('player:') ? (this.store.players().find((p) => p.id === source.slice(7)) ?? null) : null;
  });

  readonly playerGames = computed(() => {
    const player = this.player();
    return player ? filterGames(player.games, player.username, this.filter()) : [];
  });

  private readonly playerTree = computed(() => {
    const player = this.player();
    return player ? buildGameTree(this.playerGames(), player.username) : null;
  });

  /** The colour you play against the prepared player: the opposite of theirs. */
  readonly prepSide = computed<'white' | 'black'>(() => (this.filter().color === 'white' ? 'black' : 'white'));

  /** Moves from the chosen source, without the repertoire moves the source does not know. */
  private readonly sourceMoves = computed<SourceMove[]>(() => {
    const source = this.source();
    if (source === 'book') {
      return this.bookMoves();
    }
    if (source === 'masters' || source === 'lichess') {
      const result = this.explorer();
      if (!result) {
        return [];
      }
      const total = result.moves.reduce((sum, m) => sum + m.white + m.draws + m.black, 0);
      return result.moves.map((m) => {
        const games = m.white + m.draws + m.black;
        return { san: m.san, games, white: m.white, draws: m.draws, black: m.black, share: total ? (100 * games) / total : 0, label: m.averageRating ? `Ø ${m.averageRating}` : undefined };
      });
    }
    const tree = this.playerTree();
    if (!tree) {
      return [];
    }
    const stats = movesAt(tree, this.fen());
    const total = stats.reduce((sum, m) => sum + m.games, 0);
    const playerIsWhite = this.filter().color === 'white';
    return stats.map((m) => ({
      san: m.san,
      games: m.games,
      white: playerIsWhite ? m.wins : m.losses,
      draws: m.draws,
      black: playerIsWhite ? m.losses : m.wins,
      share: total ? (100 * m.games) / total : 0,
      score: score(m),
      lastPlayed: m.lastPlayed,
    }));
  });

  /** Every repertoire in scope with lines through the position. */
  readonly here = computed<RepertoireHere[]>(() => {
    const sans = this.sans();
    const turn = this.turn();
    const result: RepertoireHere[] = [];
    for (const active of this.store.scoped()) {
      const node = sans.length === 0 ? startRoot(active.repertoire) : nodeAt(active.repertoire, sans);
      const lines = !node ? 0 : sans.length === 0 ? active.lines.length : active.lines.filter((line) => line.moves.includes(node)).length;
      if (node && lines > 0) {
        result.push({ active, node, lines, trainable: linesFrom(active.lines, sans).length, yourMove: turn === active.color });
      }
    }
    return result;
  });

  /** Per colour, once: opponent moves often played here that none of your repertoires of that colour answers. */
  readonly gapGroups = computed<GapGroup[]>(() => {
    const sans = this.sans();
    if (sans.length === 0) {
      return [];
    }
    const moves = this.sourceMoves();
    return (['white', 'black'] as Side[])
      .map((side) => {
        const targets = this.here().filter((h) => h.active.record.side === side && !h.yourMove);
        const covered = new Set(this.coveredByColour(side, sans));
        const gaps = targets.length === 0 ? [] : moves.filter((m) => !covered.has(m.san) && (m.share ?? 0) >= MIN_GAP_SHARE).sort((a, b) => (b.games ?? 0) - (a.games ?? 0)).slice(0, MAX_GAPS);
        return { side, gaps, targets };
      })
      .filter((group) => group.gaps.length > 0);
  });

  /** The repertoire each colour's gaps are added to; the first one that has the position unless chosen otherwise. */
  readonly gapTarget = signal<Partial<Record<Side, string>>>({});

  gapTargetOf(group: GapGroup): RepertoireHere {
    return group.targets.find((h) => h.active.record.id === this.gapTarget()[group.side]) ?? group.targets[0];
  }

  chooseGapTarget(side: Side, id: string): void {
    this.gapTarget.update((targets) => ({ ...targets, [side]: id }));
  }

  /** Moves at the position that any of your repertoires of that colour already contains, in or out of scope. */
  private coveredByColour(side: 'white' | 'black', sans: string[]): string[] {
    return this.store
      .repertoires()
      .filter((record) => record.side === side)
      .flatMap((record) => nodeAt(this.store.parse(record), sans)?.children.map((child) => child.san) ?? []);
  }

  readonly hereLines = computed(() => this.here().reduce((sum, h) => sum + h.lines, 0));

  /** The target repertoire's node at the position in edit mode, or null when the position is new to it. */
  private readonly targetNode = computed(() => {
    const target = this.editTarget();
    return target ? nodeAt(target.repertoire, this.sans()) : null;
  });

  readonly moves = computed<SourceMove[]>(() => {
    const moves = [...this.sourceMoves()];
    const known = new Set([...this.here().flatMap((h) => h.node.children), ...(this.targetNode()?.children ?? [])].map((child) => child.san));
    for (const san of known) {
      if (!moves.some((m) => m.san === san)) {
        moves.push({ san, share: 0 });
      }
    }
    return moves;
  });

  readonly games = computed(() => {
    const player = this.player();
    const tree = this.playerTree();
    if (player && tree) {
      const byId = new Map(player.games.map((g) => [g.id, g]));
      return [...new Set(gamesAt(tree, this.fen()))]
        .map((id) => byId.get(id))
        .filter((g): g is ImportedGame => !!g)
        .sort((a, b) => b.date.localeCompare(a.date))
        .slice(0, 12)
        .map((g) => ({ url: g.url, white: g.white, black: g.black, whiteElo: g.whiteElo, blackElo: g.blackElo, result: g.result === '1/2-1/2' ? '½-½' : g.result, date: g.date }));
    }
    return (this.explorer()?.topGames ?? []).map((g) => ({
      url: `https://lichess.org/${g.id}`,
      white: g.white,
      black: g.black,
      whiteElo: g.whiteRating,
      blackElo: g.blackRating,
      result: g.winner === 'white' ? '1-0' : g.winner === 'black' ? '0-1' : '½-½',
      date: g.year ? String(g.year) : '',
    }));
  });

  private readonly arrows = computed<DrawShape[]>(() => {
    const best = this.engineLines()[0]?.pv[0];
    return best ? [{ orig: best.slice(0, 2) as Key, dest: best.slice(2, 4) as Key, brush: 'blue' }] : [];
  });

  constructor() {
    void this.restoreState();
    effect(() => {
      const state: ExplorerState = { source: this.source(), filter: this.filter(), sans: this.sans(), orientation: this.orientation() };
      if (this.restored) {
        clearTimeout(this.stateTimer);
        this.stateTimer = setTimeout(() => void this.store.saveViewState('explorer', state), STATE_SAVE_DELAY_MS);
      }
    });
    effect(() => {
      const id = this.importer.completed();
      if (id) {
        untracked(() => {
          this.importer.completed.set(null);
          this.selectPlayer(id);
        });
      }
    });
    effect(() => {
      const fen = this.fen();
      if (this.store.settings().showEval && !this.prep.job()) {
        this.engine.analyze(fen, this.store.settings().engineDepth, MULTI_PV);
      }
    });
    effect(() => {
      const source = this.source();
      const fen = this.fen();
      const loggedIn = this.lichess.loggedIn();
      const paused = this.lichess.pauseSeconds() > 0;
      clearTimeout(this.explorerTimer);
      this.explorerTimer = setTimeout(() => untracked(() => this.loadExplorer(source, fen, loggedIn, paused)), EXPLORER_DEBOUNCE_MS);
    });
  }

  ngOnDestroy(): void {
    clearTimeout(this.explorerTimer);
    clearTimeout(this.stateTimer);
    this.engine.stop();
  }

  @HostListener('window:keydown', ['$event'])
  onKey(event: KeyboardEvent): void {
    if (event.target instanceof HTMLElement && /INPUT|TEXTAREA|SELECT/.test(event.target.tagName)) {
      return;
    }
    if (event.key === 'ArrowLeft') {
      this.back();
    } else if (event.key === 'ArrowRight') {
      this.forward();
    }
  }

  onBoardMove(move: BoardMove): void {
    const san = sanOfBoardMove(this.fen(), move.from, move.to);
    if (san) {
      this.push(san);
    } else {
      this.nav.workPosition.set([...this.sans()]);
    }
  }

  play(san: string): void {
    if (isLegalSan(this.fen(), san)) {
      this.push(san);
    }
  }

  back(): void {
    const sans = this.sans();
    if (sans.length > 0) {
      this.redo.set([sans.at(-1)!, ...this.redo()]);
      this.nav.workPosition.set(sans.slice(0, -1));
    }
  }

  forward(): void {
    const [next, ...rest] = this.redo();
    if (next) {
      this.nav.workPosition.set([...this.sans(), next]);
      this.redo.set(rest);
    }
  }

  goTo(index: number): void {
    const sans = this.sans();
    this.redo.set([...sans.slice(index + 1), ...this.redo()]);
    this.nav.workPosition.set(sans.slice(0, index + 1));
  }

  reset(): void {
    this.redo.set([...this.sans(), ...this.redo()]);
    this.nav.workPosition.set([]);
  }

  flip(): void {
    this.orientation.set(this.orientation() === 'white' ? 'black' : 'white');
  }

  selectSource(source: Source): void {
    if (source.startsWith('player:') && !this.source().startsWith('player:')) {
      this.setFilter({ color: this.orientation() === 'white' ? 'black' : 'white' });
    }
    this.source.set(source);
    if (source.startsWith('player:')) {
      this.orientation.set(this.prepSide());
    }
  }

  selectPlayer(id: string): void {
    this.selectSource(`player:${id}`);
  }

  setFilter(patch: Partial<GameFilter>): void {
    this.filter.update((f) => ({ ...f, ...patch }));
    if (this.player()) {
      this.orientation.set(this.prepSide());
    }
  }

  async updatePlayer(): Promise<void> {
    const player = this.player();
    if (!player) {
      return;
    }
    this.updateMessage.set(null);
    try {
      const added = await this.importer.update(player);
      this.updateMessage.set({ key: 'ex.updated', n: added });
    } catch (error) {
      this.updateMessage.set({ key: `pl.error.${error instanceof ImportError ? error.kind : 'network'}` });
    }
  }

  toggleTimeClass(timeClass: TimeClass): void {
    const current = this.filter().timeClasses;
    this.setFilter({ timeClasses: current.includes(timeClass) ? current.filter((t) => t !== timeClass) : [...current, timeClass] });
  }

  /** Number of repertoires in scope that play or answer this move here. */
  repertoireCount(san: string): number {
    return this.here().filter((h) => h.node.children.some((child) => child.san === san)).length;
  }

  isGap(san: string): boolean {
    return this.gapGroups().some((group) => group.gaps.some((gap) => gap.san === san));
  }

  /** In edit mode: whether the book move is not yet a continuation in the edited repertoire. */
  canAdd(san: string): boolean {
    return !!this.editTarget() && !this.targetNode()?.children.some((child) => child.san === san);
  }

  async addToTarget(san: string, event: Event): Promise<void> {
    event.stopPropagation();
    const target = this.editTarget();
    if (target && (await this.run(() => this.store.addLine(target.record.id, [...this.sans(), san])))) {
      this.nav.notify(this.turn() === target.color ? 'edit.saved' : 'edit.savedOpp');
    }
  }

  async addGap(group: GapGroup, san: string): Promise<void> {
    if (await this.run(() => this.store.addLine(this.gapTargetOf(group).active.record.id, [...this.sans(), san]))) {
      this.nav.notify('edit.savedOpp');
    }
  }

  async addAllGaps(group: GapGroup): Promise<void> {
    const replies = group.gaps.map((gap) => gap.san);
    if (await this.run(() => this.store.addReplies(this.gapTargetOf(group).active.record.id, this.sans(), replies))) {
      this.nav.notify('edit.changed', replies.length);
    }
  }

  async undo(): Promise<void> {
    this.nav.toast.set(null);
    await this.store.undoLastChange();
  }

  trainHere(here: RepertoireHere): void {
    this.nav.trainFrom(here.active.record.id, this.sans());
  }

  async openInRepertoire(here: RepertoireHere): Promise<void> {
    await this.store.focusRepertoire(here.active.record.id);
    this.nav.openInRepertoire(this.sans());
  }

  edit(here: RepertoireHere): void {
    this.nav.startEdit(here.active.record.id, this.sans(), here.active.record.side);
  }

  async createRepertoire(): Promise<void> {
    const sans = this.sans();
    const side = this.orientation();
    let id: string | null = null;
    await this.run(async () => {
      const record = await this.store.createRepertoire(this.opening()?.name ?? 'Nieuw repertoire', side);
      id = record.id;
      return sans.length === 0 || this.store.addLine(record.id, sans);
    });
    if (id) {
      this.nav.startEdit(id, sans, side);
    }
  }

  moveNumber(index: number): string {
    const ply = index + 1;
    return ply % 2 === 1 ? `${(ply + 1) / 2}.` : '';
  }

  percent(part: number | undefined, total: number | undefined): number {
    return total ? Math.round((100 * (part ?? 0)) / total) : 0;
  }

  formatEval(line: EngineLine): string {
    if (line.mate !== undefined) {
      return line.mate > 0 ? `#${line.mate}` : `-#${-line.mate}`;
    }
    return `${line.value >= 0 ? '+' : ''}${line.value.toFixed(2)}`;
  }

  opponentOf(game: { white: string; black: string }): string {
    const player = this.player();
    if (!player) {
      return `${game.white} - ${game.black}`;
    }
    return playerColor({ ...game, id: '', url: '', result: '*', date: '', timeClass: 'blitz', rated: false, moves: [] }, player.username) === 'white' ? game.black : game.white;
  }

  private bookMoves(): SourceMove[] {
    const book = this.store.openings();
    const chess = new Chess(this.fen());
    const result: SourceMove[] = [];
    for (const move of chess.moves({ verbose: true })) {
      const entry = book?.[positionKey(move.after)];
      if (entry) {
        result.push({ san: move.san, label: entry[1] ? `${entry[0]} ${entry[1]}` : undefined, games: entry[2] ?? 1 });
      }
    }
    const total = result.reduce((sum, m) => sum + (m.games ?? 0), 0);
    result.forEach((m) => (m.share = total ? (100 * (m.games ?? 0)) / total : 0));
    return result.sort((a, b) => (b.games ?? 0) - (a.games ?? 0));
  }

  private async loadExplorer(source: Source, fen: string, loggedIn: boolean, paused: boolean): Promise<void> {
    if (source !== 'masters' && source !== 'lichess') {
      this.explorer.set(null);
      this.explorerError.set(null);
      return;
    }
    if (!loggedIn) {
      this.explorer.set(null);
      this.explorerError.set('auth');
      return;
    }
    if (paused) {
      this.explorerError.set('rate-limit');
      return;
    }
    this.explorerLoading.set(true);
    this.explorerError.set(null);
    try {
      const result = await this.lichess.explore(source, fen);
      if (this.fen() === fen && this.source() === source) {
        this.explorer.set(result);
      }
    } catch (error) {
      this.explorer.set(null);
      this.explorerError.set(error instanceof LichessError ? error.kind : 'network');
      this.explorerStatus.set(error instanceof LichessError ? (error.status ?? null) : null);
    } finally {
      this.explorerLoading.set(false);
    }
  }

  /** Restores the source and filter; the position itself is shared with free start and only restored on the first visit. */
  private async restoreState(): Promise<void> {
    const state = await this.store.loadViewState<ExplorerState>('explorer');
    if (state) {
      const exists = !state.source.startsWith('player:') || this.store.players().some((p) => `player:${p.id}` === state.source);
      this.source.set(exists ? state.source : 'book');
      this.filter.set(state.filter);
      if (!this.nav.positionRestored) {
        this.nav.positionRestored = true;
        if (this.nav.workPosition().length === 0) {
          this.nav.workPosition.set(state.sans);
          if (state.orientation) {
            this.orientation.set(state.orientation);
          }
        }
      }
    }
    this.nav.positionRestored = true;
    this.restored = true;
  }

  private push(san: string): void {
    const [next, ...rest] = this.redo();
    this.redo.set(next === san ? rest : []);
    this.nav.workPosition.set([...this.sans(), san]);
  }

  private async run(action: () => Promise<boolean>): Promise<boolean> {
    this.busy.set(true);
    try {
      return await action();
    } finally {
      this.busy.set(false);
    }
  }
}

function uciToSans(fen: string, pv: string[]): string[] {
  const chess = new Chess(fen);
  const sans: string[] = [];
  for (const uci of pv) {
    try {
      sans.push(chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }).san);
    } catch {
      break;
    }
  }
  return sans;
}
