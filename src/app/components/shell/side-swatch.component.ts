import { Component, computed, input } from '@angular/core';
import { Side } from '../../core/repertoire';

/** Mastery colour of the repertoire picker and lists: green, amber, red, grey when unknown. */
export function masteryColor(mastery: number | null): string {
  if (mastery === null) {
    return '#9aa39c';
  }
  return mastery >= 80 ? '#2f7d4e' : mastery >= 60 ? '#c07a00' : '#d32f2f';
}

/** Square in the colour you play; `side` null shows the split white/black swatch for several repertoires. */
@Component({
  selector: 'app-side-swatch',
  standalone: true,
  template: `@if (icon()) {<span class="icon">{{ icon() }}</span>}`,
  styles: [
    `
      :host {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
        border-radius: 3px;
        box-sizing: border-box;
      }
      :host(.white) { background: #fff; box-shadow: inset 0 0 0 1.5px #9aa39c; color: #2b322e; }
      :host(.black) { background: #2b322e; color: #fff; }
      :host(.both) { background: linear-gradient(135deg, #fff 50%, #2b322e 50%); box-shadow: inset 0 0 0 1.5px #9aa39c; }
      .icon { font-size: 60%; }
    `,
  ],
  host: {
    '[class.white]': "side() === 'white'",
    '[class.black]': "side() === 'black'",
    '[class.both]': 'side() === null',
    '[style.width.px]': 'size()',
    '[style.height.px]': 'size()',
    '[style.border-radius.px]': 'radius()',
    '[style.font-size.px]': 'size()',
  },
})
export class SideSwatchComponent {
  readonly side = input<Side | null>(null);
  readonly size = input(12);
  readonly icon = input('');
  readonly radius = computed(() => (this.size() >= 24 ? 8 : 3));
}
