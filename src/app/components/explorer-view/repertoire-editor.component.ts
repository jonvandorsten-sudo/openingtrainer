import { Component, ElementRef, afterRenderEffect, computed, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MoveNode, formatMoves, knownDepth, nodeAt, pathTo, startRoot } from '../../core/repertoire';
import { RowRelation, TreeRow, rowMoves, rowRelation, treeRows, visibleTreeRows } from '../../core/tree-rows';
import { TranslatePipe } from '../../pipes/translate.pipe';
import { ActiveRepertoire, AppStore } from '../../services/app-store.service';
import { NavigationService } from '../../services/navigation.service';
import { SideSwatchComponent } from '../shell/side-swatch.component';

interface PathMove {
  san: string;
  number: string;
  isNew: boolean;
  mine: boolean;
}

interface Continuation {
  node: MoveNode;
  lines: number;
  main: boolean;
}

/** Edit mode in Explore: save the moves played to a repertoire, reorder or delete continuations, edit comments. */
@Component({
  selector: 'app-repertoire-editor',
  standalone: true,
  imports: [FormsModule, SideSwatchComponent, TranslatePipe],
  templateUrl: './repertoire-editor.component.html',
  styleUrl: './repertoire-editor.component.scss',
})
export class RepertoireEditorComponent {
  readonly target = input.required<ActiveRepertoire>();
  readonly store = inject(AppStore);
  private readonly nav = inject(NavigationService);
  private readonly host = inject(ElementRef<HTMLElement>);
  readonly busy = signal(false);
  readonly rowMoves = rowMoves;
  readonly collapsed = signal<ReadonlySet<string>>(new Set());

  readonly sans = this.nav.workPosition;
  readonly id = computed(() => this.target().record.id);
  readonly depth = computed(() => knownDepth(this.target().repertoire, this.sans()));
  readonly newMoves = computed(() => this.sans().length - this.depth());
  /** The repertoire node at the position, or null while the position has unsaved moves. */
  readonly node = computed<MoveNode | null>(() => (this.newMoves() === 0 ? nodeAt(this.target().repertoire, this.sans()) : null));
  /** The deepest repertoire node on the way to the position. */
  private readonly knownNode = computed(() => nodeAt(this.target().repertoire, this.sans().slice(0, this.depth())));

  readonly status = computed<'start' | 'new' | 'in'>(() => (this.newMoves() > 0 ? 'new' : this.sans().length === 0 ? 'start' : 'in'));

  readonly path = computed<PathMove[]>(() =>
    this.sans().map((san, i) => ({
      san,
      number: i % 2 === 0 ? `${i / 2 + 1}.` : '',
      isNew: i >= this.depth(),
      mine: (i % 2 === 0) === (this.target().color === 'w'),
    })),
  );

  readonly endsOnOpponent = computed(() => this.newMoves() > 0 && (this.sans().length % 2 === 1) !== (this.target().color === 'w'));

  readonly yourTurn = computed(() => (this.sans().length % 2 === 0) === (this.target().color === 'w'));

  readonly continuations = computed<Continuation[]>(() => {
    const node = this.node();
    if (!node) {
      return [];
    }
    return node.children.map((child, i) => ({ node: child, lines: this.linesThrough(child), main: i === 0 && node.children.length > 1 }));
  });

  readonly treeOpen = computed(() => this.store.settings().editTreeOpen ?? true);
  readonly rows = computed(() => {
    const target = this.target();
    return treeRows(target.repertoire, target.lines, target.color, this.store.progressOf(target.record.id).moves);
  });

  readonly comment = computed(() => {
    const node = this.node();
    return node?.parent ? this.store.commentFor(this.id(), node.key, node.comment) : '';
  });
  readonly canComment = computed(() => !!this.node()?.parent);
  readonly currentLines = computed(() => {
    const node = this.node();
    return node?.parent ? this.linesThrough(node) : 0;
  });

  constructor() {
    afterRenderEffect(() => {
      this.knownNode();
      this.treeOpen();
      this.showCurrentRow();
    });
  }

  readonly visibleRows = computed(() => visibleTreeRows(this.rows(), this.collapsed()));

  isCollapsed(row: TreeRow): boolean {
    return this.collapsed().has(row.end.key);
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

  relation(row: TreeRow): RowRelation {
    return rowRelation(row, this.knownNode());
  }

  done(): void {
    this.nav.editTarget.set(null);
  }

  play(san: string): void {
    this.sans.set([...this.sans(), san]);
  }

  goToRow(row: TreeRow): void {
    this.sans.set(pathTo(row.end).map((move) => move.san));
  }

  goToNode(node: MoveNode): void {
    this.sans.set(pathTo(node).map((move) => move.san));
  }

  toggleTree(): void {
    void this.store.updateSettings({ editTreeOpen: !this.treeOpen() });
  }

  async save(): Promise<void> {
    if (await this.run(() => this.store.addLine(this.id(), this.sans()))) {
      this.nav.notify('edit.saved');
    }
  }

  discard(): void {
    this.sans.set(this.sans().slice(0, this.depth()));
  }

  async promote(continuation: Continuation): Promise<void> {
    if (await this.run(() => this.store.promoteMove(this.id(), continuation.node.key))) {
      this.nav.notify('edit.promoted');
    }
  }

  async remove(continuation: Continuation): Promise<void> {
    if (!this.nav.confirmDelete(formatMoves([continuation.node]), continuation.lines)) {
      return;
    }
    if (await this.run(() => this.store.removeMove(this.id(), continuation.node.key))) {
      this.nav.notifyRemoved(continuation.lines);
    }
  }

  async removeCurrent(): Promise<void> {
    const node = this.node();
    if (!node?.parent) {
      return;
    }
    const lines = this.linesThrough(node);
    if (!this.nav.confirmDelete(formatMoves([node]), lines)) {
      return;
    }
    if (await this.run(() => this.store.removeMove(this.id(), node.key))) {
      this.sans.set(this.sans().slice(0, -1));
      this.nav.notifyRemoved(lines);
    }
  }

  async saveComment(text: string): Promise<void> {
    const node = this.node();
    if (node?.parent && text.trim() !== this.comment().trim()) {
      await this.store.setComment(this.id(), node.key, text.trim());
    }
  }

  /** Scrolls the move tree so the row with the position is in view. */
  private showCurrentRow(): void {
    const element: HTMLElement = this.host.nativeElement;
    const tree = element.querySelector<HTMLElement>('.tree');
    const row = tree?.querySelector<HTMLElement>('.tree-row.current') ?? [...(tree?.querySelectorAll<HTMLElement>('.tree-row.ancestor') ?? [])].at(-1);
    if (tree && row && (row.offsetTop < tree.scrollTop || row.offsetTop + row.offsetHeight > tree.scrollTop + tree.clientHeight)) {
      tree.scrollTop = row.offsetTop - tree.clientHeight / 3;
    }
  }

  private linesThrough(node: MoveNode): number {
    const lines = this.target().lines;
    return node === startRoot(this.target().repertoire) ? lines.length : lines.filter((line) => line.moves.includes(node)).length;
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
