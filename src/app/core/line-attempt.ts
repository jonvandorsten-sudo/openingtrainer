import { TrainingLine } from './lines';
import { MoveNode } from './repertoire';

export type MoveVerdict = 'correct' | 'alternative' | 'wrong';

export interface MoveInput {
  from: string;
  to: string;
}

export interface PlayerMoveResult {
  verdict: MoveVerdict;
  expected: MoveNode;
  /** Whether the player needed a wrong try or a hint before finding this move. */
  missed: boolean;
}

export type HintStep = { level: 1; square: string } | { level: 2; move: MoveNode };

/** Walks one training line from `startIndex`: plays the opponent's moves and judges the player's moves. */
export class LineAttempt {
  private played: number;
  private hintLevel = 0;
  private currentMoveMissed = false;
  private peekedAtLine = false;

  correct = 0;
  mistakes = 0;
  hints = 0;

  constructor(
    readonly line: TrainingLine,
    readonly playerColor: 'w' | 'b',
    readonly startIndex = 0,
  ) {
    this.played = Math.min(startIndex, line.moves.length);
  }

  get playedMoves(): MoveNode[] {
    return this.line.moves.slice(0, this.played);
  }

  get remainingMoves(): MoveNode[] {
    return this.line.moves.slice(this.played);
  }

  get currentNode(): MoveNode {
    return this.played === 0 ? this.line.root : this.line.moves[this.played - 1];
  }

  get expected(): MoveNode | null {
    return this.line.moves[this.played] ?? null;
  }

  get isComplete(): boolean {
    return this.played >= this.line.moves.length;
  }

  get isPlayerTurn(): boolean {
    return this.expected?.color === this.playerColor;
  }

  /** A line counts as known only without mistakes and without hints. */
  get wasFlawless(): boolean {
    return this.mistakes === 0 && this.hints === 0;
  }

  get peeked(): boolean {
    return this.peekedAtLine;
  }

  playOpponentMove(): MoveNode | null {
    const next = this.expected;
    if (!next || next.color === this.playerColor) {
      return null;
    }
    this.played++;
    return next;
  }

  tryPlayerMove(move: MoveInput): PlayerMoveResult | null {
    const expected = this.expected;
    if (!expected || !this.isPlayerTurn) {
      return null;
    }
    if (matches(expected, move)) {
      const missed = this.currentMoveMissed;
      this.played++;
      this.correct++;
      this.hintLevel = 0;
      this.currentMoveMissed = false;
      return { verdict: 'correct', expected, missed };
    }
    if (this.currentNode.children.some((sibling) => matches(sibling, move))) {
      return { verdict: 'alternative', expected, missed: false };
    }
    this.mistakes++;
    this.currentMoveMissed = true;
    return { verdict: 'wrong', expected, missed: true };
  }

  /** First call points at the piece to move (a hint), the second shows the move itself (a mistake). */
  hint(): HintStep | null {
    const expected = this.expected;
    if (!expected || !this.isPlayerTurn) {
      return null;
    }
    this.currentMoveMissed = true;
    if (this.hintLevel === 0) {
      this.hintLevel = 1;
      this.hints++;
      return { level: 1, square: expected.from };
    }
    if (this.hintLevel === 1) {
      this.mistakes++;
    }
    this.hintLevel = 2;
    return { level: 2, move: expected };
  }

  /** Revealing the rest of the line counts as one mistake, however often it is opened. */
  peek(): void {
    if (!this.peekedAtLine) {
      this.peekedAtLine = true;
      this.mistakes++;
    }
  }
}

function matches(node: MoveNode, move: MoveInput): boolean {
  return node.from === move.from && node.to === move.to;
}
