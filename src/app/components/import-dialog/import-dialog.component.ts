import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Grouping, ImportItem, SourceFile, groupRepertoires, matchExisting, regroup } from '../../core/bulk-import';
import { Side } from '../../core/repertoire';
import { TranslatePipe } from '../../pipes/translate.pipe';
import { AppStore } from '../../services/app-store.service';
import { NavigationService } from '../../services/navigation.service';
import { TranslationService } from '../../services/translation.service';
import { isZip, readZipTextFiles } from '../../services/zip';

const NEW = '__new__';
const RECOMPUTE_DELAY_MS = 250;

@Component({
  selector: 'app-import-dialog',
  standalone: true,
  imports: [FormsModule, TranslatePipe],
  templateUrl: './import-dialog.component.html',
  styleUrl: './import-dialog.component.scss',
})
export class ImportDialogComponent {
  readonly store = inject(AppStore);
  private readonly nav = inject(NavigationService);
  private readonly i18n = inject(TranslationService);
  private recomputeTimer?: ReturnType<typeof setTimeout>;
  private recomputeRun = 0;
  private baseCache: { sources: SourceFile[]; side: Side; items: ImportItem[] } | null = null;

  readonly NEW = NEW;
  readonly files = signal<SourceFile[]>([]);
  readonly pasted = signal('');
  readonly target = signal<string>(NEW);
  readonly name = signal('');
  readonly side = signal<Side>('black');
  readonly dragging = signal(false);
  readonly busy = signal(false);
  readonly readError = signal(false);
  readonly skipped = signal<Set<number>>(new Set());
  readonly grouping = signal<Grouping>('source');
  readonly items = signal<ImportItem[]>([]);
  readonly sourceCount = signal(0);
  readonly processing = signal(false);

  readonly sources = computed<SourceFile[]>(() => (this.pasted().trim() ? [{ name: '', text: this.pasted() }] : this.files()));
  readonly bulk = computed(() => this.items().length > 1);
  readonly single = computed<ImportItem | null>(() => (this.items().length === 1 ? this.items()[0] : null));
  readonly fileLabel = computed(() => {
    const files = this.files();
    return files.length === 1 ? files[0].name : files.length > 1 ? `${files.length}` : null;
  });

  /** In single mode, the existing repertoire this file would update because name and colour match. */
  readonly updates = computed(() => {
    const item = this.single();
    return item ? matchExisting({ ...item, name: this.name(), side: this.side() }, this.store.repertoires()) : null;
  });

  readonly selected = computed(() => this.items().filter((item, i) => item.lines > 0 && !this.skipped().has(i)));

  readonly canImport = computed(() => {
    if (this.busy() || this.processing()) {
      return false;
    }
    if (this.bulk()) {
      return this.selected().length > 0;
    }
    const item = this.single();
    return !!item && item.lines > 0 && (this.target() !== NEW || this.name().trim() !== '');
  });

  constructor() {
    effect(() => {
      const sources = this.sources();
      const side = this.side();
      const grouping = this.grouping();
      const book = this.store.openings();
      clearTimeout(this.recomputeTimer);
      const run = ++this.recomputeRun;
      if (sources.length === 0) {
        this.items.set([]);
        this.sourceCount.set(0);
        return;
      }
      untracked(() => this.processing.set(true));
      this.recomputeTimer = setTimeout(() => {
        const base = this.baseItems(sources, side);
        const names = { white: this.i18n.translate('import.allWhite'), black: this.i18n.translate('import.allBlack') };
        const items = regroup(base, grouping, book, names);
        if (run === this.recomputeRun) {
          this.sourceCount.set(base.length);
          this.skipped.set(new Set());
          this.items.set(items);
          this.processing.set(false);
        }
      }, RECOMPUTE_DELAY_MS);
    });
    effect(() => {
      const item = this.single();
      untracked(() => {
        if (item) {
          this.side.set(item.side);
          if (!this.name().trim()) {
            this.name.set(item.name);
          }
          this.target.set(matchExisting(item, this.store.repertoires())?.id ?? NEW);
        }
      });
    });
  }

  /** Parsing large exports is the slow part; regrouping reuses the parsed files. */
  private baseItems(sources: SourceFile[], side: Side): ImportItem[] {
    if (this.baseCache?.sources !== sources || this.baseCache.side !== side) {
      this.baseCache = { sources, side, items: groupRepertoires(sources, side) };
    }
    return this.baseCache.items;
  }

  close(): void {
    this.nav.importOpen.set(false);
  }

  onFile(event: Event): void {
    const input = event.target as HTMLInputElement;
    const files = [...(input.files ?? [])];
    input.value = '';
    void this.readFiles(files);
  }

  onDrop(event: DragEvent): void {
    event.preventDefault();
    this.dragging.set(false);
    void this.readFiles([...(event.dataTransfer?.files ?? [])]);
  }

  onDragOver(event: DragEvent): void {
    event.preventDefault();
    this.dragging.set(true);
  }

  setText(text: string): void {
    this.name.set('');
    this.pasted.set(text);
  }

  existingFor(item: ImportItem): string | null {
    return matchExisting(item, this.store.repertoires())?.name ?? null;
  }

  toggle(index: number): void {
    this.skipped.update((set) => {
      const next = new Set(set);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  }

  async confirm(): Promise<void> {
    if (!this.canImport()) {
      return;
    }
    this.busy.set(true);
    try {
      if (this.bulk()) {
        const ids: string[] = [];
        for (const item of this.selected()) {
          ids.push(await this.importItem(item.pgn, item.name, item.side, matchExisting(item, this.store.repertoires())?.id ?? null, true));
        }
        await this.store.updateSettings(ids.length > 1 ? { activeScope: { kind: 'all' }, activeRepertoireId: ids[0] } : { activeScope: { kind: 'one', id: ids[0] }, activeRepertoireId: ids[0] });
      } else {
        const item = this.single()!;
        const target = this.target() === NEW ? null : this.target();
        await this.importItem(item.pgn, this.name(), this.side(), target, target !== null && target === this.updates()?.id);
      }
      this.nav.startSession(this.store.scoped().length > 1 ? 'free' : 'all');
      this.nav.go('train');
      this.close();
    } finally {
      this.busy.set(false);
    }
  }

  /** Imports one repertoire and makes it active; returns its id. */
  private async importItem(pgn: string, name: string, side: Side, targetId: string | null, replace: boolean): Promise<string> {
    if (targetId && replace) {
      await this.store.replacePgn(targetId, pgn);
      await this.store.focusRepertoire(targetId);
      return targetId;
    }
    return (await this.store.importPgn({ pgn, name, side, targetId })).id;
  }

  private async readFiles(files: File[]): Promise<void> {
    this.readError.set(false);
    const read: SourceFile[] = [];
    try {
      for (const file of files) {
        const data = await file.arrayBuffer();
        if (isZip(data)) {
          read.push(...(await readZipTextFiles(data, (name) => /\.pgn$/i.test(name))));
        } else {
          read.push({ name: file.name, text: new TextDecoder().decode(data) });
        }
      }
    } catch {
      this.readError.set(true);
    }
    this.pasted.set('');
    this.name.set('');
    this.files.set(read);
  }
}
