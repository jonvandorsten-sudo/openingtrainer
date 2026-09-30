import { Injectable, inject, signal } from '@angular/core';
import { QueueItem, TrainingMode } from '../core/queue';
import { TranslationService } from './translation.service';

export interface Toast {
  key: string;
  n?: number;
  undo: boolean;
  /** A button that saves the data file, e.g. in the reminder after several unsaved changes. */
  action?: 'save';
}

const TOAST_MS = 12_000;
/** Deleting at least this many lines asks for confirmation first. */
const CONFIRM_FROM_LINES = 3;

export type View = 'train' | 'map' | 'rep' | 'explore' | 'stats';

/** A free-start session: train the lines of one repertoire from the position reached by `sans`. */
export interface FreeSession {
  repertoireId: string;
  sans: string[];
}

@Injectable({ providedIn: 'root' })
export class NavigationService {
  readonly view = signal<View>('train');
  readonly mode = signal<TrainingMode>('review');
  readonly pendingItem = signal<QueueItem | null>(null);
  readonly session = signal(0);
  readonly mapFocus = signal<string | null>(null);
  /** The position shared by free start and Explore, as SAN moves from the start position. */
  readonly workPosition = signal<string[]>([]);
  readonly boardOrientation = signal<'white' | 'black'>('white');
  /** Whether Explore has put back the position saved in an earlier visit. */
  positionRestored = false;
  /** The repertoire being edited in Explore, or null outside edit mode. */
  readonly editTarget = signal<string | null>(null);
  readonly freeSession = signal<FreeSession | null>(null);
  /** Position the Repertoire view should open at, once. */
  readonly repertoirePath = signal<string[] | null>(null);
  readonly toast = signal<Toast | null>(null);
  private toastTimer?: ReturnType<typeof setTimeout>;
  readonly importOpen = signal(false);
  readonly settingsOpen = signal(false);
  readonly fileOpen = signal(false);
  private readonly i18n = inject(TranslationService);

  startSession(mode: TrainingMode): void {
    this.pendingItem.set(null);
    this.freeSession.set(null);
    this.mode.set(mode);
    this.session.update((s) => s + 1);
  }

  go(view: View): void {
    this.view.set(view);
  }

  train(item: QueueItem): void {
    this.freeSession.set(null);
    this.pendingItem.set(item);
    if (this.mode() === 'free') {
      this.mode.set('all');
    }
    this.view.set('train');
  }

  /** Trains one repertoire's lines from the given position, as chosen in free start or Explore. */
  trainFrom(repertoireId: string, sans: string[]): void {
    this.workPosition.set(sans);
    this.pendingItem.set(null);
    this.mode.set('free');
    this.freeSession.set({ repertoireId, sans });
    this.view.set('train');
  }

  backToFreeStart(): void {
    const session = this.freeSession();
    this.freeSession.set(null);
    if (session) {
      this.workPosition.set(session.sans);
    }
  }

  explore(sans: string[]): void {
    this.workPosition.set(sans);
    this.view.set('explore');
  }

  startEdit(repertoireId: string, sans: string[], orientation: 'white' | 'black'): void {
    this.workPosition.set(sans);
    this.editTarget.set(repertoireId);
    this.boardOrientation.set(orientation);
    this.view.set('explore');
  }

  openInRepertoire(sans: string[]): void {
    this.repertoirePath.set(sans);
    this.view.set('rep');
  }

  /** Shows a short message after a repertoire change, with undo when the change can be undone. */
  notify(key: string, n?: number, undo = true, action?: Toast['action']): void {
    clearTimeout(this.toastTimer);
    this.toast.set({ key, n, undo, action });
    this.toastTimer = setTimeout(() => this.toast.set(null), TOAST_MS);
  }

  /** Asks before deleting a move that takes several lines with it. */
  confirmDelete(move: string, lines: number): boolean {
    return lines < CONFIRM_FROM_LINES || confirm(this.i18n.translate('edit.confirmDelete', { move, n: lines }));
  }

  notifyRemoved(lines: number): void {
    if (lines > 0) {
      this.notify('edit.changed', lines);
    } else {
      this.notify('edit.removed');
    }
  }

  showOnMap(lineKey: string): void {
    this.mapFocus.set(lineKey);
    this.view.set('map');
  }
}
