import { Component, input } from '@angular/core';

/** The logo: a knight's L on a 3×3 piece of board, white on the accent green. */
@Component({
  selector: 'app-logo-mark',
  standalone: true,
  template: `
    <svg viewBox="0 0 30 30" [attr.width]="size() * 0.56" [attr.height]="size() * 0.56" aria-hidden="true">
      @for (cell of cells; track $index) {
        <rect [attr.x]="cell.x" [attr.y]="cell.y" width="8" height="8" rx="1.5" fill="#fff" [attr.fill-opacity]="cell.on ? 1 : 0.22" />
      }
    </svg>
  `,
  styles: [
    `
      :host { display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; background: var(--accent); }
    `,
  ],
  host: {
    '[style.width.px]': 'size()',
    '[style.height.px]': 'size()',
    '[style.border-radius.px]': 'size() >= 40 ? 10 : 7',
  },
})
export class LogoMarkComponent {
  readonly size = input(52);

  /** The left column and the top-middle cell form the knight's L. */
  readonly cells = [0, 1, 2].flatMap((row) => [0, 1, 2].map((col) => ({ x: col * 11, y: row * 11, on: col === 0 || (row === 0 && col === 1) })));
}
