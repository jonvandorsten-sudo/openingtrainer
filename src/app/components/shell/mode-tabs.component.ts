import { Component, computed, inject } from '@angular/core';
import { TrainingMode } from '../../core/queue';
import { TranslatePipe } from '../../pipes/translate.pipe';
import { AppStore } from '../../services/app-store.service';
import { NavigationService } from '../../services/navigation.service';

interface ModeTab {
  key: TrainingMode;
  label: string;
  count: number | string | null;
  icon?: string;
}

@Component({
  selector: 'app-mode-tabs',
  standalone: true,
  imports: [TranslatePipe],
  template: `
    <div class="segmented">
      @for (mode of modes(); track mode.key) {
        <button [class.on]="nav.mode() === mode.key" [title]="mode.key === 'random' ? ('mode.randomHint' | translate) : ''" (click)="select(mode.key)">
          @if (mode.icon) {
            <span class="icon">{{ mode.icon }}</span>
          }
          {{ mode.label | translate }}
          @if (mode.count !== null) {
            <span class="badge">{{ mode.count }}</span>
          }
        </button>
      }
    </div>
  `,
  styles: [
    `
      :host { display: block; min-width: 0; }
      .segmented { overflow-x: auto; scrollbar-width: none; }
      .segmented button { flex: 1 0 auto; gap: 6px; }
      .segmented .icon { font-size: 16px; }
      @media (max-width: 900px) {
        .segmented { mask-image: linear-gradient(to right, #000 82%, transparent); padding-right: 24px; }
      }
    `,
  ],
})
export class ModeTabsComponent {
  readonly nav = inject(NavigationService);
  private readonly store = inject(AppStore);

  readonly modes = computed<ModeTab[]>(() => [
    { key: 'free', label: 'mode.free', count: null },
    { key: 'review', label: 'mode.review', count: this.store.dueCount() },
    { key: 'weak', label: 'mode.weak', count: this.store.weakCount() },
    { key: 'all', label: 'mode.all', count: this.store.lineCount() },
    { key: 'random', label: 'mode.random', count: '∞' },
  ]);

  select(mode: TrainingMode): void {
    this.nav.startSession(mode);
  }
}
