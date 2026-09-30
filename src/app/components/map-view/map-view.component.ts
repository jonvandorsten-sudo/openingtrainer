import { Component, OnDestroy, OnInit, computed, effect, inject, signal, untracked } from '@angular/core';
import { TrainingLine } from '../../core/lines';
import { isDue, lineMastery, missRate } from '../../core/progress';
import { WEAK_THRESHOLD, drillItem } from '../../core/queue';
import { MoveNode, formatMoves, pathTo } from '../../core/repertoire';
import { TranslatePipe } from '../../pipes/translate.pipe';
import { ActiveRepertoire, AppStore } from '../../services/app-store.service';
import { boardEvaluation } from '../../services/board-evaluation';
import { EngineService } from '../../services/engine.service';
import { NavigationService } from '../../services/navigation.service';
import { TrainingController } from '../../services/training-controller';
import { TranslationService } from '../../services/translation.service';
import { SideSwatchComponent, masteryColor } from '../shell/side-swatch.component';
import { ChessBoardComponent } from '../chess-board/chess-board.component';
import { EvalBarComponent } from '../eval-bar/eval-bar.component';
import { FeedbackBarComponent } from '../feedback-bar/feedback-bar.component';

interface HeatCell {
  source: { id: string; color: 'w' | 'b' };
  node: MoveNode;
  line: TrainingLine;
  rate: number | null;
  bg: string;
  ink: string;
}

interface HeatGroup {
  active: ActiveRepertoire;
  mastery: number | null;
  open: boolean;
  rows: HeatRow[];
}

interface HeatRow {
  line: TrainingLine;
  mastery: number | null;
  due: boolean;
  cells: HeatCell[];
}

export const LEGEND = [
  { label: 'map.good', color: '#2f7d4e' },
  { label: 'map.ok', color: '#b9dcc4' },
  { label: 'map.shaky', color: '#ffe18a' },
  { label: 'map.weak', color: '#ef4d4a' },
  { label: 'map.new', color: '#e5e8e5' },
];

export function rateColors(rate: number | null): [string, string] {
  if (rate === null) {
    return ['#e5e8e5', 'rgba(0,0,0,0.45)'];
  }
  if (rate < 0.1) {
    return ['#2f7d4e', '#fff'];
  }
  if (rate < WEAK_THRESHOLD) {
    return ['#b9dcc4', '#14381f'];
  }
  if (rate < 0.32) {
    return ['#ffe18a', '#4a3105'];
  }
  return ['#ef4d4a', '#fff'];
}

export function masteryInk(mastery: number | null): string {
  if (mastery === null) {
    return 'rgba(0,0,0,0.45)';
  }
  return mastery >= 80 ? '#1f6b3f' : mastery >= 60 ? '#a86a00' : '#d32f2f';
}

@Component({
  selector: 'app-map-view',
  standalone: true,
  imports: [ChessBoardComponent, EvalBarComponent, FeedbackBarComponent, SideSwatchComponent, TranslatePipe],
  templateUrl: './map-view.component.html',
  styleUrl: './map-view.component.scss',
})
export class MapViewComponent implements OnInit, OnDestroy {
  readonly store = inject(AppStore);
  private readonly nav = inject(NavigationService);
  readonly trainer = new TrainingController(this.store, () => undefined);
  readonly legend = LEGEND;
  readonly masteryInk = masteryInk;

  private readonly i18n = inject(TranslationService);
  readonly masteryColor = masteryColor;
  readonly selected = signal<HeatCell | null>(null);
  readonly collapsed = signal<ReadonlySet<string>>(new Set());
  readonly orientation = this.trainer.orientation;
  private readonly engine = inject(EngineService);
  private readonly bar = boardEvaluation(this.store, this.engine, this.trainer.current);
  readonly showEval = this.bar.visible;
  readonly evaluation = this.bar.evaluation;

  readonly groups = computed<HeatGroup[]>(() => {
    const now = this.store.now();
    const collapsed = this.collapsed();
    return this.store.scoped().map((active) => {
      const progress = this.store.progressOf(active.record.id);
      const source = { id: active.record.id, color: active.color };
      const rows = active.lines.map((line) => ({
        line,
        mastery: lineMastery(line, active.color, progress.moves),
        due: isDue(progress.lines[line.key], now),
        cells: line.moves
          .filter((move) => move.color === active.color)
          .map((node) => {
            const rate = missRate(progress.moves[node.key]);
            const [bg, ink] = rateColors(rate);
            return { source, node, line, rate, bg, ink };
          }),
      }));
      return { active, mastery: this.store.masteryOf(active.record), open: !collapsed.has(active.record.id), rows };
    });
  });

  readonly rows = computed<HeatRow[]>(() => this.groups().flatMap((group) => group.rows));

  readonly columns = computed(() => Array.from({ length: Math.max(0, ...this.rows().map((r) => r.cells.length)) }, (_, i) => i + 1));

  readonly info = computed(() => {
    const cell = this.selected();
    if (!cell) {
      return null;
    }
    const record = this.store.progressOf(cell.source.id).moves[cell.node.key];
    const context = pathTo(cell.node).slice(0, -1);
    return {
      context: context.length ? formatMoves(context.slice(-8)) : '',
      attempts: record?.attempts ?? 0,
      misses: record?.misses ?? 0,
      rate: cell.rate,
    };
  });

  constructor() {
    effect(() => {
      const rows = this.rows();
      untracked(() => {
        const selected = this.selected();
        if (selected && !rows.some((row) => row.line === selected.line)) {
          const first = this.weakCells()[0] ?? rows[0]?.cells[0];
          if (first) {
            this.pick(first);
          } else {
            this.selected.set(null);
            this.trainer.clear();
          }
        }
      });
    });
  }

  ngOnInit(): void {
    const focus = this.nav.mapFocus();
    this.nav.mapFocus.set(null);
    const rows = this.rows();
    const row = rows.find((r) => r.line.key === focus);
    const first = row?.cells[0] ?? this.weakCells()[0] ?? rows[0]?.cells[0];
    if (first) {
      this.pick(first);
    }
  }

  ngOnDestroy(): void {
    this.trainer.destroy();
    this.engine.stop();
  }

  pick(cell: HeatCell): void {
    this.selected.set(cell);
    this.trainer.start(drillItem(cell.source, cell.line, cell.node));
  }

  restart(): void {
    const cell = this.selected();
    if (cell) {
      this.pick(cell);
    }
  }

  nextWeak(): void {
    const weak = this.weakCells();
    if (weak.length === 0) {
      return;
    }
    const current = this.selected();
    const index = weak.findIndex((c) => c.line === current?.line && c.node === current?.node);
    this.pick(weak[(index + 1) % weak.length]);
  }

  isSelected(cell: HeatCell): boolean {
    const current = this.selected();
    return current?.line === cell.line && current?.node === cell.node;
  }

  toggle(group: HeatGroup): void {
    const next = new Set(this.collapsed());
    if (group.open) {
      next.add(group.active.record.id);
    } else {
      next.delete(group.active.record.id);
    }
    this.collapsed.set(next);
  }

  groupLabel(group: HeatGroup): string {
    return this.i18n.translate('map.repHeader', { side: this.i18n.translate(`side.${group.active.record.side}`), n: group.active.lines.length, count: group.active.lines.length });
  }

  title(cell: HeatCell): string {
    return formatMoves([cell.node]);
  }

  private weakCells(): HeatCell[] {
    return this.rows().flatMap((row) => row.cells.filter((cell) => cell.rate !== null && cell.rate >= WEAK_THRESHOLD));
  }
}
