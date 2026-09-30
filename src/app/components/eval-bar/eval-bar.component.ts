import { Component, computed, inject, input } from '@angular/core';
import { Evaluation } from '../../core/repertoire';
import { TranslationService } from '../../services/translation.service';

@Component({
  selector: 'app-eval-bar',
  standalone: true,
  template: `
    <div class="track" [class.horizontal]="horizontal()" [class.flipped]="orientation() === 'black'" [title]="tooltip()">
      <div class="white" [style.flex-basis.%]="whiteShare()"></div>
      @if (!horizontal()) {
        <span class="inner-label">{{ label() }}</span>
      }
    </div>
    @if (horizontal()) {
      <span class="value" [title]="tooltip()">{{ label() }}</span>
    }
  `,
  styles: [
    `
      :host {
        position: relative;
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .track {
        position: relative;
        display: flex;
        flex-direction: column-reverse;
        width: 16px;
        height: 100%;
        border-radius: 4px;
        overflow: hidden;
        background: var(--rail-deep);
      }
      .track.flipped {
        flex-direction: column;
      }
      .track.horizontal {
        flex-direction: row;
        width: 100%;
        height: 8px;
      }
      .track.horizontal.flipped {
        flex-direction: row-reverse;
      }
      .white {
        background: #fafafa;
        transition: flex-basis 0.3s ease;
      }
      .inner-label {
        position: absolute;
        left: 0;
        right: 0;
        bottom: 6px;
        text-align: center;
        font-size: 8px;
        letter-spacing: -0.5px;
        white-space: nowrap;
        font-weight: 700;
        color: #fff;
        mix-blend-mode: difference;
      }
      .value {
        font-size: 12px;
        font-weight: 700;
        min-width: 32px;
        text-align: right;
      }
    `,
  ],
})
export class EvalBarComponent {
  readonly evaluation = input<Evaluation | null>(null);
  readonly orientation = input<'white' | 'black'>('white');
  readonly horizontal = input(false);
  private readonly i18n = inject(TranslationService);

  readonly whiteShare = computed(() => Math.max(5, Math.min(95, 50 + (this.evaluation()?.value ?? 0) * 8)));

  readonly label = computed(() => {
    const evaluation = this.evaluation();
    if (!evaluation) {
      return '';
    }
    if (evaluation.mate !== undefined) {
      return evaluation.mate > 0 ? `#${evaluation.mate}` : `-#${-evaluation.mate}`;
    }
    const value = evaluation.value;
    if (Math.abs(value) >= 99) {
      return value > 0 ? '#' : '-#';
    }
    return `${value >= 0 ? '+' : ''}${value.toFixed(1)}`;
  });

  readonly tooltip = computed(() => {
    const evaluation = this.evaluation();
    if (!evaluation) {
      return '';
    }
    if (evaluation.source === 'engine') {
      return evaluation.targetDepth
        ? this.i18n.translate('eval.engineThinking', { value: this.label(), depth: evaluation.depth ?? 0, target: evaluation.targetDepth })
        : this.i18n.translate('eval.engine', { value: this.label(), depth: evaluation.depth ?? 0 });
    }
    return evaluation.depth
      ? this.i18n.translate('eval.fromPgnDepth', { value: this.label(), depth: evaluation.depth })
      : this.i18n.translate('eval.fromPgn', { value: this.label() });
  });
}
