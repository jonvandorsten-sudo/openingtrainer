import { TranslationService } from '../../services/translation.service';

const DAY_MS = 24 * 60 * 60 * 1000;

/** "vandaag 14:02", "gisteren 14:02" or "3 dagen geleden". */
export function savedWhen(at: number, now: number, i18n: TranslationService, locale: string): string {
  const time = new Date(at).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
  const days = Math.round((startOfDay(now) - startOfDay(at)) / DAY_MS);
  if (days <= 0) {
    return i18n.translate('file.today', { time });
  }
  if (days === 1) {
    return i18n.translate('file.yesterday', { time });
  }
  return i18n.translate('file.daysAgo', { n: days });
}

function startOfDay(time: number): number {
  const date = new Date(time);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}
