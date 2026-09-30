import { Component, inject, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Platform, parseProfile } from '../../core/game-tree';
import { TranslatePipe } from '../../pipes/translate.pipe';
import { AppStore } from '../../services/app-store.service';
import { LichessService } from '../../services/lichess.service';
import { ImportError, PlayerImportService } from '../../services/player-import.service';

const DAY_MS = 24 * 60 * 60 * 1000;

@Component({
  selector: 'app-player-dialog',
  standalone: true,
  imports: [FormsModule, TranslatePipe],
  template: `
    <div class="backdrop" (click)="close()">
      <div class="dialog" (click)="$event.stopPropagation()">
        <div class="dialog-head">
          <span>{{ 'pl.title' | translate }}</span>
          <button class="icon-btn" (click)="close()"><span class="icon">close</span></button>
        </div>
        <p class="muted">{{ 'pl.text' | translate }}</p>

        <div class="segmented tall">
          <button [class.on]="platform() === 'lichess'" (click)="choose('lichess')">Lichess</button>
          <button [class.on]="platform() === 'chesscom'" (click)="choose('chesscom')">Chess.com</button>
        </div>

        @if (platform() === 'lichess' && !lichess.loggedIn()) {
          <div class="notice">
            <span>{{ 'pl.lichessLogin' | translate }}</span>
            <button class="btn primary" (click)="lichess.login()">{{ 'ex.login' | translate }}</button>
          </div>
        }

        <div class="grid">
          <label class="field wide">
            <span>{{ 'pl.username' | translate }}</span>
            <input [ngModel]="username()" (ngModelChange)="setUsername($event)" (keydown.enter)="load()" autocomplete="off" [placeholder]="(platform() === 'lichess' ? 'pl.usernameHint' : 'pl.usernameHintChesscom') | translate" />
          </label>
          <label class="field">
            <span>{{ 'pl.max' | translate }}</span>
            <select [ngModel]="max()" (ngModelChange)="max.set(+$event)">
              @for (n of limits; track n) {
                <option [value]="n">{{ n === 0 ? ('pl.allGames' | translate) : n }}</option>
              }
            </select>
          </label>
          <label class="field">
            <span>{{ 'pl.period' | translate }}</span>
            <select [ngModel]="months()" (ngModelChange)="months.set(+$event)">
              <option [value]="3">{{ 'pl.months' | translate: { n: 3 } }}</option>
              <option [value]="12">{{ 'pl.months' | translate: { n: 12 } }}</option>
              <option [value]="36">{{ 'pl.months' | translate: { n: 36 } }}</option>
              <option [value]="0">{{ 'pl.all' | translate }}</option>
            </select>
          </label>
        </div>

        @if (platform() === 'lichess' && (max() === 0 || max() > 1000)) {
          <p class="muted small">{{ 'pl.lichessSpeed' | translate: { minutes: estimateMinutes() } }}</p>
        }

        @if (importer.job(); as job) {
          <div class="notice">
            <span>
              @if (job.phase === 'download') {
                {{ 'pl.progress' | translate: { n: job.done } }}
              } @else {
                {{ 'pl.indexing' | translate: { n: job.done, total: job.total ?? 0 } }}
              }
            </span>
            <button class="btn" (click)="importer.stop()">{{ 'pl.stop' | translate }}</button>
          </div>
          <p class="muted small">{{ 'pl.background' | translate }}</p>
        }
        @if (error(); as e) {
          <div class="notice error">{{ e | translate }}</div>
        }

        <div class="dialog-actions">
          <button class="btn" (click)="close()">{{ (importer.job() ? 'settings.close' : 'import.cancel') | translate }}</button>
          <button class="btn primary" [disabled]="!canLoad()" (click)="load()">{{ 'pl.load' | translate }}</button>
        </div>
      </div>
    </div>
  `,
  styles: [
    `
      p { margin: 0; font-size: 13px; line-height: 1.5; }
      .small { font-size: 12px; }
      .segmented.tall { height: 40px; background: var(--surface-bar); }
      .segmented.tall button { height: 36px; font-size: 14px; }
      .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px 16px; }
      .wide { grid-column: 1 / 3; }
      .notice { display: flex; align-items: center; justify-content: space-between; gap: 12px; font-size: 13px; padding: 10px 12px; border-radius: 8px; background: var(--tile); }
      .notice.error { background: #ffebee; color: var(--error); }
    `,
  ],
})
export class PlayerDialogComponent {
  readonly closed = output<void>();

  readonly lichess = inject(LichessService);
  readonly importer = inject(PlayerImportService);
  private readonly store = inject(AppStore);

  readonly limits = [250, 1000, 2500, 5000, 10000, 0];
  readonly platform = signal<Platform>(this.store.settings().playerPlatform ?? 'lichess');
  readonly username = signal('');
  readonly max = signal(1000);
  readonly months = signal(12);
  readonly error = signal<string | null>(null);

  canLoad(): boolean {
    return !this.importer.job() && this.username().trim() !== '' && (this.platform() === 'chesscom' || this.lichess.loggedIn());
  }

  /** Lichess streams about 30 games per second to logged-in users. */
  estimateMinutes(): number {
    return Math.max(1, Math.round((this.max() || 20000) / 30 / 60));
  }

  close(): void {
    this.closed.emit();
  }

  choose(platform: Platform): void {
    this.platform.set(platform);
    void this.store.updateSettings({ playerPlatform: platform });
  }

  setUsername(value: string): void {
    const profile = parseProfile(value);
    if (profile) {
      this.choose(profile.platform);
      this.username.set(profile.username);
    } else {
      this.username.set(value);
    }
  }

  async load(): Promise<void> {
    if (!this.canLoad()) {
      return;
    }
    const since = this.months() > 0 ? Date.now() - this.months() * 30 * DAY_MS : 0;
    this.error.set(null);
    try {
      await this.importer.load(this.platform(), this.username().trim().replace(/^@/, ''), this.max(), since);
      this.close();
    } catch (error) {
      const kind = error instanceof ImportError ? error.kind : 'network';
      this.error.set(kind === 'no-games' ? 'pl.noGames' : `pl.error.${kind}`);
    }
  }
}
