import { Component, ElementRef, HostListener, afterRenderEffect, computed, effect, inject, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TrainingLine, representativeLine } from '../../core/lines';
import { lineItem } from '../../core/queue';
import { MoveNode, Side, formatMoves, mainContinuation, moveNumber, nodeAt, pathTo, startRoot } from '../../core/repertoire';
import { TreeRow, rowMoves, treeRows, visibleTreeRows } from '../../core/tree-rows';
import { TranslatePipe } from '../../pipes/translate.pipe';
import { AppStore, RepertoireRecord } from '../../services/app-store.service';
import { NavigationService } from '../../services/navigation.service';
import { TranslationService } from '../../services/translation.service';
import { BoardPosition, ChessBoardComponent } from '../chess-board/chess-board.component';
import { masteryInk } from '../map-view/map-view.component';
import { SideSwatchComponent, masteryColor } from '../shell/side-swatch.component';

interface BranchChoice {
  options: { node: MoveNode; lines: number }[];
  selected: number;
}

@Component({
  selector: 'app-repertoire-view',
  standalone: true,
  imports: [ChessBoardComponent, FormsModule, SideSwatchComponent, TranslatePipe],
  templateUrl: './repertoire-view.component.html',
  styleUrl: './repertoire-view.component.scss',
})
export class RepertoireViewComponent {
  readonly store = inject(AppStore);
  private readonly nav = inject(NavigationService);
  private readonly i18n = inject(TranslationService);
  readonly masteryInk = masteryInk;
  readonly masteryColor = masteryColor;
  readonly rowMoves = rowMoves;

  private readonly host = inject(ElementRef<HTMLElement>);
  readonly query = signal('');
  readonly path = signal<MoveNode[]>([]);
  readonly index = signal(0);
  readonly menuFor = signal<string | null>(null);
  readonly editing = signal(false);
  readonly draft = signal('');
  /** Rows (keyed by their last move) whose continuation is folded away. */
  readonly collapsed = signal<ReadonlySet<string>>(new Set());
  /** The continuations to choose from when stepping forward reaches a branch. */
  readonly choice = signal<BranchChoice | null>(null);

  readonly active = this.store.active;
  readonly orientation = computed(() => this.active()?.record.side ?? 'white');

  readonly groups = computed(() =>
    (['white', 'black'] as Side[])
      .map((side) => ({ side, records: this.store.scoped().filter((a) => a.record.side === side).map((a) => a.record) }))
      .filter((group) => group.records.length > 0),
  );

  readonly rows = computed<TreeRow[]>(() => {
    const active = this.active();
    return active ? treeRows(active.repertoire, active.lines, active.color, this.store.progressOf(active.record.id).moves) : [];
  });

  readonly visibleRows = computed(() => {
    const query = this.query().trim().toLowerCase();
    return query ? this.rows().filter((row) => row.text.toLowerCase().includes(query)) : visibleTreeRows(this.rows(), this.collapsed());
  });

  readonly current = computed<MoveNode | null>(() => this.path()[this.index() - 1] ?? null);

  readonly selectedEnd = computed<MoveNode | null>(() => {
    const ends = new Set(this.rows().map((row) => row.end));
    const played = this.path().slice(0, Math.max(1, this.index()));
    return [...played].reverse().find((node) => ends.has(node)) ?? null;
  });

  readonly line = computed<TrainingLine | null>(() => {
    const path = this.path();
    const last = path[path.length - 1];
    return this.active()?.lines.find((line) => line.moves[line.moves.length - 1] === last) ?? null;
  });

  readonly board = computed<BoardPosition>(() => {
    const node = this.current();
    const root = this.active()?.repertoire.roots[0];
    return {
      fen: node?.fen ?? root?.fen ?? '8/8/8/8/8/8/8/8 w - - 0 1',
      lastMove: node ? [node.from, node.to] : undefined,
      movable: false,
    };
  });

