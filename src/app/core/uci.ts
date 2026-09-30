export interface EngineInfo {
  depth: number;
  /** Pawns from White's point of view; ±99 for a forced mate. */
  value: number;
  mate?: number;
}

export interface EngineLine extends EngineInfo {
  multipv: number;
  /** Principal variation in UCI notation (e2e4, e7e8q). */
  pv: string[];
}

/** Reads a UCI "info" line; scores are reported for the side to move and converted to White's point of view. */
export function parseEngineLine(line: string, sideToMove: 'w' | 'b'): EngineLine | null {
  if (!line.startsWith('info ') || line.includes(' currmove ')) {
    return null;
  }
  const depth = /\bdepth (\d+)/.exec(line);
  const score = /\bscore (cp|mate) (-?\d+)/.exec(line);
  if (!depth || !score) {
    return null;
  }
  const multipv = Number(/\bmultipv (\d+)/.exec(line)?.[1] ?? 1);
  const pv = /\bpv (.+)$/.exec(line)?.[1].trim().split(/\s+/) ?? [];
  const sign = sideToMove === 'w' ? 1 : -1;
  const raw = Number(score[2]);
  if (score[1] === 'mate') {
    const mate = raw * sign;
    return { multipv, depth: Number(depth[1]), value: mate > 0 ? 99 : -99, mate, pv };
  }
  return { multipv, depth: Number(depth[1]), value: (raw * sign) / 100, pv };
}

/** The main line only, as used for the evaluation bar. */
export function parseInfoLine(line: string, sideToMove: 'w' | 'b'): EngineInfo | null {
  const parsed = parseEngineLine(line, sideToMove);
  if (!parsed || parsed.multipv !== 1) {
    return null;
  }
  const { depth, value, mate } = parsed;
  return mate === undefined ? { depth, value } : { depth, value, mate };
}

export function sideToMove(fen: string): 'w' | 'b' {
  return fen.split(' ')[1] === 'b' ? 'b' : 'w';
}
