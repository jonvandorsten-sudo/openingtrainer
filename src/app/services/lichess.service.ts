import { Injectable, computed, signal } from '@angular/core';
import { ImportedGame, MAX_PLIES, TimeClass } from '../core/game-tree';

const CLIENT_ID = 'openingtrainer';
const AUTH_KEY = 'opening-trainer.lichess-auth';
const PKCE_KEY = 'opening-trainer.lichess-pkce';

export type ExplorerDatabase = 'lichess' | 'masters';

export interface ExplorerMove {
  uci: string;
  san: string;
  white: number;
  draws: number;
  black: number;
  averageRating?: number;
}

export interface ExplorerGame {
  id: string;
  white: string;
  black: string;
  whiteRating?: number;
  blackRating?: number;
  winner?: 'white' | 'black';
  year?: number;
}

export interface ExplorerResult {
  white: number;
  draws: number;
  black: number;
  moves: ExplorerMove[];
  topGames: ExplorerGame[];
  opening?: { eco: string; name: string };
}

interface LichessAuth {
  token: string;
  username: string;
}

interface RawExplorerResult {
  white: number;
  draws: number;
  black: number;
  moves?: ExplorerMove[];
  topGames?: RawExplorerGame[];
  opening?: { eco: string; name: string } | null;
}

interface RawExplorerGame {
  id: string;
  winner?: 'white' | 'black' | null;
  white?: { name?: string; rating?: number };
  black?: { name?: string; rating?: number };
  year?: number;
}

interface RawLichessGame {
  id: string;
  rated?: boolean;
  variant?: string;
  speed?: string;
  status?: string;
  createdAt?: number;
  winner?: 'white' | 'black';
  moves?: string;
  players?: { white?: { user?: { name?: string }; rating?: number }; black?: { user?: { name?: string }; rating?: number } };
}

export class LichessError extends Error {
  constructor(
    readonly kind: 'auth' | 'rate-limit' | 'not-found' | 'network',
    readonly status?: number,
  ) {
    super(status ? `${kind} (${status})` : kind);
  }
}

/** Lichess asks clients to wait a full minute after a 429 before sending anything else. */
const RATE_LIMIT_PAUSE_MS = 60_000;

/** Login with Lichess (OAuth PKCE, no backend), the opening explorer and game export. */
@Injectable({ providedIn: 'root' })
export class LichessService {
  private readonly auth = signal<LichessAuth | null>(readAuth());
  private readonly explorerCache = new Map<string, ExplorerResult>();
  private readonly pausedUntil = signal(0);
  private readonly clock = signal(Date.now());
  private pauseTimer?: ReturnType<typeof setInterval>;

  readonly username = computed(() => this.auth()?.username ?? null);
  readonly loggedIn = computed(() => this.auth() !== null);
  readonly loginError = signal<string | null>(null);
  /** Seconds left before Lichess may be asked again after a rate limit; 0 when requests are allowed. */
  readonly pauseSeconds = computed(() => Math.max(0, Math.ceil((this.pausedUntil() - this.clock()) / 1000)));

