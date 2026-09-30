import { Component, HostListener, computed, inject } from '@angular/core';
import { TranslatePipe } from '../../pipes/translate.pipe';
import { AppStore } from '../../services/app-store.service';
import { FileSyncService } from '../../services/file-sync.service';
import { NavigationService } from '../../services/navigation.service';
import { TranslationService } from '../../services/translation.service';
import { savedWhen } from './saved-when';

/** Explains that the data lives only in this browser, and saves, opens and links the data file. */
@Component({
  selector: 'app-file-panel',
  standalone: true,
  imports: [TranslatePipe],
  templateUrl: './file-panel.component.html',
  styleUrl: './file-panel.component.scss',
})
export class FilePanelComponent {
  readonly nav = inject(NavigationService);
  readonly file = inject(FileSyncService);
  readonly store = inject(AppStore);
  private readonly i18n = inject(TranslationService);

  readonly linked = computed(() => !!this.file.linkedName());
  readonly dirty = computed(() => this.file.state().unsaved > 0 && !(this.linked() && !this.file.needsPermission()));

  readonly lastSaved = computed(() => {
    const at = this.file.state().lastSavedAt;
    return at ? this.i18n.translate('file.lastSaved', { when: savedWhen(at, this.store.now(), this.i18n, this.store.settings().language) }) : this.i18n.translate('file.neverSaved');
  });

  @HostListener('document:keydown.escape')
  close(): void {
    this.file.cancelLoad();
    this.nav.fileOpen.set(false);
  }

  async confirmLoad(): Promise<void> {
    await this.file.confirmLoad();
    if (!this.file.loadError()) {
      this.nav.fileOpen.set(false);
    }
  }
}
