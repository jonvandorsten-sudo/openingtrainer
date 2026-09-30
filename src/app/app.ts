import { Component, computed, effect, inject } from '@angular/core';
import { ExplorerViewComponent } from './components/explorer-view/explorer-view.component';
import { FileChipComponent } from './components/file/file-chip.component';
import { FilePanelComponent } from './components/file/file-panel.component';
import { ImportDialogComponent } from './components/import-dialog/import-dialog.component';
import { MapViewComponent } from './components/map-view/map-view.component';
import { RepertoireViewComponent } from './components/repertoire-view/repertoire-view.component';
import { SettingsDialogComponent } from './components/settings-dialog/settings-dialog.component';
import { ModeTabsComponent } from './components/shell/mode-tabs.component';
import { LanguageMenuComponent } from './components/shell/language-menu.component';
import { LogoMarkComponent } from './components/shell/logo-mark.component';
import { RepertoirePickerComponent } from './components/shell/repertoire-picker.component';
import { StatsViewComponent } from './components/stats-view/stats-view.component';
import { TrainViewComponent } from './components/train-view/train-view.component';
import { WelcomeComponent } from './components/welcome/welcome.component';
import { APP_NAME } from './app-name';
import { TranslatePipe } from './pipes/translate.pipe';
import { AppStore } from './services/app-store.service';
import { applyBoardStyle } from './services/board-style';
import { FileSyncService } from './services/file-sync.service';
import { downloadText, safeFileName } from './services/files';
import { LichessService } from './services/lichess.service';
import { NavigationService, View } from './services/navigation.service';

interface NavItem {
  view: View;
  icon: string;
  label: string;
}

@Component({
  selector: 'app-root',
  imports: [
    TrainViewComponent,
    ExplorerViewComponent,
    MapViewComponent,
    RepertoireViewComponent,
    StatsViewComponent,
    ImportDialogComponent,
    SettingsDialogComponent,
    WelcomeComponent,
    ModeTabsComponent,
    RepertoirePickerComponent,
    LanguageMenuComponent,
    LogoMarkComponent,
    FileChipComponent,
    FilePanelComponent,
    TranslatePipe,
  ],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  readonly appName = APP_NAME;
  readonly store = inject(AppStore);
  readonly nav = inject(NavigationService);

  readonly items: NavItem[] = [
    { view: 'train', icon: 'sports_esports', label: 'nav.train' },
    { view: 'map', icon: 'grid_view', label: 'nav.map' },
    { view: 'rep', icon: 'account_tree', label: 'nav.rep' },
    { view: 'explore', icon: 'travel_explore', label: 'nav.explore' },
    { view: 'stats', icon: 'insights', label: 'nav.stats' },
  ];

  readonly viewTitle = computed(() => {
    if (this.nav.view() === 'explore' && this.nav.editTarget()) {
      return 'edit.viewTitle';
    }
    return this.items.find((item) => item.view === this.nav.view())?.label ?? '';
  });
  readonly goal = computed(() => this.store.settings().dailyGoal);
  readonly goalPercent = computed(() => Math.min(100, (100 * this.store.todayCount()) / Math.max(1, this.goal())));

  private readonly lichess = inject(LichessService);
  private readonly file = inject(FileSyncService);
  readonly unsaved = computed(() => (this.file.linkedName() && !this.file.needsPermission() ? 0 : this.file.state().unsaved));

  constructor() {
    effect(() => {
      const settings = this.store.settings();
      applyBoardStyle(settings.boardTheme, settings.pieceSet);
    });
    void this.store.init().then(async () => {
      this.nav.mode.set(this.store.scoped().length > 1 ? 'free' : 'review');
      await this.file.init();
    });
    this.lichess
      .completeLogin()
      .then((loggedIn) => loggedIn && this.nav.go('explore'))
      .catch(() => this.nav.settingsOpen.set(true));
  }

  saveFile(): void {
    this.nav.toast.set(null);
    void this.file.save();
  }

  async undo(): Promise<void> {
    this.nav.toast.set(null);
    await this.store.undoLastChange();
  }

  exportPgn(): void {
    const record = this.store.active()?.record;
    if (record) {
      downloadText(`${safeFileName(record.name)}.pgn`, this.store.exportPgn(record), 'application/x-chess-pgn');
    }
  }
}
