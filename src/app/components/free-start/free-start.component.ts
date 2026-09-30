import { Component, HostListener, OnDestroy, computed, inject, signal } from '@angular/core';
import { NextMove, linesFrom, nextMoves } from '../../core/free-start';
import { TrainingLine } from '../../core/lines';
import { fenAfter, isLegalSan, replaySans, sanOfBoardMove, turnOf } from '../../core/played';
import { Side } from '../../core/repertoire';
import { TranslatePipe } from '../../pipes/translate.pipe';
import { ActiveRepertoire, AppStore } from '../../services/app-store.service';
import { positionEvaluation } from '../../services/board-evaluation';
import { EngineService } from '../../services/engine.service';
import { NavigationService } from '../../services/navigation.service';
import { Feedback } from '../../services/training-controller';
import { TranslationService } from '../../services/translation.service';
import { BoardMove, BoardPosition, ChessBoardComponent } from '../chess-board/chess-board.component';
import { EvalBarComponent } from '../eval-bar/eval-bar.component';
import { FeedbackBarComponent } from '../feedback-bar/feedback-bar.component';
import { SideSwatchComponent, masteryColor } from '../shell/side-swatch.component';

type SideFilter = 'all' | Side;

interface FreeMatch {
  active: ActiveRepertoire;
  lines: TrainingLine[];
  next: NextMove[];
  yourMove: boolean;
  mastery: number | null;
}

/** Free start: play moves for both colours and see which repertoires still have lines from the position. */
@Component({
  selector: 'app-free-start',
  standalone: true,
  imports: [ChessBoardComponent, EvalBarComponent, FeedbackBarComponent, SideSwatchComponent, TranslatePipe],
  templateUrl: './free-start.component.html',
  styleUrl: './free-start.component.scss',
})
export class FreeStartComponent implements OnDestroy {
  readonly store = inject(AppStore);
  readonly nav = inject(NavigationService);
  private readonly engine = inject(EngineService);
  private readonly i18n = inject(TranslationService);
  readonly masteryColor = masteryColor;
  readonly MAX_NEXT = 8;

  readonly filter = signal<SideFilter>('all');
  readonly played = computed(() => replaySans(this.nav.workPosition()));
  readonly sans = computed(() => this.played().map((move) => move.san));
  readonly fen = computed(() => fenAfter(this.played()));
  readonly turn = computed(() => turnOf(this.fen()));
  readonly orientation = this.nav.boardOrientation;

  private readonly bar = positionEvaluation(this.store, this.engine, this.fen);
  readonly showEval = this.bar.visible;
  readonly evaluation = this.bar.evaluation;

  readonly board = computed<BoardPosition>(() => {
    const last = this.played().at(-1);
    return { fen: this.fen(), lastMove: last ? [last.from, last.to] : undefined, movable: true };
  });

  readonly matches = computed<FreeMatch[]>(() => {
    const sans = this.sans();
    const filter = this.filter();
    return this.store
      .scoped()
      .filter((active) => filter === 'all' || active.record.side === filter)
      .map((active) => {
        const lines = linesFrom(active.lines, sans);
        return { active, lines, next: nextMoves(lines, sans.length), yourMove: this.turn() === active.color, mastery: this.store.masteryOf(active.record) };
      })
      .filter((match) => match.lines.length > 0);
  });

  readonly lineTotal = computed(() => this.matches().reduce((sum, match) => sum + match.lines.length, 0));

  readonly feedback = computed<Feedback>(() => {
    const side = this.i18n.translate(this.turn() === 'w' ? 'side.white' : 'side.black');
    return this.matches().length > 0
      ? { kind: 'note', text: this.i18n.translate('free.status', { side, lines: this.lineTotal(), reps: this.matches().length }) }
      : { kind: 'warn', text: this.i18n.translate('free.statusNone', { side }) };
  });

  ngOnDestroy(): void {
    this.engine.stop();
  }

  @HostListener('window:keydown', ['$event'])
  onKey(event: KeyboardEvent): void {
    if (event.target instanceof HTMLElement && /INPUT|TEXTAREA|SELECT/.test(event.target.tagName)) {
      return;
    }
    if (event.key === 'ArrowLeft') {
      this.undo();
    }
  }

  onBoardMove(move: BoardMove): void {
    const san = sanOfBoardMove(this.fen(), move.from, move.to);
    if (san) {
      this.nav.workPosition.set([...this.sans(), san]);
    } else {
      this.nav.workPosition.set([...this.sans()]);
    }
  }

  play(san: string): void {
    if (isLegalSan(this.fen(), san)) {
      this.nav.workPosition.set([...this.sans(), san]);
    }
  }

  undo(): void {
    this.nav.workPosition.set(this.sans().slice(0, -1));
  }

  reset(): void {
    this.nav.workPosition.set([]);
  }

  flip(): void {
    this.orientation.set(this.orientation() === 'white' ? 'black' : 'white');
  }

  train(match: FreeMatch): void {
    this.nav.trainFrom(match.active.record.id, this.sans());
  }

  explore(): void {
    this.nav.explore(this.sans());
  }

  moveNumber(index: number): string {
    return index % 2 === 0 ? `${index / 2 + 1}.` : '';
  }

  subtitle(match: FreeMatch): string {
    const side = this.i18n.translate(`side.${match.active.record.side}`);
    return `${side} · ${this.i18n.translate('free.linesCount', { n: match.lines.length, count: match.lines.length })}`;
  }
}
