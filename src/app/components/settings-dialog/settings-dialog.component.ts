import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { BOARD_THEMES, BoardThemeName, PIECE_SETS } from '../../core/board-theme';
import { APP_NAME } from '../../app-name';
import { nextInterval } from '../../core/progress';
import { TranslatePipe } from '../../pipes/translate.pipe';
import { AppStore, HistoryEntry, LANGUAGES, Language, Settings } from '../../services/app-store.service';
import { EngineService } from '../../services/engine.service';
import { LichessService } from '../../services/lichess.service';
import { NavigationService } from '../../services/navigation.service';
import { TranslationService } from '../../services/translation.service';

@Component({
  selector: 'app-settings-dialog',
  standalone: true,
  imports: [FormsModule, TranslatePipe],
  template: `
    <div class="backdrop" (click)="close()">
      <div class="dialog" (click)="$event.stopPropagation()">
        <div class="dialog-head">
          <span>{{ 'settings.title' | translate }}</span>
          <button class="icon-btn" (click)="close()"><span class="icon">close</span></button>
        </div>

        <section>
          <h3>{{ 'settings.data' | translate }}</h3>
          <p class="muted">{{ 'settings.dataText' | translate }}</p>
          @if (!store.persistent()) {
            <p class="warning">{{ 'settings.notPersistent' | translate }}</p>
          }
          <div class="row">
            <button class="btn primary" (click)="openFile()">{{ 'file.openPanel' | translate }}</button>
          </div>
          @if (message(); as m) {
            <p [class.warning]="m === 'settings.badBackup'" class="message">{{ m | translate }}</p>
          }
        </section>

        @if (store.history().length > 0) {
          <section>
            <h3>{{ 'settings.history' | translate }}</h3>
            <p class="muted">{{ 'settings.historyText' | translate }}</p>
            <div class="history">
              @for (entry of store.history(); track entry.at) {
                <div class="history-row">
                  <span class="when">{{ when(entry.at) }}</span>
                  <span class="what"><strong>{{ entry.record.name }}</strong> · {{ (entry.kind === 'delete' ? 'settings.historyDeleted' : 'settings.historyEdited') | translate }} · {{ 'free.linesCount' | translate: { n: entry.lines, count: entry.lines } }} {{ 'settings.historyBefore' | translate }}</span>
                  <button class="link-btn" (click)="restore(entry)">{{ 'settings.restore' | translate }}</button>
                </div>
              }
            </div>
          </section>
        }
        <section>
          <h3>{{ 'settings.accounts' | translate }}</h3>
          @if (lichess.username(); as name) {
            <div class="row account">
              <span>{{ 'settings.lichessIn' | translate: { name } }}</span>
              <button class="btn" (click)="lichess.logout()">{{ 'settings.logout' | translate }}</button>
            </div>
          } @else {
            <div class="row account">
              <span class="muted">{{ 'settings.lichessOut' | translate }}</span>
              <button class="btn primary" (click)="lichess.login()">{{ 'ex.login' | translate }}</button>
            </div>
            <details class="token">
              <summary>{{ 'settings.tokenTitle' | translate }}</summary>
              <p class="muted small">
                {{ 'settings.tokenText' | translate }}
                <a [href]="tokenUrl" target="_blank" rel="noopener">lichess.org/account/oauth/token</a>
              </p>
              <div class="row">
                <input class="token-input" type="password" autocomplete="off" [placeholder]="'settings.tokenPlaceholder' | translate" [ngModel]="token()" (ngModelChange)="token.set($event)" />
                <button class="btn" [disabled]="!token().trim()" (click)="useToken()">{{ 'settings.tokenUse' | translate }}</button>
              </div>
            </details>
          }
          @if (lichess.loginError(); as loginError) {
            <p class="warning">{{ 'settings.loginFailed' | translate }} ({{ loginError }})</p>
          }
          <p class="muted small">{{ 'settings.chesscomNote' | translate }}</p>
        </section>

        <section>
          <h3>{{ 'settings.training' | translate }}</h3>
          <div class="grid">
            <label class="field">
              <span>{{ 'settings.dailyGoal' | translate }}</span>
              <input type="number" min="1" max="200" [ngModel]="store.settings().dailyGoal" (ngModelChange)="set('dailyGoal', clamp($event, 1, 200))" />
            </label>
            <label class="field">
              <span>{{ 'settings.mastery' | translate }}</span>
              <input type="number" min="1" max="10" [ngModel]="store.settings().masteryCount" (ngModelChange)="set('masteryCount', clamp($event, 1, 10))" />
            </label>
            <label class="field">
              <span>{{ 'settings.replyDelay' | translate }} ({{ store.settings().replyDelayMs }} ms)</span>
              <input type="range" min="150" max="1500" step="50" [ngModel]="store.settings().replyDelayMs" (ngModelChange)="set('replyDelayMs', +$event)" />
            </label>
            <label class="field">
              <span>{{ 'settings.language' | translate }}</span>
              <select [ngModel]="store.settings().language" (ngModelChange)="setLanguage($event)">
                @for (language of languages; track language.code) {
                  <option [value]="language.code">{{ language.name }}</option>
                }
              </select>
            </label>
            <label class="field">
              <span>{{ 'settings.trainDepth' | translate }}</span>
              <input type="number" min="0" max="40" [ngModel]="store.settings().trainDepth" (ngModelChange)="set('trainDepth', clamp($event, 0, 40))" />
              <small class="muted">{{ store.settings().trainDepth === 0 ? ('settings.trainDepthAll' | translate) : ('settings.trainDepthN' | translate: { n: store.settings().trainDepth }) }}</small>
            </label>
            <label class="field">
              <span>{{ 'settings.firstReview' | translate }}</span>
              <input type="number" min="1" max="30" [ngModel]="store.settings().firstReviewDays" (ngModelChange)="set('firstReviewDays', clamp($event, 1, 30))" />
            </label>
            <label class="field">
              <span>{{ 'settings.reviewGrowth' | translate }}: ×{{ store.settings().reviewGrowth.toFixed(1) }}</span>
              <input type="range" min="1.5" max="4" step="0.1" [ngModel]="store.settings().reviewGrowth" (ngModelChange)="set('reviewGrowth', +$event)" />
            </label>
            <div class="field schedule">
              <span>{{ 'settings.schedule' | translate }}</span>
              <strong>{{ schedule() }}</strong>
            </div>
          </div>
          <p class="muted small">{{ 'settings.scheduleHint' | translate }}</p>
          <label class="check">
            <input type="checkbox" [ngModel]="store.settings().autoPlayKnown" (ngModelChange)="set('autoPlayKnown', $event)" />
            {{ 'settings.autoPlayKnown' | translate: { n: store.settings().masteryCount } }}
          </label>
          <label class="check">
            <input type="checkbox" [ngModel]="store.settings().showEval" (ngModelChange)="set('showEval', $event)" />
            {{ 'settings.showEval' | translate }}
          </label>
          @if (store.settings().showEval) {
            <div class="grid">
              <label class="field">
                <span>{{ 'settings.evalSource' | translate }}</span>
                <select [ngModel]="store.settings().evalSource" (ngModelChange)="set('evalSource', $event)">
                  <option value="stockfish">{{ 'settings.evalStockfish' | translate }}</option>
                  <option value="pgn">{{ 'settings.evalPgn' | translate }}</option>
                </select>
              </label>
              @if (store.settings().evalSource === 'stockfish') {
                <label class="field">
                  <span>{{ 'settings.engineDepth' | translate }}: {{ store.settings().engineDepth }}</span>
                  <input type="range" min="8" max="30" step="1" [ngModel]="store.settings().engineDepth" (ngModelChange)="set('engineDepth', +$event)" />
                </label>
              }
            </div>
            @if (store.settings().evalSource === 'stockfish') {
              <p class="muted">{{ 'settings.engineHint' | translate }}</p>
              @if (engine.failed()) {
                <p class="warning">{{ 'settings.engineFailed' | translate }}</p>
              }
              <p class="muted small">
                {{ 'settings.engineCredit' | translate }}
                <a href="https://github.com/nmrugg/stockfish.js" target="_blank" rel="noopener">github.com/nmrugg/stockfish.js</a>
              </p>
            }
          }
        </section>

        <section>
          <h3>{{ 'settings.board' | translate }}</h3>
          <div class="themes">
            @for (theme of themes; track theme.name) {
              <button class="theme" [class.on]="store.settings().boardTheme === theme.name" (click)="set('boardTheme', theme.name)">
                <span class="squares"><i [style.background]="theme.light"></i><i [style.background]="theme.dark"></i></span>
                {{ 'settings.theme.' + theme.name | translate }}
              </button>
            }
          </div>
          <label class="field pieces">
            <span>{{ 'settings.pieces' | translate }}</span>
            <select [ngModel]="store.settings().pieceSet" (ngModelChange)="set('pieceSet', $event)">
              @for (set of pieceSets; track set) {
                <option [value]="set">{{ set }}</option>
              }
            </select>
          </label>
        </section>
        <section>
          <h3>{{ 'settings.about' | translate }}</h3>
          <p class="muted">{{ 'settings.aboutText' | translate }}</p>
          <p class="muted small">
            <a href="https://github.com/jonvandorsten-sudo/openingtrainer" target="_blank" rel="noopener">{{ 'settings.source' | translate }}</a> ·
            <a href="privacy.html" target="_blank" rel="noopener">{{ 'settings.privacy' | translate }}</a>
          </p>
          <p class="muted small">{{ 'settings.credits' | translate }}</p>
        </section>
        <div class="dialog-actions">
          <button class="btn danger" (click)="clearAll()">{{ 'settings.danger' | translate }}</button>
          <div class="grow"></div>
          <button class="btn" (click)="close()">{{ 'settings.close' | translate }}</button>
        </div>
      </div>
    </div>
  `,
  styles: [
    `
      section { display: flex; flex-direction: column; gap: 10px; }
      h3 { margin: 0; font-size: 15px; font-weight: 700; }
      p { margin: 0; font-size: 13px; line-height: 1.5; }
      .row { display: flex; gap: 8px; flex-wrap: wrap; }
      .warning { color: var(--error); }
      .message { font-weight: 600; }
      .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px 16px; }
      .field input[type='range'] { height: 24px; padding: 0; border: none; accent-color: var(--accent); }
      .check { display: flex; align-items: center; gap: 8px; font-size: 14px; }
      .check input { accent-color: var(--accent); width: 16px; height: 16px; flex-shrink: 0; }
      .field small { font-size: 11px; }
      .schedule strong { font-size: 13px; padding-top: 6px; }
      .grow { flex: 1; }
      .small { font-size: 12px; }
      .account { align-items: center; justify-content: space-between; font-size: 13px; }
      .account > span { flex: 1; min-width: 200px; }
      .themes { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }
      .theme { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 8px; border: 1px solid var(--line); border-radius: 6px; background: #fff; font-size: 12px; cursor: pointer; }
      .theme.on { border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); font-weight: 600; }
      .squares { display: flex; }
      .squares i { width: 22px; height: 22px; }
      .pieces { max-width: 220px; }
      .history { display: flex; flex-direction: column; gap: 4px; max-height: 220px; overflow: auto; }
      .history-row { display: flex; align-items: center; gap: 12px; font-size: 13px; padding: 9px 0; border-bottom: 1px solid rgba(0, 0, 0, 0.08); }
      .history-row .when { width: 96px; flex-shrink: 0; color: var(--ink-3); font-size: 12px; }
      .history-row .what { flex: 1; min-width: 0; }
      .small-btn { height: 30px; padding: 0 10px; font-size: 12px; flex-shrink: 0; }
      .token summary { cursor: pointer; font-size: 13px; color: var(--accent); font-weight: 600; }
      .token p { margin: 8px 0; }
      .token-input { flex: 1; min-width: 180px; height: 36px; border: 1px solid rgba(0,0,0,0.2); border-radius: 6px; padding: 0 10px; }
      a { color: var(--accent); }
      @media (max-width: 520px) { .grid { grid-template-columns: 1fr; } }
    `,
  ],
})
export class SettingsDialogComponent {
  readonly store = inject(AppStore);
  readonly engine = inject(EngineService);
  readonly lichess = inject(LichessService);
  private readonly nav = inject(NavigationService);
  private readonly i18n = inject(TranslationService);
  readonly message = signal<string | null>(null);
  readonly token = signal('');
  readonly languages = LANGUAGES;
  readonly tokenUrl = `https://lichess.org/account/oauth/token/create?description=${encodeURIComponent(APP_NAME)}`;
  readonly themes = (Object.keys(BOARD_THEMES) as BoardThemeName[]).map((name) => ({ name, ...BOARD_THEMES[name] }));
  readonly pieceSets = PIECE_SETS;

