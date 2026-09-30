import { computed, signal } from '@angular/core';
import { DrawShape } from 'chessground/draw';
import { Key } from 'chessground/types';
import { BoardMove, BoardPosition } from '../components/chess-board/chess-board.component';
import { LineAttempt } from '../core/line-attempt';
import { QueueItem } from '../core/queue';
import { MoveNode } from '../core/repertoire';
import { AppStore } from './app-store.service';

export type FeedbackKind = 'idle' | 'turn' | 'wait' | 'ok' | 'bad' | 'alt' | 'hint1' | 'hint2' | 'done' | 'note' | 'warn' | 'known';

export interface Feedback {
  kind: FeedbackKind;
  san?: string;
  square?: string;
  count?: number;
  /** Ready-made text for the note and warn kinds. */
  text?: string;
  hints?: number;
}

const MAX_COUNTED_PAUSE_MS = 60_000;
const KNOWN_MOVE_MS = 250;
const KNOWN_MOVES_TOTAL_MS = 2500;
const KNOWN_MOVE_MIN_MS = 90;

/** Drives one board through a queue item: opponent replies, move judgement, hints, peeking and recording results. */
export class TrainingController {
  private attempt: LineAttempt | null = null;
  private timer?: ReturnType<typeof setTimeout>;
  private lastActivity = 0;
  private activeMs = 0;
  private missedMoves = 0;

  readonly item = signal<QueueItem | null>(null);
  readonly board = signal<BoardPosition>({ fen: '8/8/8/8/8/8/8/8 w - - 0 1', movable: false });
  readonly feedback = signal<Feedback>({ kind: 'idle' });
  readonly played = signal<MoveNode[]>([]);
  readonly remaining = signal<MoveNode[]>([]);
  readonly counters = signal({ correct: 0, mistakes: 0, hints: 0 });
  readonly done = signal(false);
  readonly peekOpen = signal(false);
  readonly current = signal<MoveNode | null>(null);
  readonly playing = computed(() => this.item() !== null && !this.done());
  readonly orientation = computed<'white' | 'black'>(() => (this.item()?.color === 'b' ? 'black' : 'white'));

  constructor(
    private readonly store: AppStore,
    private readonly onFinished: (item: QueueItem, flawless: boolean) => void,
  ) {}

  start(item: QueueItem): void {
    clearTimeout(this.timer);
    this.attempt = new LineAttempt(item.line, item.color, item.startIndex);
    this.item.set(item);
    this.done.set(false);
    this.peekOpen.set(false);
    this.feedback.set({ kind: 'idle' });
    this.activeMs = 0;
    this.missedMoves = 0;
    this.lastActivity = Date.now();
    if (item.autoStart && item.startIndex > 0) {
      this.replayKnownMoves(this.attempt);
      return;
    }
    this.refresh();
    this.continueLine();
  }

  /** Plays the known opening moves quickly from the start position, then hands over to the normal line. */
  private replayKnownMoves(attempt: LineAttempt): void {
    const moves = attempt.line.moves.slice(0, attempt.startIndex);
    const pace = Math.max(KNOWN_MOVE_MIN_MS, Math.min(KNOWN_MOVE_MS, KNOWN_MOVES_TOTAL_MS / moves.length));
    this.feedback.set({ kind: 'known' });
    const show = (count: number) => {
      const node = count === 0 ? attempt.line.root : moves[count - 1];
      this.board.set({ fen: node.fen, lastMove: node.from ? [node.from, node.to] : undefined, movable: false });
      this.current.set(node);
      this.played.set(moves.slice(0, count));
      this.remaining.set(attempt.line.moves.slice(count));
    };
    const step = (count: number) => {
      if (this.attempt !== attempt) {
        return;
      }
      if (count > moves.length) {
        this.refresh();
        this.continueLine();
        return;
      }
      show(count);
      this.timer = setTimeout(() => step(count + 1), pace);
    };
    this.syncCounters();
    step(0);
  }

  clear(): void {
    clearTimeout(this.timer);
    this.attempt = null;
    this.item.set(null);
    this.done.set(false);
    this.feedback.set({ kind: 'idle' });
  }

  destroy(): void {
    clearTimeout(this.timer);
  }

