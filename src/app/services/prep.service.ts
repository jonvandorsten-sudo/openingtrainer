import { Injectable, inject, signal } from '@angular/core';
import { Chess } from 'chess.js';
import { GameFilter, buildGameTree, filterGames } from '../core/game-tree';
import { writePgn } from '../core/pgn-writer';
import { COLOUR_TAG } from '../core/repertoire';
import { EngineCandidate, PrepOptions, PrepTexts, generatePrep } from '../core/prep-generator';
import { AppStore, PlayerRecord, RepertoireRecord } from './app-store.service';
import { EngineService } from './engine.service';
import { LichessService } from './lichess.service';
import { TranslationService } from './translation.service';

export interface PrepJob {
  positions: number;
}

export interface PrepOutcome {
  record: RepertoireRecord;
  lines: number;
}

const ENGINE_LINES = 3;

/** Generates a repertoire against a loaded player, using their games, your repertoire, Stockfish and optionally the Lichess database. */
@Injectable({ providedIn: 'root' })
export class PrepService {
  private readonly store = inject(AppStore);
  private readonly engine = inject(EngineService);
  private readonly lichess = inject(LichessService);
  private readonly i18n = inject(TranslationService);
  private cancelled = false;

  readonly job = signal<PrepJob | null>(null);

  cancel(): void {
    this.cancelled = true;
  }

  async generate(player: PlayerRecord, filter: GameFilter, options: PrepOptions): Promise<PrepOutcome> {
    this.cancelled = false;
    this.job.set({ positions: 0 });
    try {
      const theirColor = options.side === 'white' ? 'black' : 'white';
      const games = filterGames(player.games, player.username, { ...filter, color: theirColor });
      const repertoire = this.ownRepertoire(options.side);
      const result = await generatePrep(
        options,
        {
          playerName: player.username,
          tree: buildGameTree(games, player.username),
          repertoire: repertoire ? this.store.parse(repertoire) : null,
          engine: (fen, depth) => this.engineCandidates(fen, depth),
          database: options.fill === 'database' && this.lichess.loggedIn() ? (fen) => this.databaseMoves(fen) : null,
          onProgress: (positions) => this.job.set({ positions }),
          isCancelled: () => this.cancelled,
        },
        this.texts(),
      );
      const colour = theirColor === 'white' ? this.i18n.translate('side.white') : this.i18n.translate('side.black');
      const name = this.i18n.translate('prep.name', { name: player.username, colour: colour.toLowerCase() });
      const headers: Record<string, string> = {
        Event: name,
        White: options.side === 'white' ? '?' : player.username,
        Black: options.side === 'black' ? '?' : player.username,
        [COLOUR_TAG]: options.side === 'white' ? 'White' : 'Black',
      };
      const record = await this.store.saveGeneratedRepertoire(name, options.side, writePgn(result.repertoire, { headers }), {
        playerId: player.id,
        playerName: player.username,
        counts: result.counts,
      });
      return { record, lines: this.store.linesOf(record).length };
    } finally {
      this.job.set(null);
    }
  }

  /** The active repertoire when it is for the same colour, otherwise the first one that is. */
  private ownRepertoire(side: 'white' | 'black'): RepertoireRecord | null {
    const active = this.store.active()?.record;
    if (active && active.side === side && !active.prep) {
      return active;
    }
    return this.store.repertoires().find((r) => r.side === side && !r.prep) ?? null;
  }

  private async engineCandidates(fen: string, depth: number): Promise<EngineCandidate[]> {
    const result = await this.engine.evaluate(fen, depth, ENGINE_LINES);
    const candidates: EngineCandidate[] = [];
    for (const line of result?.lines ?? []) {
      const uci = line.pv[0];
      if (!uci) {
        continue;
      }
      try {
        const san = new Chess(fen).move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }).san;
        candidates.push({ san, value: line.value });
      } catch {
        // engine line for another position
      }
    }
    return candidates;
  }

  private async databaseMoves(fen: string): Promise<{ san: string; share: number }[]> {
    const result = await this.lichess.explore('lichess', fen);
    const total = result.moves.reduce((sum, m) => sum + m.white + m.draws + m.black, 0);
    return result.moves.map((m) => ({ san: m.san, share: total ? (100 * (m.white + m.draws + m.black)) / total : 0 }));
  }

  private texts(): PrepTexts {
    const t = (key: string, params?: Record<string, string | number>) => this.i18n.translate(key, params);
    return {
      playerMove: (name, games, total, score) => t('prep.playerMove', { name, games, total, score }),
      databaseMove: (share) => t('prep.databaseMove', { share }),
      engineReply: (value) => t('prep.engineReply', { value }),
      fromRepertoire: t('prep.fromRepertoire'),
      engineMove: (value) => t('prep.engineMove', { value }),
      exploitMove: (name, value, score, games) => t('prep.exploitMove', { name, value, score, games }),
    };
  }
}