  readonly comment = computed(() => {
    const node = this.current();
    const id = this.active()?.record.id;
    return node && id ? this.store.commentFor(id, node.key, node.comment) : '';
  });

  constructor() {
    afterRenderEffect(() => {
      this.active();
      this.host.nativeElement.querySelector('.folder.on')?.scrollIntoView({ block: 'nearest' });
    });
    effect(() => {
      const active = this.active();
      untracked(() => {
        if (active && !this.path().every((node) => active.lines.some((l) => l.moves.includes(node)))) {
          this.path.set([]);
        }
        const requested = this.nav.repertoirePath();
        if (active && requested) {
          this.nav.repertoirePath.set(null);
          this.openAt(requested);
          return;
        }
        const first = active && this.path().length === 0 ? representativeLine(active.lines) : null;
        if (first) {
          this.path.set(first.moves);
          this.index.set(Math.min(6, first.moves.length));
        }
      });
    });
  }

  @HostListener('window:keydown', ['$event'])
  onKey(event: KeyboardEvent): void {
    if (event.target instanceof HTMLElement && /INPUT|TEXTAREA|SELECT/.test(event.target.tagName)) {
      return;
    }
    if (this.choice()) {
      this.onChoiceKey(event);
      return;
    }
    if (event.key === 'ArrowRight') {
      this.forward();
    } else if (event.key === 'ArrowLeft') {
      this.step(-1);
    }
  }

  selectRow(row: TreeRow): void {
    const line = this.active()?.lines.find((l) => l.moves.includes(row.end));
    const path = line?.moves ?? pathTo(row.end);
    this.path.set(path);
    this.index.set(path.indexOf(row.end) + 1);
    this.editing.set(false);
  }


  /** Shows the position after one move, on the line being viewed when it passes through the move. */
  selectNode(node: MoveNode): void {
    const current = this.path();
    const path = current.includes(node) ? current : (this.active()?.lines.find((l) => l.moves.includes(node))?.moves ?? pathTo(node));
    this.path.set(path);
    this.index.set(path.indexOf(node) + 1);
    this.editing.set(false);
  }

  currentMoveLabel(node: MoveNode): string {
    return formatMoves([node]);
  }

  currentLabel(): string {
    const node = this.current();
    return node ? formatMoves([node]) : '';
  }

  /** Deletes the chosen move and everything after it; the view stays at the position before it. */
  async removeCurrent(): Promise<void> {
    const node = this.current();
    const active = this.active();
    if (!node?.parent || !active) {
      return;
    }
    const lines = active.lines.filter((line) => line.moves.includes(node)).length;
    if (!this.nav.confirmDelete(formatMoves([node]), lines)) {
      return;
    }
    this.nav.repertoirePath.set(pathTo(node.parent).map((move) => move.san));
    if (await this.store.removeMove(active.record.id, node.key)) {
      this.nav.notifyRemoved(lines);
    } else {
      this.nav.repertoirePath.set(null);
    }
  }

  toggleRow(row: TreeRow, event: Event): void {
    event.stopPropagation();
    const next = new Set(this.collapsed());
    if (next.has(row.end.key)) {
      next.delete(row.end.key);
    } else {
      next.add(row.end.key);
    }
    this.collapsed.set(next);
  }

  collapseAll(): void {
    this.collapsed.set(new Set(this.rows().filter((row) => row.depth === 0 && !row.leaf).map((row) => row.end.key)));
  }

  expandAll(): void {
    this.collapsed.set(new Set());
  }

  isCollapsed(row: TreeRow): boolean {
    return this.collapsed().has(row.end.key);
  }

  /** One move forward; at a branch the continuation is chosen first, the main line preselected. */
  forward(): void {
    const active = this.active();
    const at = this.current() ?? (active ? startRoot(active.repertoire) : null);
    if (at && at.children.length > 1) {
      const lines = active?.lines ?? [];
      this.choice.set({
        options: at.children.map((node) => ({ node, lines: lines.filter((line) => line.moves.includes(node)).length })),
        selected: 0,
      });
      return;
    }
    this.step(1);
  }

