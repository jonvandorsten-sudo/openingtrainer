import { Injectable, computed, signal } from '@angular/core';
import { APP_NAME } from '../app-name';
import { TRANSLATIONS } from './translations';

@Injectable({ providedIn: 'root' })
export class TranslationService {
  private readonly locale = signal('en');
  private readonly dictionary = computed(() => TRANSLATIONS[this.locale()] ?? TRANSLATIONS['en']);

  setLocale(locale: string): void {
    if (locale in TRANSLATIONS) {
      this.locale.set(locale);
    }
  }

  translate(key: string, params?: Record<string, string | number>): string {
    const dictionary = this.dictionary();
    const fallback = TRANSLATIONS['en'];
    const singular = params?.['count'] === 1 ? (dictionary[`${key}.one`] ?? fallback[`${key}.one`]) : undefined;
    let text = singular ?? dictionary[key] ?? fallback[key] ?? key;
    for (const [name, value] of Object.entries({ app: APP_NAME, ...params })) {
      text = text.replaceAll(`{${name}}`, String(value));
    }
    return text;
  }
}
