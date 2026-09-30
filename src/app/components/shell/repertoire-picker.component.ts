import { Component, ElementRef, HostListener, computed, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Side } from '../../core/repertoire';
import { RepertoireScope, sameScope } from '../../core/scope';
import { TranslatePipe } from '../../pipes/translate.pipe';
import { AppStore, RepertoireRecord } from '../../services/app-store.service';
import { NavigationService } from '../../services/navigation.service';
import { TranslationService } from '../../services/translation.service';
import { SideSwatchComponent, masteryColor } from './side-swatch.component';

interface PickerItem {
  record: RepertoireRecord;
  /** The matching line when the search matched a line name, not the repertoire name. */
  matchedLine: string | null;
  lines: number;
  due: number;
  mastery: number | null;
}

interface PickerGroup {
  side: Side;
  items: PickerItem[];
  total: number;
  open: boolean;
}

const SIDES: Side[] = ['white', 'black'];

@Component({
  selector: 'app-repertoire-picker',
  standalone: true,
  imports: [FormsModule, SideSwatchComponent, TranslatePipe],
  templateUrl: './repertoire-picker.component.html',
  styleUrl: './repertoire-picker.component.scss',
})
export class RepertoirePickerComponent {
  readonly dark = input(false);
  readonly store = inject(AppStore);
  private readonly nav = inject(NavigationService);
  private readonly i18n = inject(TranslationService);
  private readonly host = inject(ElementRef<HTMLElement>);
  readonly masteryColor = masteryColor;

  readonly open = signal(false);
  readonly query = signal('');
  readonly creating = signal(false);
  readonly newName = signal('');

  readonly scope = this.store.scope;

  readonly trigger = computed(() => {
    const scope = this.scope();
    if (scope.kind === 'one') {
      const record = this.store.repertoires().find((r) => r.id === scope.id);
      return { name: record?.name ?? this.i18n.translate('top.noRepertoire'), side: record?.side ?? null };
    }
    if (scope.kind === 'side') {
      return { name: `${this.i18n.translate('picker.all')} · ${this.i18n.translate(`side.${scope.side}`)}`, side: scope.side };
    }
    return { name: this.i18n.translate('picker.all'), side: null };
  });

  readonly totalLines = computed(() => this.store.repertoires().reduce((sum, record) => sum + this.store.linesOf(record).length, 0));

  readonly groups = computed<PickerGroup[]>(() => {
    const query = this.query().trim().toLowerCase();
    const collapsed = this.store.settings().pickerCollapsed ?? [];
    return SIDES.map((side) => {
      const records = this.store.repertoires().filter((record) => record.side === side);
      const items = records
        .filter((record) => !query || this.matches(record, query))
        .map((record) => ({
          record,
          matchedLine: query && !record.name.toLowerCase().includes(query) ? (this.store.linesOf(record).find((line) => line.name.toLowerCase().includes(query))?.name ?? null) : null,
          lines: this.store.linesOf(record).length,
          due: this.store.dueOf(record),
          mastery: this.store.masteryOf(record),
        }));
      return { side, items, total: query ? items.length : records.length, open: !!query || !collapsed.includes(side) };
    }).filter((group) => (query ? group.items.length > 0 : group.total > 0));
  });

  readonly nothingFound = computed(() => this.query().trim() !== '' && this.groups().every((group) => group.items.length === 0));

  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent): void {
    if (!this.host.nativeElement.contains(event.target as Node)) {
      this.close();
    }
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    this.close();
  }

  toggle(): void {
    if (this.open()) {
      this.close();
    } else {
      this.open.set(true);
    }
  }

  close(): void {
    this.open.set(false);
    this.query.set('');
    this.creating.set(false);
  }

  isScope(scope: RepertoireScope): boolean {
    return sameScope(this.scope(), scope);
  }

  select(scope: RepertoireScope): void {
    this.close();
    void this.store.selectScope(scope).then(() => {
      if (this.nav.view() === 'train') {
        this.nav.startSession(this.store.scoped().length > 1 ? 'free' : 'review');
      }
    });
  }

  selectSide(side: Side, event: Event): void {
    event.stopPropagation();
    this.select({ kind: 'side', side });
  }

  toggleGroup(side: Side): void {
    const collapsed = this.store.settings().pickerCollapsed ?? [];
    void this.store.updateSettings({ pickerCollapsed: collapsed.includes(side) ? collapsed.filter((s) => s !== side) : [...collapsed, side] });
  }

  subtitle(item: PickerItem): string {
    if (item.matchedLine) {
      return item.matchedLine;
    }
    return this.i18n.translate(item.due > 0 ? 'picker.itemSub' : 'picker.itemSubNone', { lines: item.lines, due: item.due });
  }

  importPgn(): void {
    this.close();
    this.nav.importOpen.set(true);
  }

  async create(side: Side): Promise<void> {
    const name = this.newName().trim() || this.i18n.translate('picker.newRepertoire');
    this.close();
    this.newName.set('');
    const record = await this.store.createRepertoire(name, side);
    await this.store.selectScope({ kind: 'one', id: record.id });
    this.nav.startEdit(record.id, [], side);
  }

  private matches(record: RepertoireRecord, query: string): boolean {
    return record.name.toLowerCase().includes(query) || this.store.linesOf(record).some((line) => line.name.toLowerCase().includes(query));
  }
}