  /** The first reviews under the chosen schedule, e.g. "1, 3, 8, 20, 50 dagen". */
  readonly schedule = computed(() => {
    const settings = this.store.settings();
    const days: number[] = [];
    for (let interval = 0; days.length < 5; ) {
      interval = nextInterval(interval, { firstDays: settings.firstReviewDays, growth: settings.reviewGrowth });
      days.push(interval);
    }
    return this.i18n.translate('settings.scheduleDays', { days: days.join(', ') });
  });

  async useToken(): Promise<void> {
    if (await this.lichess.useToken(this.token())) {
      this.token.set('');
    }
  }

  when(at: number): string {
    return new Date(at).toLocaleString(this.store.settings().language, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  }

  async restore(entry: HistoryEntry): Promise<void> {
    await this.store.restore(entry);
    this.message.set('settings.restored');
  }

  close(): void {
    this.nav.settingsOpen.set(false);
  }

  openFile(): void {
    this.close();
    this.nav.fileOpen.set(true);
  }

  set<K extends keyof Settings>(key: K, value: Settings[K]): void {
    void this.store.updateSettings({ [key]: value } as Partial<Settings>);
  }

  setLanguage(language: Language): void {
    this.set('language', language);
  }

  clamp(value: unknown, min: number, max: number): number {
    const number = Math.round(Number(value));
    return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : min;
  }

  async clearAll(): Promise<void> {
    if (confirm(this.i18n.translate('settings.dangerConfirm'))) {
      await this.store.clearAll();
      this.close();
    }
  }
}
