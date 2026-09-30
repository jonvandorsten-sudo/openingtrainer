import { Component, HostListener, OnDestroy, computed, effect, inject, untracked } from '@angular/core';
import { linesFrom } from '../../core/free-start';
import { TrainingLine, sideToColor } from '../../core/lines';
import { lineLikelihood } from '../../core/prep-generator';
import { openingAt } from '../../core/openings';
import { knownPrefixStart } from '../../core/progress';
import { QueueItem, SessionQueue, TrainingQueue, buildQueue, lineItem, randomQueue } from '../../core/queue';
import { MoveNode, formatMoves, moveNumber } from '../../core/repertoire';
import { TranslatePipe } from '../../pipes/translate.pipe';
import { AppStore } from '../../services/app-store.service';
import { boardEvaluation } from '../../services/board-evaluation';
import { EngineService } from '../../services/engine.service';
import { FreeSession, NavigationService } from '../../services/navigation.service';
import { TrainingController } from '../../services/training-controller';
import { ChessBoardComponent } from '../chess-board/chess-board.component';
import { EvalBarComponent } from '../eval-bar/eval-bar.component';
import { FeedbackBarComponent } from '../feedback-bar/feedback-bar.component';
import { FreeStartComponent } from '../free-start/free-start.component';
import { ModeTabsComponent } from '../shell/mode-tabs.component';

const NEXT_LINE_DELAY_MS = 900;

@Component({
  selector: 'app-train-view',
  standalone: true,
  imports: [ChessBoardComponent, EvalBarComponent, FeedbackBarComponent, FreeStartComponent, ModeTabsComponent, TranslatePipe],
  templateUrl: './train-view.component.html',
  styleUrl: './train-view.component.scss',
})
export class TrainViewComponent implements OnDestroy {
  readonly store = inject(AppStore);
  readonly nav = inject(NavigationService);
  readonly trainer = new TrainingController(this.store, (item, flawless) => this.finished(item, flawless));

  private queue: SessionQueue = new TrainingQueue([], false);
  /** The queue item behind each started item, which may start later in the line. */
  private readonly queued = new WeakMap<QueueItem, QueueItem>();
  private advanceTimer?: ReturnType<typeof setTimeout>;

  readonly freeStart = computed(() => this.nav.mode() === 'free' && this.nav.freeSession() === null);
  readonly orientation = this.trainer.orientation;
  readonly line = computed(() => this.trainer.item()?.line ?? null);
  /** The repertoire of the line being trained. */
  readonly repertoire = computed(() => this.store.find(this.trainer.item()?.repertoireId ?? null));
  readonly showRepertoireName = computed(() => this.store.scoped().length > 1);
  private readonly engine = inject(EngineService);
  private readonly bar = boardEvaluation(this.store, this.engine, this.trainer.current);
  readonly showEval = this.bar.visible;
  readonly evaluation = this.bar.evaluation;
  readonly comment = computed(() => {
    const node = this.trainer.current();
    const item = this.trainer.item();
    return node && item ? this.store.commentFor(item.repertoireId, node.key, node.comment) : '';
  });
  readonly queueEmpty = computed(() => this.store.active() !== null && this.trainer.item() === null);

  /** Line n of the session's lines in a free-start session, otherwise of the repertoire. */
  readonly lineNumber = computed(() => {
    const line = this.line();
    const session = this.nav.freeSession();
    const lines = session ? linesFrom(this.repertoire()?.lines ?? [], session.sans) : (this.repertoire()?.lines ?? []);
    return { n: line ? lines.indexOf(line) + 1 : 0, total: lines.length };
  });

  /** The opening reached so far while playing, so the title does not give away where the line goes; the full name once done. */
  readonly lineTitle = computed(() => {
    const line = this.line();
    if (!line) {
      return '';
    }
    if (this.trainer.done()) {
      return line.name;
    }
    return openingAt(this.trainer.current(), this.store.openings())?.name ?? line.group;
  });

  readonly lineEco = computed(() => {
    const line = this.line();
    if (!line || this.trainer.done()) {
      return line ? line.eco || line.group : '';
    }
    return openingAt(this.trainer.current(), this.store.openings())?.eco || line.group;
  });

  /** The pill above the line card while training from a free start. */
  readonly freeInfo = computed(() => {
    const session = this.nav.freeSession();
    const repertoire = this.store.find(session?.repertoireId ?? null);
    if (!session || !repertoire) {
      return null;
    }
    const lines = linesFrom(repertoire.lines, session.sans);
    const moves = formatMoves(lines[0]?.moves.slice(0, session.sans.length) ?? []);
    return { moves, lines: lines.length, name: repertoire.record.name };
  });

  private readonly queueKey = computed(() => {
    const scope = this.store.scoped().map((a) => `${a.record.id}:${a.record.pgn.length}`).join(',');
    const free = this.nav.freeSession();
    return `${scope}|${this.nav.mode()}|${this.nav.session()}|${this.store.openings() ? 1 : 0}|${free ? `${free.repertoireId}:${free.sans.join(' ')}` : ''}`;
  });

