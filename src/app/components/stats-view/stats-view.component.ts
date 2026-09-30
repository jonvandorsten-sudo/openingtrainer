import { Component, computed, inject } from '@angular/core';
import { DAY_MS, isMastered } from '../../core/progress';
import { drillItem, weakMoves } from '../../core/queue';
import { formatMoves } from '../../core/repertoire';
import { accuracy, activityByDay, dayKey, daysBack, eventsBetween, longestStreak, startOfWeek, trainingTimeMs } from '../../core/stats';
import { TranslatePipe } from '../../pipes/translate.pipe';
import { AppStore } from '../../services/app-store.service';
import { NavigationService } from '../../services/navigation.service';
import { TranslationService } from '../../services/translation.service';
import { masteryInk } from '../map-view/map-view.component';
import { SideSwatchComponent, masteryColor } from '../shell/side-swatch.component';

interface Kpi {
  label: string;
  value: string;
  delta: string;
  positive: boolean;
}

const ACTIVITY_COLORS = ['#e5e8e5', '#cfe6d6', '#8cc4a0', '#4f9d6c', '#1f5c39'];
const WEEKS = 20;

@Component({
  selector: 'app-stats-view',
  standalone: true,
  imports: [SideSwatchComponent, TranslatePipe],
  templateUrl: './stats-view.component.html',
  styleUrl: './stats-view.component.scss',
})
export class StatsViewComponent {
  private readonly store = inject(AppStore);
  private readonly nav = inject(NavigationService);
  private readonly i18n = inject(TranslationService);
  readonly activityColors = ACTIVITY_COLORS;
  readonly masteryInk = masteryInk;
  readonly masteryColor = masteryColor;

  private readonly events = computed(() => {
    const ids = new Set(this.store.scoped().map((active) => active.record.id));
    return this.store.events().filter((e) => ids.has(e.repertoireId));
  });

  readonly kpis = computed<Kpi[]>(() => {
    const now = this.store.now();
    const t = (key: string, params?: Record<string, string | number>) => this.i18n.translate(key, params);
    const mastery = this.store.settings().masteryCount;
    const sources = this.store.queueSources();
    const lineTotal = sources.reduce((sum, source) => sum + source.lines.length, 0);
    const masteredAt = sources.flatMap((source) =>
      source.lines.filter((line) => isMastered(source.records[line.key], mastery)).map((line) => source.records[line.key]?.masteredAt ?? 0),
    );
    const masteredThisWeek = masteredAt.filter((at) => at >= now - 7 * DAY_MS).length;

    const recent = accuracy(eventsBetween(this.events(), now - 30 * DAY_MS, now + 1));
    const before = accuracy(eventsBetween(this.events(), now - 60 * DAY_MS, now - 30 * DAY_MS));
    const delta = recent !== null && before !== null ? recent - before : null;

    const all = this.store.events();
    const weekMs = trainingTimeMs(eventsBetween(all, startOfWeek(now), now + 1));

    return [
      { label: t('stats.linesMastered'), value: `${masteredAt.length} / ${lineTotal}`, delta: t('stats.thisWeek', { n: masteredThisWeek }), positive: masteredThisWeek > 0 },
      {
        label: t('stats.accuracy'),
        value: recent === null ? t('stats.noValue') : `${recent}%`,
        delta: delta === null ? t('stats.last30') : t('stats.vsLastMonth', { delta: `${delta >= 0 ? '+' : ''}${delta}%` }),
        positive: (delta ?? 0) > 0,
      },
      { label: t('stats.longestStreak'), value: t('stats.days', { n: longestStreak(all), count: longestStreak(all) }), delta: t('stats.currently', { n: this.store.streak(), count: this.store.streak() }), positive: false },
      { label: t('stats.time'), value: formatDuration(weekMs, this.store.settings().language), delta: t('stats.thisWeekShort'), positive: false },
    ];
  });

  readonly chart = computed(() => {
    const byDay = activityByDay(this.events());
    const days = daysBack(this.store.now(), 30);
    const points = days
      .map((day, i) => {
        const entry = byDay.get(day);
        return entry && entry.moves > 0 ? { x: (i / 29) * 300, value: 100 * (1 - entry.missed / entry.moves) } : null;
      })
      .filter((p): p is { x: number; value: number } => p !== null);
    if (points.length === 0) {
      return null;
    }
    const floor = Math.min(65, Math.floor(Math.min(...points.map((p) => p.value)) / 5) * 5);
    const y = (value: number) => 100 - ((value - floor) / (100 - floor)) * 100;
    const coords = points.map((p) => `${p.x.toFixed(1)},${y(p.value).toFixed(1)}`);
    const first = points[0].x.toFixed(1);
    const last = points[points.length - 1].x.toFixed(1);
    return {
      line: coords.join(' '),
      area: `${first},100 ${coords.join(' ')} ${last},100`,
      single: points.length === 1 ? { x: points[0].x, y: y(points[0].value) } : null,
      upper: Math.round(floor + (100 - floor) * 0.75),
      lower: Math.round(floor + (100 - floor) * 0.25),
    };
  });

  readonly weak = computed(() => {
    const several = this.store.scoped().length > 1;
    return this.store
      .scoped()
      .flatMap((active) =>
        weakMoves(active.lines, active.color, this.store.progressOf(active.record.id).moves).map((weak) => ({
          ...weak,
          source: { id: active.record.id, color: active.color },
          pct: Math.round(weak.rate * 100),
          context: weak.node.parent?.parent ? formatMoves([weak.node.parent]) : '',
          san: weak.node.san,
          name: several ? `${weak.line.name} · ${active.record.name}` : weak.line.name,
        })),
      )
      .sort((a, b) => b.rate - a.rate || b.misses - a.misses)
      .slice(0, 8);
  });

  readonly repertoires = computed(() =>
    this.store.scoped().map((active) => {
      const mastery = this.store.masteryOf(active.record);
      return { id: active.record.id, name: active.record.name, side: active.record.side, count: active.lines.length, mastery, pct: mastery ?? 0 };
    }),
  );

  readonly activity = computed(() => {
    const now = this.store.now();
    const byDay = activityByDay(this.store.events());
    const start = startOfWeek(now) - (WEEKS - 1) * 7 * DAY_MS;
    const today = dayKey(now);
    return Array.from({ length: WEEKS * 7 }, (_, i) => {
      const day = dayKey(start + i * DAY_MS + DAY_MS / 2);
      const count = byDay.get(day)?.lines ?? 0;
      return { day, count, future: day > today, color: ACTIVITY_COLORS[level(count)] };
    });
  });

  drill(weak: ReturnType<StatsViewComponent['weak']>[number]): void {
    this.nav.train(drillItem(weak.source, weak.line, weak.node));
  }
}

function level(count: number): number {
  if (count === 0) {
    return 0;
  }
  if (count <= 2) {
    return 1;
  }
  if (count <= 5) {
    return 2;
  }
  return count <= 10 ? 3 : 4;
}

function formatDuration(ms: number, language: string): string {
  const minutes = Math.round(ms / 60_000);
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const h = language === 'nl' ? 'u' : 'h';
  return hours > 0 ? `${hours}${h} ${rest}m` : `${rest}m`;
}
