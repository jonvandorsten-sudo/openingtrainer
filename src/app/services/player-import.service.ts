import { Injectable, inject, signal } from '@angular/core';
import { ImportedGame, Platform, indexGames, mergeGames } from '../core/game-tree';
import { AppStore, PlayerRecord } from './app-store.service';
import { ChessComError, ChessComService } from './chesscom.service';
import { LichessError, LichessService } from './lichess.service';

export interface ImportJob {
  playerId: string;
  username: string;
  phase: 'download' | 'index';
  done: number;
  total?: number;
}

export type ImportErrorKind = 'not-found' | 'auth' | 'rate-limit' | 'network' | 'no-games';

export class ImportError extends Error {
  constructor(readonly kind: ImportErrorKind) {
    super(kind);
  }
}

/** Downloads, indexes and stores the games of a player; keeps running when the dialog is closed and can be stopped keeping what arrived. */
@Injectable({ providedIn: 'root' })
export class PlayerImportService {
  private readonly store = inject(AppStore);
  private readonly lichess = inject(LichessService);
  private readonly chesscom = inject(ChessComService);
  private abort: AbortController | null = null;

  readonly job = signal<ImportJob | null>(null);
  /** Id of the player that finished loading last, for views that want to switch to it. */
  readonly completed = signal<string | null>(null);

  /** Loads a new player (or reloads one) and returns its id. */
  async load(platform: Platform, username: string, max: number, sinceMs: number): Promise<string> {
    const id = playerId(platform, username);
    const games = await this.download(id, platform, username, max, sinceMs);
    const existing = this.store.players().find((p) => p.id === id);
    await this.save(id, platform, matchingName(games, username) ?? existing?.username ?? username, mergeGames(existing?.games ?? [], games));
    this.completed.set(id);
    return id;
  }

  /** Fetches only games newer than the newest stored one; returns how many were added. */
  async update(player: PlayerRecord): Promise<number> {
    const newest = Math.max(0, ...player.games.map((g) => g.playedAt ?? 0));
    const since = newest > 0 ? newest + 1 : Date.parse(player.games[0]?.date ?? '') || 0;
    let games: ImportedGame[];
    try {
      games = await this.download(player.id, player.platform, player.username, 0, since);
    } catch (error) {
      if (error instanceof ImportError && error.kind === 'no-games') {
        return 0;
      }
      throw error;
    }
    const merged = mergeGames(player.games, games);
    await this.save(player.id, player.platform, player.username, merged);
    return merged.length - player.games.length;
  }

  stop(): void {
    this.abort?.abort();
  }

  private async download(id: string, platform: Platform, username: string, max: number, sinceMs: number): Promise<ImportedGame[]> {
    this.abort = new AbortController();
    const signal = this.abort.signal;
    this.job.set({ playerId: id, username, phase: 'download', done: 0 });
    try {
      const onProgress = (done: number) => this.job.set({ playerId: id, username, phase: 'download', done });
      const downloaded =
        platform === 'lichess'
          ? await this.lichess.games(username, max, sinceMs, onProgress, signal)
          : await this.chesscom.games(username, max, sinceMs, onProgress, signal);
      if (downloaded.length === 0) {
        throw new ImportError('no-games');
      }
      return await indexGames(downloaded, (done) => this.job.set({ playerId: id, username, phase: 'index', done, total: downloaded.length }));
    } catch (error) {
      if (error instanceof ImportError) {
        throw error;
      }
      if (signal.aborted) {
        throw new ImportError('no-games');
      }
      const kind = error instanceof LichessError || error instanceof ChessComError ? error.kind : 'network';
      throw new ImportError(kind);
    } finally {
      this.job.set(null);
      this.abort = null;
    }
  }

  private async save(id: string, platform: Platform, username: string, games: ImportedGame[]): Promise<void> {
    await this.store.savePlayer({ id, platform, username, games, fetchedAt: Date.now() });
  }
}

export function playerId(platform: Platform, username: string): string {
  return `${platform}:${username.toLowerCase()}`;
}

/** Platforms return the stored capitalisation of the username. */
function matchingName(games: { white: string; black: string }[], username: string): string | undefined {
  const lower = username.toLowerCase();
  const game = games.find((g) => g.white.toLowerCase() === lower || g.black.toLowerCase() === lower);
  return game ? (game.white.toLowerCase() === lower ? game.white : game.black) : undefined;
}