  choose(node: MoveNode): void {
    this.choice.set(null);
    const path = this.path();
    const next = this.index();
    if (path[next] !== node) {
      this.path.set([...pathTo(node), ...mainContinuation(node)]);
    }
    this.index.set(next + 1);
    this.editing.set(false);
  }

  private onChoiceKey(event: KeyboardEvent): void {
    const choice = this.choice()!;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      this.choice.set({ ...choice, selected: (choice.selected + step + choice.options.length) % choice.options.length });
    } else if (event.key === 'Enter' || event.key === 'ArrowRight') {
      this.choose(choice.options[choice.selected].node);
    } else if (event.key === 'Escape' || event.key === 'ArrowLeft') {
      this.choice.set(null);
    }
  }

  step(delta: number): void {
    this.choice.set(null);
    const length = this.path().length;
    const next = delta === -99 ? 0 : delta === 99 ? length : this.index() + delta;
    this.index.set(Math.max(0, Math.min(length, next)));
    this.editing.set(false);
  }

  goTo(index: number): void {
    this.index.set(index + 1);
    this.editing.set(false);
  }

  moveNumberLabel(move: MoveNode, index: number): string {
    if (move.color === 'w') {
      return `${moveNumber(move)}.`;
    }
    return index === 0 ? `${moveNumber(move)}...` : '';
  }

  trainLine(): void {
    const line = this.line();
    const active = this.active();
    if (line && active) {
      this.nav.train(lineItem({ id: active.record.id, color: active.color }, line));
    }
  }

  edit(): void {
    const active = this.active();
    if (active) {
      this.nav.startEdit(active.record.id, this.path().slice(0, this.index()).map((move) => move.san), active.record.side);
    }
  }

  /** Shows the tree at the given position, on a line through it. */
  private openAt(sans: string[]): void {
    const active = this.active();
    const node = active ? nodeAt(active.repertoire, sans) : null;
    if (!active || !node) {
      return;
    }
    const line = active.lines.find((l) => l.moves.includes(node)) ?? null;
    const path = line?.moves ?? pathTo(node);
    this.path.set(path);
    this.index.set(sans.length);
  }

  showOnMap(): void {
    const line = this.line();
    if (line) {
      this.nav.showOnMap(line.key);
    }
  }

  startEdit(): void {
    this.draft.set(this.comment());
    this.editing.set(true);
  }

  async saveComment(): Promise<void> {
    const node = this.current();
    if (node) {
      await this.store.setComment(this.active()!.record.id, node.key, this.draft().trim());
    }
    this.editing.set(false);
  }

  select(record: RepertoireRecord): void {
    void this.store.focusRepertoire(record.id);
  }

  linesLabel(record: RepertoireRecord): string {
    return this.i18n.translate('rep.lines', {
      n: this.store.linesOf(record).length,
      side: this.i18n.translate(`side.${record.side}`),
    });
  }

  toggleMenu(record: RepertoireRecord, event: Event): void {
    event.stopPropagation();
    this.menuFor.set(this.menuFor() === record.id ? null : record.id);
  }

  async rename(record: RepertoireRecord): Promise<void> {
    this.menuFor.set(null);
    const name = prompt(this.i18n.translate('rep.renamePrompt'), record.name);
    if (name) {
      await this.store.renameRepertoire(record.id, name);
    }
  }

  async resetProgress(record: RepertoireRecord): Promise<void> {
    this.menuFor.set(null);
    if (confirm(this.i18n.translate('rep.confirmReset', { name: record.name }))) {
      await this.store.resetProgress(record.id);
    }
  }

  async remove(record: RepertoireRecord): Promise<void> {
    this.menuFor.set(null);
    if (confirm(this.i18n.translate('rep.confirmDelete', { name: record.name }))) {
      await this.store.deleteRepertoire(record.id);
    }
  }

  newRepertoire(): void {
    this.nav.importOpen.set(true);
  }
}
