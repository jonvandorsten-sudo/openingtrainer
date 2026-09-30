import { Signal, computed, effect } from '@angular/core';
import { Evaluation, MoveNode, evaluationAt, hasEvals } from '../core/repertoire';
import { AppStore } from './app-store.service';
import { EngineService } from './engine.service';

export interface BoardEvaluation {
  visible: Signal<boolean>;
  evaluation: Signal<Evaluation | null>;
}

/** Evaluation for the eval bar: live Stockfish or the values stored in the PGN, depending on the settings. Call in an injection context. */
export function boardEvaluation(store: AppStore, engine: EngineService, current: Signal<MoveNode | null>): BoardEvaluation {
  const useEngine = computed(() => store.settings().evalSource === 'stockfish' && !engine.failed());
  const visible = computed(() => {
    const scoped = store.scoped();
    return scoped.length > 0 && store.settings().showEval && (useEngine() || scoped.some((active) => hasEvals(active.repertoire)));
  });

  effect(() => {
    const node = current();
    if (visible() && useEngine() && node) {
      engine.analyze(node.fen, store.settings().engineDepth);
    }
  });

  let lastEngineValue: Evaluation | null = null;
  const evaluation = computed<Evaluation | null>(() => {
    const node = current();
    if (!useEngine()) {
      return evaluationAt(node);
    }
    const result = engine.evaluation();
    if (result && node && result.fen === node.fen) {
      lastEngineValue = {
        value: result.value,
        depth: result.depth,
        mate: result.mate,
        source: 'engine',
        targetDepth: result.done ? undefined : result.targetDepth,
      };
    }
    return lastEngineValue;
  });

  return { visible, evaluation };
}

/** Live Stockfish evaluation of a free position (no repertoire node), for the eval bar. Call in an injection context. */
export function positionEvaluation(store: AppStore, engine: EngineService, fen: Signal<string>): BoardEvaluation {
  const visible = computed(() => store.settings().showEval && !engine.failed());
  effect(() => {
    if (visible()) {
      engine.analyze(fen(), store.settings().engineDepth);
    }
  });
  let last: Evaluation | null = null;
  const evaluation = computed<Evaluation | null>(() => {
    const result = engine.evaluation();
    if (result && result.fen === fen()) {
      last = { value: result.value, depth: result.depth, mate: result.mate, source: 'engine', targetDepth: result.done ? undefined : result.targetDepth };
    }
    return last;
  });
  return { visible, evaluation };
}
