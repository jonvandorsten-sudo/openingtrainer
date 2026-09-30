import { Injectable } from '@angular/core';
import { GameResult, ImportedGame, MAX_PLIES, TimeClass, movetextToSans } from '../core/game-tree';

interface RawChessComGame {
  url: string;
  pgn?: string;
  time_class?: string;
  rated?: boolean;
  rules?: string;
  end_time?: number;
  white?: { username?: string; rating?: number };
  black?: { username?: string; rating?: number };
}

export class ChessComError extends Error {
  constructor(readonly kind: 'not-found' | 'network') {
    super(kind);
  }
}

/** Public game archives of Chess.com players (no login needed). */
@Injectable({ providedIn: 'root' })
export class ChessComService {
  async games(username: string, max: number, sinceMs: number, onProgress: (count: number) => void, abort?: AbortSignal): Promise<ImportedGame[]> {
    const archives = await this.json<{ archives: string[] }>(`https://api.chess.com/pub/player/${encodeURIComponent(username.toLowerCase())}/games/archives`);
    const games: ImportedGame[] = [];
    for (const archive of [...archives.archives].reverse()) {
      if (abort?.aborted || (max > 0 && games.length >= max) || archiveEndsBefore(archive, sinceMs)) {
        break;
      }
      const month = await this.json<{ games: RawChessComGame[] }>(archive);
      for (const raw of [...month.games].reverse()) {
        const game = toImportedGame(raw);
        if (game && (!sinceMs || (raw.end_time ?? 0) * 1000 >= sinceMs)) {
          games.push(game);
          if (max > 0 && games.length >= max) {
            break;
          }
        }
      }
      onProgress(games.length);
    }
    return games;
  }

  private async json<T>(url: string): Promise<T> {
    let response: Response;
    try {
      response = await fetch(url);
    } catch {
      throw new ChessComError('network');
    }
    if (response.status === 404) {
      throw new ChessComError('not-found');
    }
    if (!response.ok) {
      throw new ChessComError('network');
    }
    return (await response.json()) as T;
  }
}

function toImportedGame(raw: RawChessComGame): ImportedGame | null {
  if ((raw.rules && raw.rules !== 'chess') || !raw.pgn) {
    return null;
  }
  const headers = Object.fromEntries([...raw.pgn.matchAll(/^\[(\w+) "([^"]*)"\]/gm)].map((m) => [m[1], m[2]]));
  if (headers['SetUp'] === '1') {
    return null;
  }
  const movetext = raw.pgn.replace(/^\[[^\]]*\]\s*$/gm, '');
  return {
    id: `chesscom:${raw.url.split('/').pop()}`,
    url: raw.url,
    white: raw.white?.username ?? headers['White'] ?? '?',
    black: raw.black?.username ?? headers['Black'] ?? '?',
    whiteElo: raw.white?.rating,
    blackElo: raw.black?.rating,
    result: (['1-0', '0-1', '1/2-1/2'].includes(headers['Result']) ? headers['Result'] : '*') as GameResult,
    date: (headers['UTCDate'] ?? headers['Date'] ?? '').replace(/\./g, '-'),
    timeClass: chessComTimeClass(raw.time_class),
    rated: raw.rated ?? false,
    moves: movetextToSans(movetext).slice(0, MAX_PLIES),
    playedAt: raw.end_time ? raw.end_time * 1000 : undefined,
  };
}

function chessComTimeClass(timeClass: string | undefined): TimeClass {
  return timeClass === 'bullet' || timeClass === 'blitz' || timeClass === 'rapid' || timeClass === 'daily' ? timeClass : 'classical';
}

/** Archive URLs end in /YYYY/MM. */
function archiveEndsBefore(archive: string, sinceMs: number): boolean {
  if (!sinceMs) {
    return false;
  }
  const [year, month] = archive.split('/').slice(-2).map(Number);
  return new Date(year, month, 1).getTime() < sinceMs;
}
