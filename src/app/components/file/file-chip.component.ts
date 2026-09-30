import { Component, computed, inject } from '@angular/core';
import { TranslatePipe } from '../../pipes/translate.pipe';
import { AppStore } from '../../services/app-store.service';
import { FileSyncService } from '../../services/file-sync.service';
import { NavigationService } from '../../services/navigation.service';
import { TranslationService } from '../../services/translation.service';
import { savedWhen } from './saved-when';

/** Topbar chip: unsaved changes with a save button, or when the data file was last saved. */
@Component({
  selector: 'app-file-chip',
  standalone: true,
  imports: [TranslatePipe],
  template: `
    <button class="chip" [class.dirty]="dirty()" (click)="nav.fileOpen.set(!nav.fileOpen())">
      <span class="dot"></span>
      <span class="text">{{ label() }}</span>
      @if (dirty()) {
        <span class="save" (click)="save($event)">{{ 'file.save' | translate }}</span>
      }
    </button>
  `,
  styles: [
    `
      :host { display: block; flex-shrink: 0; }
      .chip {
        display: flex; align-items: center; gap: 8px; height: 34px; padding: 0 6px;
        border: none; border-radius: 6px; background: transparent; font-size: 13px; cursor: pointer; white-space: nowrap;
      }
      .chip:hover { background: rgba(0, 0, 0, 0.04); }
      .chip.dirty { color: var(--warn-ink); }
      .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--accent); flex-shrink: 0; }
      .dirty .dot { background: #f59e0b; }
      .text { font-weight: 600; }
      .save {
        display: inline-flex; align-items: center; gap: 4px; height: 26px; padding: 0 8px; border-radius: 6px;
        background: var(--accent); color: #fff; font-weight: 700; font-size: 12px;
      }
    `,
  ],
})
export class FileChipComponent {
  readonly nav = inject(NavigationService);
  readonly file = inject(FileSyncService);
  private readonly store = inject(AppStore);
  private readonly i18n = inject(TranslationService);

  readonly dirty = computed(() => this.file.state().unsaved > 0 && !(this.file.linkedName() && !this.file.needsPermission()));

  readonly label = computed(() => {
    const state = this.file.state();
    if (this.dirty()) {
      return this.i18n.translate('file.unsaved', { n: state.unsaved });
    }
    if (this.file.linkedName() && !this.file.needsPermission()) {
      return this.i18n.translate('file.autoSaved');
    }
    if (!state.lastSavedAt) {
      return this.i18n.translate('file.neverSaved');
    }
    return this.i18n.translate('file.saved', { when: savedWhen(state.lastSavedAt, this.store.now(), this.i18n, this.store.settings().language) });
  });

  save(event: Event): void {
    event.stopPropagation();
    void this.file.save();
  }
}
