import { MoveNode } from './repertoire';

/** Position key (placement, side to move, castling) → [ECO code, opening name (empty on the way to named openings), number of named openings at or below]. */
export type OpeningBook = Record<string, [string, string, number?]>;

export interface Opening {
  eco: string;
  name: string;
}

export function positionKey(fen: string): string {
  return fen.split(' ').slice(0, 3).join(' ');
}

/** The most specific named opening on the way to `node`. */
export function openingAt(node: MoveNode | null, book: OpeningBook | null): Opening | null {
  if (!book) {
    return null;
  }
  for (let n = node; n; n = n.parent) {
    const entry = book[positionKey(n.fen)];
    if (entry?.[1]) {
      return { eco: entry[0], name: entry[1] };
    }
  }
  return null;
}

/** "Sicilian Defense: Closed, Fianchetto Variation" belongs to the family "Sicilian Defense: Closed". */
export function openingFamily(name: string): string {
  return name.split(',')[0].trim();
}
