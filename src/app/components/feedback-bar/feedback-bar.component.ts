import { Component, computed, inject, input } from '@angular/core';
import { TranslationService } from '../../services/translation.service';
import { Feedback } from '../../services/training-controller';

type Tone = 'neutral' | 'success' | 'error' | 'info';

@Component({
  selector: 'app-feedback-bar',
  standalone: true,
  template: `<div class="bar" [class]="tone()">{{ text() }}</div>`,
  styles: [
    `
      .bar {
        border-radius: 12px;
        padding: 12px 16px;
        font-size: 14px;
        font-weight: 600;
        min-height: 44px;
        background: #e1e5e1;
        color: var(--ink);
        transition: background 0.2s ease;
      }
      .success { background: var(--accent-soft); color: var(--accent-ink); }
      .error { background: var(--error-strong); color: #fff; }
      .info { background: var(--warn-soft); color: var(--warn-ink); }
    `,
  ],
})
export class FeedbackBarComponent {
  readonly feedback = input.required<Feedback>();
  private readonly i18n = inject(TranslationService);

  readonly tone = computed<Tone>(() => {
    const f = this.feedback();
    switch (f.kind) {
      case 'ok':
        return 'success';
      case 'bad':
        return 'error';
      case 'hint1':
      case 'hint2':
      case 'alt':
      case 'warn':
        return 'info';
      case 'done':
        return f.count ? 'error' : f.hints ? 'info' : 'success';
      default:
        return 'neutral';
    }
  });

  readonly text = computed(() => {
    const f = this.feedback();
    const t = (key: string) => this.i18n.translate(key, { san: f.san ?? '', square: f.square ?? '', n: f.count ?? 0 });
    switch (f.kind) {
      case 'idle':
        return '';
      case 'note':
      case 'warn':
        return f.text ?? '';
      case 'done':
        return f.count ? t('fb.doneN') : f.hints ? this.i18n.translate('fb.doneHints', { n: f.hints }) : t('fb.done0');
      default:
        return t(`fb.${f.kind}`);
    }
  });
}
