import { Component, ElementRef, HostListener, inject, input, signal } from '@angular/core';
import { AppStore, LANGUAGES, Language } from '../../services/app-store.service';

/** The language button in the rail and the mobile header, with a menu of all languages. */
@Component({
  selector: 'app-language-menu',
  standalone: true,
  template: `
    <button class="lang" (click)="open.set(!open())">{{ store.settings().language.toUpperCase() }}</button>
    @if (open()) {
      <div class="menu" [class.up]="up()">
        @for (language of languages; track language.code) {
          <button class="item" [class.on]="language.code === store.settings().language" (click)="choose(language.code)">
            <span class="code">{{ language.code.toUpperCase() }}</span>{{ language.name }}
          </button>
        }
      </div>
    }
  `,
  styles: [
    `
      :host { position: relative; display: block; flex-shrink: 0; }
      .lang {
        width: 52px; height: 32px; border-radius: 6px; border: 1px solid #7d877f;
        background: transparent; color: #fff; font-size: 12px; font-weight: 700; cursor: pointer;
      }
      @media (max-width: 900px) { .lang { width: 40px; } }
      .menu {
        position: absolute; top: calc(100% + 6px); right: 0; z-index: 90; min-width: 170px; padding: 6px;
        background: #fff; color: var(--ink); border-radius: 10px; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.22);
      }
      .menu.up { top: auto; bottom: 0; left: calc(100% + 8px); right: auto; }
      .item {
        display: flex; align-items: center; gap: 10px; width: 100%; height: 36px; padding: 0 10px;
        border: none; border-radius: 6px; background: transparent; font-size: 14px; cursor: pointer; text-align: left;
      }
      .item:hover { background: var(--tile); }
      .item.on { background: var(--accent-soft); font-weight: 600; }
      .code { width: 22px; font-size: 11px; font-weight: 700; color: var(--ink-3); }
    `,
  ],
})
export class LanguageMenuComponent {
  /** Opens beside the button instead of below it, for the rail at the bottom of the screen. */
  readonly up = input(false);
  readonly store = inject(AppStore);
  private readonly host = inject(ElementRef<HTMLElement>);
  readonly languages = LANGUAGES;
  readonly open = signal(false);

  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent): void {
    if (!this.host.nativeElement.contains(event.target as Node)) {
      this.open.set(false);
    }
  }

  choose(language: Language): void {
    this.open.set(false);
    void this.store.updateSettings({ language });
  }
}