  constructor() {
    effect(() => {
      const key = this.queueKey();
      const pending = this.nav.pendingItem();
      untracked(() => this.rebuild(key, pending));
    });
  }

  ngOnDestroy(): void {
    clearTimeout(this.advanceTimer);
    this.trainer.destroy();
    this.engine.stop();
  }

  @HostListener('window:keydown', ['$event'])
  onKey(event: KeyboardEvent): void {
    if (this.freeStart() || (event.target instanceof HTMLElement && /INPUT|TEXTAREA|SELECT/.test(event.target.tagName))) {
      return;
    }
    const key = event.key.toLowerCase();
    if (key === 'h') {
      this.trainer.hint();
    } else if (key === 'r') {
      this.trainer.restart();
    } else if (event.key === 'ArrowRight') {
      if (this.trainer.done()) {
        this.next();
      } else {
        this.skip();
      }
    }
  }

  next(): void {
    clearTimeout(this.advanceTimer);
    const item = this.queue.peek();
    if (item) {
      this.start(item);
    } else {
      this.trainer.clear();
    }
  }

  skip(): void {
    const item = this.trainer.item();
    if (item && !this.trainer.done()) {
      this.queue.skip(this.queued.get(item) ?? item);
    }
    this.next();
  }

  trainEverything(): void {
    this.nav.startSession('all');
  }

  backToFreeStart(): void {
    this.nav.backToFreeStart();
  }

  /** Opens the position on the board in Explore. */
  openInExplore(): void {
    const item = this.trainer.item();
    if (item) {
      this.nav.boardOrientation.set(item.color === 'w' ? 'white' : 'black');
    }
    this.nav.explore(this.trainer.played().map((move) => move.san));
  }

  moveLabel(move: MoveNode, index: number): string {
    if (move.color === 'w') {
      return `${moveNumber(move)}.`;
    }
    return index === 0 ? `${moveNumber(move)}...` : '';
  }

  isMine(move: MoveNode): boolean {
    return move.color === this.trainer.item()?.color;
  }

  restOfLine(): string {
    return formatMoves(this.trainer.remaining());
  }

  /** Percentage chance that the prepared player walks into this line; null for ordinary repertoires. */
  likelihood(line: TrainingLine): number | null {
    const counts = this.repertoire()?.record.prep?.counts;
    return counts ? Math.round(100 * lineLikelihood(line.moves, counts)) : null;
  }

  private rebuild(key: string, pending: QueueItem | null): void {
    clearTimeout(this.advanceTimer);
    const free = this.nav.freeSession();
    if (!key || this.store.scoped().length === 0 || (this.nav.mode() === 'free' && !free)) {
      this.trainer.clear();
      return;
    }
    const mode = this.nav.mode();
    const sources = this.store.queueSources();
    if (free) {
      this.queue = new TrainingQueue(this.freeItems(free), false);
    } else if (mode === 'random') {
      this.queue = randomQueue(sources);
    } else {
      this.queue = new TrainingQueue(this.likelyFirst(buildQueue(mode, sources, Date.now())), mode === 'all');
    }
    if (pending) {
      this.nav.pendingItem.set(null);
      this.start(pending);
      return;
    }
    this.next();
  }

  /** Starts an item, with the opening moves you already know played for you when that is switched on. */
  private start(item: QueueItem): void {
    const started = this.withKnownMovesPlayed(item);
    this.queued.set(started, item);
    this.trainer.start(started);
  }

  private withKnownMovesPlayed(item: QueueItem): QueueItem {
    const settings = this.store.settings();
    if (!settings.autoPlayKnown || item.focus || item.startIndex > 0) {
      return item;
    }
    const start = knownPrefixStart(item.line, item.color, this.store.knownMoves(item.color), settings.masteryCount);
    return start > 0 ? { ...item, startIndex: start, autoStart: true } : item;
  }

  private freeItems(session: FreeSession): QueueItem[] {
    const repertoire = this.store.find(session.repertoireId);
    if (!repertoire) {
      return [];
    }
    const source = { id: repertoire.record.id, color: sideToColor(repertoire.record.side) };
    return linesFrom(repertoire.lines, session.sans).map((line) => lineItem(source, line, session.sans.length));
  }

  /** Against a prepared player, the lines they are most likely to play come first. */
  private likelyFirst(items: QueueItem[]): QueueItem[] {
    const countsOf = (item: QueueItem) => this.store.find(item.repertoireId)?.record.prep?.counts;
    if (!items.some((item) => countsOf(item))) {
      return items;
    }
    const chance = (item: QueueItem) => {
      const counts = countsOf(item);
      return counts ? lineLikelihood(item.line.moves, counts) : 0;
    };
    return [...items].sort((a, b) => chance(b) - chance(a));
  }

  private finished(item: QueueItem, flawless: boolean): void {
    this.queue.complete(this.queued.get(item) ?? item, flawless);
    if (flawless) {
      this.advanceTimer = setTimeout(() => this.next(), NEXT_LINE_DELAY_MS);
    }
  }
}