  restart(): void {
    const item = this.item();
    if (item) {
      this.start(item);
    }
  }

  move(move: BoardMove): void {
    const attempt = this.attempt;
    const result = attempt?.tryPlayerMove(move);
    if (!attempt || !result) {
      this.refresh();
      return;
    }
    this.touch();
    switch (result.verdict) {
      case 'correct':
        this.store.recordMove(this.item()!.repertoireId, result.expected.key, result.missed);
        if (result.missed) {
          this.missedMoves++;
        }
        this.feedback.set({ kind: 'ok', san: result.expected.san });
        this.refresh();
        this.continueLine();
        return;
      case 'alternative': {
        const played = attempt.currentNode.children.find((c) => c.from === move.from && c.to === move.to);
        this.feedback.set({ kind: 'alt', san: played?.san });
        this.refresh();
        return;
      }
      case 'wrong':
        this.feedback.set({ kind: 'bad', san: result.expected.san });
        this.refresh([arrow(result.expected, 'red')]);
        return;
    }
  }

  hint(): void {
    const step = this.attempt?.hint();
    if (!step) {
      return;
    }
    this.touch();
    if (step.level === 1) {
      this.feedback.set({ kind: 'hint1', square: step.square });
      this.refresh([], step.square);
    } else {
      this.feedback.set({ kind: 'hint2', san: step.move.san });
      this.refresh([arrow(step.move, 'green')]);
    }
  }

  togglePeek(): void {
    if (!this.attempt || this.done()) {
      return;
    }
    if (!this.peekOpen()) {
      this.attempt.peek();
    }
    this.peekOpen.update((open) => !open);
    this.syncCounters();
  }

  private continueLine(): void {
    const attempt = this.attempt!;
    if (attempt.isComplete) {
      this.complete(attempt);
      return;
    }
    const kind = this.feedback().kind;
    if (attempt.isPlayerTurn) {
      if (kind === 'idle' || kind === 'wait' || kind === 'done' || kind === 'known') {
        this.feedback.set({ kind: 'turn' });
      }
      return;
    }
    if (kind === 'idle' || kind === 'done' || kind === 'turn' || kind === 'known') {
      this.feedback.set({ kind: 'wait' });
    }
    this.timer = setTimeout(() => {
      attempt.playOpponentMove();
      this.feedback.set({ kind: 'turn' });
      this.refresh();
      this.continueLine();
    }, this.store.settings().replyDelayMs);
  }

  private complete(attempt: LineAttempt): void {
    const item = this.item()!;
    this.done.set(true);
    this.peekOpen.set(false);
    this.feedback.set({ kind: 'done', count: attempt.mistakes, hints: attempt.hints });
    this.refresh();
    this.store.recordLine({
      repertoireId: item.repertoireId,
      line: item.line,
      partial: item.startIndex > 0 && !item.autoStart,
      flawless: attempt.wasFlawless,
      moves: attempt.correct,
      missed: this.missedMoves,
      hints: attempt.hints,
      durationMs: this.activeMs,
    });
    this.onFinished(item, attempt.wasFlawless);
  }

  private touch(): void {
    const now = Date.now();
    this.activeMs += Math.min(now - this.lastActivity, MAX_COUNTED_PAUSE_MS);
    this.lastActivity = now;
  }

  private refresh(shapes: DrawShape[] = [], hintSquare?: string): void {
    const attempt = this.attempt;
    if (!attempt) {
      return;
    }
    const node = attempt.currentNode;
    this.board.set({
      fen: node.fen,
      lastMove: node.from ? [node.from, node.to] : undefined,
      movable: attempt.isPlayerTurn && !attempt.isComplete,
      shapes,
      hintSquare,
    });
    this.current.set(node);
    this.played.set(attempt.playedMoves);
    this.remaining.set(attempt.remainingMoves);
    this.syncCounters();
  }

  private syncCounters(): void {
    const attempt = this.attempt;
    if (attempt) {
      this.counters.set({ correct: attempt.correct, mistakes: attempt.mistakes, hints: attempt.hints });
    }
  }
}

function arrow(node: MoveNode, brush: string): DrawShape {
  return { orig: node.from as Key, dest: node.to as Key, brush };
}
