import { Injectable, effect, inject, signal, untracked } from '@angular/core';
import { APP_NAME, APP_SLUG } from '../app-name';
import { extractLines } from '../core/lines';
import { parseRepertoire } from '../core/repertoire';
import { AppStore, Backup } from './app-store.service';
import { downloadText, pickTextFile } from './files';
import { NavigationService } from './navigation.service';

export interface FileState {
  unsaved: number;
  lastSavedAt: number | null;
  savedName: string | null;
  remind: boolean;
}

/** A picked file waiting for confirmation, because loading it replaces everything in the browser. */
export interface PendingLoad {
  name: string;
  text: string;
  repertoires: number;
  lines: number | null;
}

interface SaveFileHandle {
  name: string;
  queryPermission(options: { mode: 'readwrite' }): Promise<PermissionState>;
  requestPermission(options: { mode: 'readwrite' }): Promise<PermissionState>;
  createWritable(): Promise<{ write(data: string): Promise<void>; close(): Promise<void> }>;
}

type SaveFilePicker = (options: { suggestedName: string; types: { description: string; accept: Record<string, string[]> }[] }) => Promise<SaveFileHandle>;

const REMIND_EVERY = 10;
const LINKED_WRITE_DELAY_MS = 1000;
const LINKED_NAME = `${APP_SLUG}.json`;

/** Saving and loading the user's data file: the only copy outside this browser, as the app has no server. */
@Injectable({ providedIn: 'root' })
export class FileSyncService {
  private readonly store = inject(AppStore);
  private readonly nav = inject(NavigationService);
  private handle: SaveFileHandle | null = null;
  private writeTimer?: ReturnType<typeof setTimeout>;
  private seenRevision: number | null = null;

  readonly state = signal<FileState>({ unsaved: 0, lastSavedAt: null, savedName: null, remind: true });
  readonly linkedName = signal<string | null>(null);
  /** Linked, but the browser asks for permission again in a new session. */
  readonly needsPermission = signal(false);
  readonly pending = signal<PendingLoad | null>(null);
  readonly loadError = signal(false);
  readonly canLink = typeof window !== 'undefined' && 'showSaveFilePicker' in window;

  constructor() {
    effect(() => {
      const revision = this.store.revision();
      if (!this.store.ready()) {
        return;
      }
      untracked(() => this.onChange(revision));
    });
    window.addEventListener('beforeunload', (event) => {
      if (this.state().unsaved > 0 && this.state().remind) {
        event.preventDefault();
      }
    });
  }

  async init(): Promise<void> {
    const saved = await this.store.loadViewState<FileState>('file');
    if (saved) {
      this.state.set({ ...this.state(), ...saved });
    }
    const handle = await this.store.loadViewState<SaveFileHandle>('fileHandle');
    if (handle && typeof handle.queryPermission === 'function') {
      this.handle = handle;
      this.linkedName.set(handle.name);
      this.needsPermission.set((await handle.queryPermission({ mode: 'readwrite' })) !== 'granted');
    }
    this.seenRevision = this.store.revision();
  }

  /** Saves to the linked file, or downloads a dated file. */
  async save(): Promise<void> {
    if (this.handle && !this.needsPermission()) {
      await this.writeLinked();
      return;
    }
    const name = `${APP_SLUG}-${new Date().toISOString().slice(0, 10)}.json`;
    downloadText(name, this.backupText(), 'application/json');
    await this.markSaved(name);
  }

  async pick(): Promise<void> {
    this.loadError.set(false);
    const file = await pickTextFile('.json,application/json');
    if (!file) {
      return;
    }
    try {
      const backup = JSON.parse(file.text) as Partial<Backup>;
      if (backup.app !== 'opening-trainer' || !Array.isArray(backup.repertoires)) {
        throw new Error('not-a-backup');
      }
      this.pending.set({ name: file.name, text: file.text, repertoires: backup.repertoires.length, lines: null });
      setTimeout(() => this.countLines(file.text, backup), 0);
    } catch {
      this.loadError.set(true);
    }
  }

  async confirmLoad(): Promise<void> {
    const pending = this.pending();
    if (!pending) {
      return;
    }
    try {
      await this.store.importBackup(pending.text);
      this.pending.set(null);
      await this.markSaved(pending.name);
    } catch {
      this.loadError.set(true);
    }
  }

  cancelLoad(): void {
    this.pending.set(null);
  }

  /** Links a file on disk (Chrome, Edge); from then on every change is written to it. */
  async link(): Promise<void> {
    const picker = (window as unknown as { showSaveFilePicker?: SaveFilePicker }).showSaveFilePicker;
    if (!picker) {
      return;
    }
    try {
      this.handle = await picker({ suggestedName: LINKED_NAME, types: [{ description: APP_NAME, accept: { 'application/json': ['.json'] } }] });
    } catch {
      return;
    }
    this.linkedName.set(this.handle.name);
    this.needsPermission.set(false);
    await this.store.saveViewState('fileHandle', this.handle);
    await this.writeLinked();
  }

  async grantPermission(): Promise<void> {
    if (this.handle && (await this.handle.requestPermission({ mode: 'readwrite' })) === 'granted') {
      this.needsPermission.set(false);
      await this.writeLinked();
    }
  }

  async unlink(): Promise<void> {
    this.handle = null;
    this.linkedName.set(null);
    this.needsPermission.set(false);
    await this.store.saveViewState('fileHandle', null);
  }

  async setRemind(remind: boolean): Promise<void> {
    await this.saveState({ ...this.state(), remind });
  }

  private onChange(revision: number): void {
    if (this.seenRevision === null || revision === this.seenRevision) {
      return;
    }
    this.seenRevision = revision;
    if (this.handle && !this.needsPermission()) {
      clearTimeout(this.writeTimer);
      this.writeTimer = setTimeout(() => void this.writeLinked(), LINKED_WRITE_DELAY_MS);
      return;
    }
    const unsaved = this.state().unsaved + 1;
    void this.saveState({ ...this.state(), unsaved });
    if (this.state().remind && unsaved % REMIND_EVERY === 0) {
      this.nav.notify('file.remindToast', unsaved, false, 'save');
    }
  }

  private async writeLinked(): Promise<void> {
    if (!this.handle) {
      return;
    }
    try {
      const writable = await this.handle.createWritable();
      await writable.write(this.backupText());
      await writable.close();
      await this.markSaved(this.handle.name);
    } catch {
      this.needsPermission.set(true);
    }
  }

  private async markSaved(name: string): Promise<void> {
    this.seenRevision = this.store.revision();
    await this.saveState({ ...this.state(), unsaved: 0, lastSavedAt: Date.now(), savedName: name });
  }

  private async saveState(state: FileState): Promise<void> {
    this.state.set(state);
    await this.store.saveViewState('file', state);
  }

  private backupText(): string {
    return JSON.stringify(this.store.exportBackup(), null, 1);
  }

  private countLines(text: string, backup: Partial<Backup>): void {
    let lines = 0;
    for (const record of backup.repertoires ?? []) {
      try {
        lines += extractLines(parseRepertoire(record.pgn), record.side, this.store.settings().trainDepth).length;
      } catch {
        // an unreadable repertoire adds no lines to the preview
      }
    }
    const pending = this.pending();
    if (pending?.text === text) {
      this.pending.set({ ...pending, lines });
    }
  }
}
