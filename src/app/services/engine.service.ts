import { Injectable, signal } from '@angular/core';
import { EngineInfo, EngineLine, parseEngineLine, sideToMove } from '../core/uci';

export interface EngineEvaluation extends EngineInfo {
  fen: string;
  targetDepth: number;
  done: boolean;
  /** Best lines, ordered; the first one gives the evaluation. */
  lines: EngineLine[];
}

interface Search {
  fen: string;
  depth: number;
  multiPv: number;
}

const ENGINE_URL = 'stockfish/stockfish-19-lite-single.js';

/** Runs Stockfish in a Web Worker. Only the latest requested position is searched; finished results are cached. */
@Injectable({ providedIn: 'root' })
export class EngineService {
  private worker: Worker | null = null;
  private ready = false;
  private configuredMultiPv = 1;
  private searching: Search | null = null;
  private pending: Search | null = null;
  private lines: EngineLine[] = [];
  private latest: EngineEvaluation | null = null;
  private readonly cache = new Map<string, EngineEvaluation>();
  private waiting: { key: string; resolve: (result: EngineEvaluation | null) => void }[] = [];

  readonly evaluation = signal<EngineEvaluation | null>(null);
  readonly failed = signal(false);

  /** Searches a position to the given depth and resolves with the result; an interrupted search resolves with what it found. */
  evaluate(fen: string, depth: number, multiPv = 1): Promise<EngineEvaluation | null> {
    const cached = this.cache.get(cacheKey(fen, multiPv));
    if (cached && cached.depth >= depth) {
      return Promise.resolve(cached);
    }
    if (!this.ensureWorker()) {
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      this.waiting.push({ key: cacheKey(fen, multiPv), resolve });
      this.analyze(fen, depth, multiPv);
    });
  }

  analyze(fen: string, depth: number, multiPv = 1): void {
    const cached = this.cache.get(cacheKey(fen, multiPv));
    if (cached && cached.depth >= depth) {
      this.dropPending(null);
      this.evaluation.set({ ...cached, targetDepth: depth });
      this.stopCurrent();
      return;
    }
    if (this.searching?.fen === fen && this.searching.depth === depth && this.searching.multiPv === multiPv && !this.pending) {
      return;
    }
    this.dropPending(cacheKey(fen, multiPv));
    this.pending = { fen, depth, multiPv };
    this.evaluation.set(cached ? { ...cached, targetDepth: depth, done: false } : null);
    if (!this.ensureWorker()) {
      return;
    }
    if (this.searching) {
      this.stopCurrent();
    } else {
      this.startPending();
    }
  }

  stop(): void {
    this.dropPending(null);
    this.stopCurrent();
  }

  /** A queued search that is replaced never runs; whoever waits for it gets the cached result or nothing. */
  private dropPending(unlessKey: string | null): void {
    const pending = this.pending;
    if (!pending || cacheKey(pending.fen, pending.multiPv) === unlessKey) {
      return;
    }
    this.pending = null;
    const key = cacheKey(pending.fen, pending.multiPv);
    const [dropped, still] = partition(this.waiting, (w) => w.key === key);
    this.waiting = still;
    dropped.forEach((w) => w.resolve(this.cache.get(key) ?? null));
  }

  private ensureWorker(): boolean {
    if (this.worker) {
      return true;
    }
    if (typeof Worker === 'undefined' || typeof WebAssembly === 'undefined') {
      this.failed.set(true);
      return false;
    }
    try {
      this.worker = new Worker(ENGINE_URL);
    } catch {
      this.failed.set(true);
      return false;
    }
    this.worker.onmessage = (event: MessageEvent<string>) => this.onLine(String(event.data));
    this.worker.onerror = () => {
      this.failed.set(true);
      this.waiting.forEach((w) => w.resolve(null));
      this.waiting = [];
    };
    this.worker.postMessage('uci');
    this.worker.postMessage('setoption name Hash value 32');
    this.worker.postMessage('isready');
    return true;
  }

  private onLine(line: string): void {
    if (line === 'readyok') {
      this.ready = true;
      this.startPending();
      return;
    }
    if (line.startsWith('bestmove')) {
      this.finishCurrent();
      this.startPending();
      return;
    }
    const search = this.searching;
    if (!search || this.pending) {
      return;
    }
    const parsed = parseEngineLine(line, sideToMove(search.fen));
    if (!parsed || parsed.multipv > search.multiPv) {
      return;
    }
    this.lines = [...this.lines.filter((l) => l.multipv !== parsed.multipv), parsed].sort((a, b) => a.multipv - b.multipv);
    const main = this.lines[0];
    if (main.multipv === 1) {
      this.latest = { depth: main.depth, value: main.value, mate: main.mate, fen: search.fen, targetDepth: search.depth, done: false, lines: this.lines };
      this.evaluation.set(this.latest);
    }
  }

  private startPending(): void {
    const next = this.pending;
    if (!this.ready || this.searching || !next || !this.worker) {
      return;
    }
    this.pending = null;
    this.searching = next;
    this.lines = [];
    if (next.multiPv !== this.configuredMultiPv) {
      this.worker.postMessage(`setoption name MultiPV value ${next.multiPv}`);
      this.configuredMultiPv = next.multiPv;
    }
    this.worker.postMessage(`position fen ${next.fen}`);
    this.worker.postMessage(`go depth ${next.depth}`);
  }

  private finishCurrent(): void {
    const search = this.searching;
    const last = this.latest;
    this.searching = null;
    this.latest = null;
    if (!search) {
      return;
    }
    const key = cacheKey(search.fen, search.multiPv);
    let finished: EngineEvaluation | null = null;
    if (last?.fen === search.fen) {
      finished = { ...last, done: last.depth >= search.depth };
      this.cache.set(key, finished);
      if (!this.pending) {
        this.evaluation.set(finished);
      }
    }
    const [resolved, still] = partition(this.waiting, (w) => w.key === key);
    this.waiting = still;
    resolved.forEach((w) => w.resolve(finished));
  }

  private stopCurrent(): void {
    if (this.searching) {
      this.worker?.postMessage('stop');
    }
  }
}

function partition<T>(items: T[], test: (item: T) => boolean): [T[], T[]] {
  return [items.filter(test), items.filter((item) => !test(item))];
}

function cacheKey(fen: string, multiPv: number): string {
  return `${multiPv}|${fen}`;
}
