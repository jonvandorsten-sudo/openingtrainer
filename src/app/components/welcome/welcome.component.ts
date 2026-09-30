import { Component, inject } from '@angular/core';
import { TranslatePipe } from '../../pipes/translate.pipe';
import { LogoMarkComponent } from '../shell/logo-mark.component';
import { NavigationService } from '../../services/navigation.service';

@Component({
  selector: 'app-welcome',
  standalone: true,
  imports: [LogoMarkComponent, TranslatePipe],
  template: `
    <div class="card welcome">
      <app-logo-mark [size]="64" />
      <h1>{{ 'empty.title' | translate }}</h1>
      <p class="muted">{{ 'empty.text' | translate }}</p>
      <div class="row">
        <button class="btn primary" (click)="nav.importOpen.set(true)">{{ 'empty.import' | translate }}</button>
        <button class="btn" (click)="nav.fileOpen.set(true)">{{ 'file.open' | translate }}</button>
      </div>
    </div>
  `,
  styles: [
    `
      .welcome { max-width: 560px; margin: 48px auto; padding: 36px; display: flex; flex-direction: column; align-items: center; gap: 12px; text-align: center; }
      .logo { width: 64px; height: 64px; border-radius: 14px; background: var(--accent); color: #fff; display: flex; align-items: center; justify-content: center; }
      .logo .icon { font-size: 34px; }
      h1 { margin: 8px 0 0; font-size: 24px; font-weight: 500; }
      p { margin: 0; line-height: 1.5; }
      .row { display: flex; gap: 8px; flex-wrap: wrap; justify-content: center; margin-top: 8px; }
      .error { color: var(--error); }
    `,
  ],
})
export class WelcomeComponent {
  readonly nav = inject(NavigationService);
}