  async login(): Promise<void> {
    const verifier = randomString(64);
    const state = randomString(16);
    sessionStorage.setItem(PKCE_KEY, JSON.stringify({ verifier, state }));
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: CLIENT_ID,
      redirect_uri: redirectUri(),
      code_challenge_method: 'S256',
      code_challenge: await challengeFor(verifier),
      state,
    });
    location.assign(`https://lichess.org/oauth?${params}`);
  }

  /** Completes the login when Lichess redirects back with ?code=…&state=…; returns whether a login happened. */
  async completeLogin(): Promise<boolean> {
    const query = new URLSearchParams(location.search);
    const code = query.get('code');
    const state = query.get('state');
    const stored = JSON.parse(sessionStorage.getItem(PKCE_KEY) ?? 'null') as { verifier: string; state: string } | null;
    if (!code && !query.get('error')) {
      return false;
    }
    history.replaceState(null, '', location.pathname + location.hash);
    sessionStorage.removeItem(PKCE_KEY);
    if (!code || !stored || stored.state !== state) {
      return false;
    }
    const response = await fetch('https://lichess.org/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: stored.verifier, redirect_uri: redirectUri(), client_id: CLIENT_ID }),
    });
    if (!response.ok) {
      this.loginError.set(`token ${response.status}: ${(await response.text()).slice(0, 200)}`);
      throw new LichessError('auth', response.status);
    }
    const token = ((await response.json()) as { access_token: string }).access_token;
    const account = await fetch('https://lichess.org/api/account', { headers: { Authorization: `Bearer ${token}` } });
    if (!account.ok) {
      this.loginError.set(`account ${account.status}`);
      throw new LichessError('auth', account.status);
    }
    this.loginError.set(null);
    this.setAuth({ token, username: ((await account.json()) as { username: string }).username });
    return true;
  }

  /** Alternative to the OAuth redirect: a personal API token created on lichess.org (no scopes needed). */
  async useToken(token: string): Promise<boolean> {
    const trimmed = token.trim();
    if (!/^[A-Za-z0-9_]+$/.test(trimmed)) {
      this.loginError.set('token format');
      return false;
    }
    const account = await fetch('https://lichess.org/api/account', { headers: { Authorization: `Bearer ${trimmed}` } }).catch(() => null);
    if (!account?.ok) {
      this.loginError.set(`account ${account?.status ?? 'network'}`);
      return false;
    }
    this.loginError.set(null);
    this.setAuth({ token: trimmed, username: ((await account.json()) as { username: string }).username });
    return true;
  }

  async logout(): Promise<void> {
    const token = this.auth()?.token;
    this.setAuth(null);
    if (token) {
      await fetch('https://lichess.org/api/token', { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }).catch(() => undefined);
    }
  }

  async explore(database: ExplorerDatabase, fen: string): Promise<ExplorerResult> {
    const params = new URLSearchParams({ fen, moves: '15', topGames: '8', recentGames: '0' });
    if (database === 'lichess') {
      params.set('speeds', 'blitz,rapid,classical');
      params.set('ratings', '1800,2000,2200,2500');
    }
    const url = `https://explorer.lichess.org/${database}?${params}`;
    const cached = this.explorerCache.get(url);
    if (cached) {
      return cached;
    }
    const response = await this.authorizedFetch(url);
    const raw = (await response.json()) as RawExplorerResult;
    const result: ExplorerResult = {
      white: raw.white,
      draws: raw.draws,
      black: raw.black,
      moves: raw.moves ?? [],
      opening: raw.opening ?? undefined,
      topGames: (raw.topGames ?? []).map((game) => ({
        id: game.id,
        white: game.white?.name ?? '?',
        black: game.black?.name ?? '?',
        whiteRating: game.white?.rating,
        blackRating: game.black?.rating,
        winner: game.winner ?? undefined,
        year: game.year,
      })),
    };
    this.explorerCache.set(url, result);
    return result;
  }

  async games(username: string, max: number, sinceMs: number, onProgress: (count: number) => void, abort?: AbortSignal): Promise<ImportedGame[]> {
    const params = new URLSearchParams({ moves: 'true', pgnInJson: 'false', clocks: 'false', evals: 'false', opening: 'false' });
    if (max > 0) {
      params.set('max', String(max));
    }
    if (sinceMs > 0) {
      params.set('since', String(sinceMs));
    }
    const response = await this.authorizedFetch(`https://lichess.org/api/games/user/${encodeURIComponent(username)}?${params}`, 'application/x-ndjson', abort);
    const games: ImportedGame[] = [];
    await readNdjson<RawLichessGame>(response, (raw) => {
      const game = toImportedGame(raw);
      if (game) {
        games.push(game);
        onProgress(games.length);
      }
    });
    return games;
  }

  private async authorizedFetch(url: string, accept = 'application/json', abort?: AbortSignal): Promise<Response> {
    const token = this.auth()?.token;
    if (!token) {
      throw new LichessError('auth');
    }
    if (this.pauseSeconds() > 0) {
      throw new LichessError('rate-limit', 429);
    }
    let response: Response;
    try {
      response = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: accept }, signal: abort });
    } catch {
      throw new LichessError('network');
    }
    if (response.status === 401) {
      await this.forgetTokenIfRevoked(token);
      throw new LichessError('auth', 401);
    }
    if (response.status === 429) {
      this.pause();
      throw new LichessError('rate-limit', 429);
    }
    if (response.status === 404) {
      throw new LichessError('not-found', 404);
    }
    if (!response.ok) {
      throw new LichessError('network', response.status);
    }
    return response;
  }

  /** A 401 from one endpoint does not always mean the login is gone; only drop the token when Lichess no longer knows it. */
  private async forgetTokenIfRevoked(token: string): Promise<void> {
    const check = await fetch('https://lichess.org/api/account', { headers: { Authorization: `Bearer ${token}` } }).catch(() => null);
    if (check?.status === 401) {
      this.setAuth(null);
    }
  }

  private pause(): void {
    this.pausedUntil.set(Date.now() + RATE_LIMIT_PAUSE_MS);
    this.clock.set(Date.now());
    clearInterval(this.pauseTimer);
    this.pauseTimer = setInterval(() => {
      this.clock.set(Date.now());
      if (this.pauseSeconds() === 0) {
        clearInterval(this.pauseTimer);
      }
    }, 1000);
  }

  private setAuth(auth: LichessAuth | null): void {
    this.auth.set(auth);
    try {
      if (auth) {
        localStorage.setItem(AUTH_KEY, JSON.stringify(auth));
      } else {
        localStorage.removeItem(AUTH_KEY);
      }
    } catch {
      // storage unavailable: the login lasts for this visit only
    }
  }
}

