import { Component, OnInit, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { GameFilter } from '../../core/game-tree';
import { PrepOptions } from '../../core/prep-generator';
import { TranslatePipe } from '../../pipes/translate.pipe';
import { AppStore, PlayerRecord } from '../../services/app-store.service';
import { LichessService } from '../../services/lichess.service';
import { NavigationService } from '../../services/navigation.service';
import { PrepOutcome, PrepService } from '../../services/prep.service';

@Component({
  selector: 'app-prep-dialog',
  standalone: true,
  imports: [FormsModule, TranslatePipe],
  template: `
    <div class="backdrop" (click)="close()">
      <div class="dialog" (click)="$event.stopPropagation()">
        <div class="dialog-head">
          <span>{{ 'prep.title' | translate: { name: player().username } }}</span>
          <button class="icon-btn" (click)="close()"><span class="icon">close</span></button>
        </div>

        @if (outcome(); as done) {
          <div class="result">
            <span class="icon big">task_alt</span>
            <strong>{{ done.record.name }}</strong>
            <p class="muted">{{ 'prep.done' | translate: { lines: done.lines } }}</p>
          </div>
          <div class="dialog-actions">
            <button class="btn" (click)="show()">{{ 'prep.show' | translate }}</button>
            <button class="btn primary" (click)="train()">{{ 'prep.train' | translate: { name: player().username } }}</button>
          </div>
        } @else {
          <p class="muted">{{ 'prep.text' | translate: { name: player().username } }}</p>

          <div class="field">
            <span>{{ 'import.iPlay' | translate }}</span>
            <div class="segmented tall">
              <button [class.on]="options().side === 'white'" (click)="set({ side: 'white' })">{{ 'side.white' | translate }}</button>
              <button [class.on]="options().side === 'black'" (click)="set({ side: 'black' })">{{ 'side.black' | translate }}</button>
            </div>
          </div>

          <div class="grid">
            <label class="field">
              <span>{{ 'prep.depth' | translate }}</span>
              <select [ngModel]="options().maxMoves" (ngModelChange)="set({ maxMoves: +$event })">
                @for (n of [8, 10, 12, 15, 20]; track n) {
                  <option [value]="n">{{ 'prep.moves' | translate: { n } }}</option>
                }
              </select>
            </label>
            <label class="field">
              <span>{{ 'prep.replies' | translate }}</span>
              <select [ngModel]="options().maxReplies" (ngModelChange)="set({ maxReplies: +$event })">
                @for (n of [1, 2, 3, 4, 5]; track n) {
                  <option [value]="n">{{ n }}</option>
                }
              </select>
            </label>
            <label class="field">
              <span>{{ 'prep.minGames' | translate }}</span>
              <select [ngModel]="options().minGames" (ngModelChange)="set({ minGames: +$event })">
                @for (n of [2, 3, 5, 10]; track n) {
                  <option [value]="n">{{ n }}</option>
                }
              </select>
            </label>
            <label class="field">
              <span>{{ 'prep.minShare' | translate }}</span>
              <select [ngModel]="options().minShare" (ngModelChange)="set({ minShare: +$event })">
                @for (n of [5, 10, 20, 30]; track n) {
                  <option [value]="n">{{ n }}%</option>
                }
              </select>
            </label>
            <label class="field wide">
              <span>{{ 'prep.engineDepth' | translate: { depth: options().engineDepth } }}</span>
              <input type="range" min="8" max="20" step="1" [ngModel]="options().engineDepth" (ngModelChange)="set({ engineDepth: +$event })" />
            </label>
          </div>

          <label class="check"><input type="checkbox" [ngModel]="options().useRepertoire" (ngModelChange)="set({ useRepertoire: $event })" />{{ 'prep.useRepertoire' | translate }}</label>
          <label class="check"><input type="checkbox" [ngModel]="options().exploit" (ngModelChange)="set({ exploit: $event })" />{{ 'prep.exploit' | translate: { name: player().username } }}</label>
          <label class="field">
            <span>{{ 'prep.fill' | translate: { name: player().username } }}</span>
            <select [ngModel]="options().fill" (ngModelChange)="set({ fill: $event })">
              <option value="database" [disabled]="!lichess.loggedIn()">{{ 'prep.fillDatabase' | translate }}</option>
              <option value="engine">{{ 'prep.fillEngine' | translate }}</option>
              <option value="none">{{ 'prep.fillNone' | translate }}</option>
            </select>
          </label>

          @if (prep.job(); as job) {
            <div class="notice">
              <span class="icon spin">sync</span>
              <span class="grow">{{ 'prep.progress' | translate: { n: job.positions } }}</span>
              <button class="btn" (click)="prep.cancel()">{{ 'pl.stop' | translate }}</button>
            </div>
          }
          @if (error()) {
            <div class="notice error">{{ 'prep.error' | translate }}</div>
          }

          <div class="dialog-actions">
            <button class="btn" (click)="close()">{{ 'import.cancel' | translate }}</button>
            <button class="btn primary" [disabled]="!!prep.job()" (click)="generate()">{{ 'prep.generate' | translate }}</button>
          </div>
        }
      </div>
    </div>
  `,
  styles: [
    `
      p { margin: 0; font-size: 13px; line-height: 1.5; }
      .segmented.tall { height: 40px; background: var(--surface-bar); }
      .segmented.tall button { height: 36px; font-size: 14px; }
      .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px 16px; }
      .wide { grid-column: 1 / 3; }
      .field input[type='range'] { height: 24px; padding: 0; border: none; accent-color: var(--accent); }
      .check { display: flex; align-items: center; gap: 8px; font-size: 14px; }
      .check input { accent-color: var(--accent); width: 16px; height: 16px; }
      .check.disabled { opacity: 0.5; }
      .notice { display: flex; align-items: center; gap: 10px; font-size: 13px; padding: 10px 12px; border-radius: 8px; background: var(--accent-soft); color: var(--accent-ink); }
      .notice.error { background: #ffebee; color: var(--error); }
      .grow { flex: 1; }
      .spin { animation: spin 1.2s linear infinite; }
      @keyframes spin { to { transform: rotate(360deg); } }
      .result { display: flex; flex-direction: column; align-items: center; gap: 6px; text-align: center; padding: 12px 0; }
      .big { font-size: 44px; color: var(--accent); }
      @media (max-width: 520px) { .grid { grid-template-columns: 1fr; } .wide { grid-column: auto; } }
    `,
  ],
})
export class PrepDialogComponent implements OnInit {
  readonly player = input.required<PlayerRecord>();
  readonly filter = input.required<GameFilter>();
  readonly side = input.required<'white' | 'black'>();
  readonly closed = output<void>();

  readonly prep = inject(PrepService);
  readonly lichess = inject(LichessService);
  private readonly store = inject(AppStore);
  private readonly nav = inject(NavigationService);

  readonly options = signal<PrepOptions>({
    side: 'black',
    maxMoves: 12,
    minGames: 3,
    minShare: 10,
    maxReplies: 3,
    useRepertoire: true,
    exploit: true,
    fill: 'engine',
    engineDepth: 14,
    maxOwnMoves: 300,
  });
  readonly outcome = signal<PrepOutcome | null>(null);
  readonly error = signal(false);

  ngOnInit(): void {
    this.set({ side: this.side(), engineDepth: Math.min(16, this.store.settings().engineDepth), fill: this.lichess.loggedIn() ? 'database' : 'engine' });
  }

  set(patch: Partial<PrepOptions>): void {
    this.options.update((o) => ({ ...o, ...patch }));
  }

  close(): void {
    if (this.prep.job()) {
      this.prep.cancel();
    }
    this.closed.emit();
  }

  async generate(): Promise<void> {
    this.error.set(false);
    try {
      this.outcome.set(await this.prep.generate(this.player(), this.filter(), this.options()));
    } catch {
      this.error.set(true);
    }
  }

  train(): void {
    this.nav.startSession('all');
    this.nav.go('train');
    this.closed.emit();
  }

  show(): void {
    this.nav.go('rep');
    this.closed.emit();
  }
}
