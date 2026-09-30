import { Chess, DEFAULT_POSITION } from 'chess.js';

export interface PlayedMove {
  san: string;
  from: string;
  to: string;
  fen: string;
}

/** Replays SAN moves from the start position, stopping at the first illegal one. */
export function replaySans(sans: string[]): PlayedMove[] {
  const chess = new Chess();
  const played: PlayedMove[] = [];
  for (const san of sans) {
    try {
      const move = chess.move(san);
      played.push({ san: move.san, from: move.from, to: move.to, fen: chess.fen() });
    } catch {
      break;
    }
  }
  return played;
}

/** The SAN of a board move (queen promotion), or null when it is illegal in the position. */
export function sanOfBoardMove(fen: string, from: string, to: string): string | null {
  try {
    return new Chess(fen).move({ from, to, promotion: 'q' }).san;
  } catch {
    return null;
  }
}

export function isLegalSan(fen: string, san: string): boolean {
  try {
    new Chess(fen).move(san);
    return true;
  } catch {
    return false;
  }
}

export function fenAfter(played: PlayedMove[]): string {
  return played.at(-1)?.fen ?? DEFAULT_POSITION;
}

export function turnOf(fen: string): 'w' | 'b' {
  return fen.split(' ')[1] === 'b' ? 'b' : 'w';
}