function toImportedGame(raw: RawLichessGame): ImportedGame | null {
  if ((raw.variant && raw.variant !== 'standard') || !raw.moves || raw.status === 'aborted' || raw.status === 'noStart') {
    return null;
  }
  return {
    id: `lichess:${raw.id}`,
    url: `https://lichess.org/${raw.id}`,
    white: raw.players?.white?.user?.name ?? '?',
    black: raw.players?.black?.user?.name ?? '?',
    whiteElo: raw.players?.white?.rating,
    blackElo: raw.players?.black?.rating,
    result: raw.winner === 'white' ? '1-0' : raw.winner === 'black' ? '0-1' : '1/2-1/2',
    date: new Date(raw.createdAt ?? 0).toISOString().slice(0, 10),
    timeClass: lichessTimeClass(raw.speed),
    rated: raw.rated ?? false,
    moves: raw.moves.split(' ').slice(0, MAX_PLIES),
    playedAt: raw.createdAt,
  };
}

function lichessTimeClass(speed: string | undefined): TimeClass {
  switch (speed) {
    case 'ultraBullet':
    case 'bullet':
      return 'bullet';
    case 'blitz':
      return 'blitz';
    case 'rapid':
      return 'rapid';
    case 'correspondence':
      return 'daily';
    default:
      return 'classical';
  }
}

async function readNdjson<T>(response: Response, onItem: (item: T) => void): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) {
    return;
  }
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try {
      chunk = await reader.read();
    } catch {
      return;
    }
    const { done, value } = chunk;
    buffer += decoder.decode(value, { stream: !done });
    const lines = buffer.split('\n');
    buffer = done ? '' : (lines.pop() ?? '');
    for (const line of lines) {
      if (line.trim()) {
        onItem(JSON.parse(line) as T);
      }
    }
    if (done) {
      return;
    }
  }
}

function redirectUri(): string {
  return new URL('.', document.baseURI).href;
}

function readAuth(): LichessAuth | null {
  try {
    return JSON.parse(localStorage.getItem(AUTH_KEY) ?? 'null') as LichessAuth | null;
  } catch {
    return null;
  }
}

function randomString(bytes: number): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

async function challengeFor(verifier: string): Promise<string> {
  return base64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
}

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
