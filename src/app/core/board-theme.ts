export type BoardThemeName = 'steen' | 'walnoot' | 'leisteen' | 'groen';
export type PieceSetName = 'staunty' | 'maestro' | 'merida' | 'alpha' | 'cburnett';

export interface BoardTheme {
  light: string;
  dark: string;
  lastMoveLight: string;
  lastMoveDark: string;
  selection: string;
}

export const BOARD_THEMES: Record<BoardThemeName, BoardTheme> = {
  steen: { light: '#e6e2d6', dark: '#9a9f8e', lastMoveLight: '#dcd59f', lastMoveDark: '#aaa874', selection: '#c7d6a4' },
  walnoot: { light: '#ecdcc2', dark: '#b0845c', lastMoveLight: '#e8d488', lastMoveDark: '#c6a257', selection: '#e0c98f' },
  leisteen: { light: '#e1e6ea', dark: '#8595a2', lastMoveLight: '#cfdcc0', lastMoveDark: '#8fa58c', selection: '#b7cde0' },
  groen: { light: '#ecefe9', dark: '#a7b6a9', lastMoveLight: '#d5e6bf', lastMoveDark: '#9fbd83', selection: '#b9dcc4' },
};

export const PIECE_SETS: PieceSetName[] = ['staunty', 'maestro', 'merida', 'alpha', 'cburnett'];

type Rgb = [number, number, number];

/**
 * One translucent colour that turns the light square into `onLight` and the dark square into about `onDark`,
 * because the board cannot tell a highlighted square which colour it is.
 */
export function highlightOverlay(light: string, dark: string, onLight: string, onDark: string): string {
  const [l, d, hl, hd] = [light, dark, onLight, onDark].map(rgb);
  const keep = average([0, 1, 2].map((i) => (l[i] === d[i] ? 0.5 : (hl[i] - hd[i]) / (l[i] - d[i]))));
  const alpha = Math.min(0.95, Math.max(0.2, 1 - keep));
  const colour = [0, 1, 2].map((i) => clamp(Math.round((hl[i] - l[i] * (1 - alpha)) / alpha)));
  return `rgba(${colour.join(', ')}, ${alpha.toFixed(2)})`;
}

/** The checkerboard as an SVG data URL, a1 dark. */
export function boardImage(light: string, dark: string): string {
  const squares: string[] = [];
  for (let row = 0; row < 8; row++) {
    for (let col = row % 2 === 0 ? 1 : 0; col < 8; col += 2) {
      squares.push(`M${col} ${row}h1v1H${col}z`);
    }
  }
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 8 8' shape-rendering='crispEdges'><rect width='8' height='8' fill='${light}'/><path fill='${dark}' d='${squares.join('')}'/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

function rgb(hex: string): Rgb {
  const value = parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function average(values: number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function clamp(value: number): number {
  return Math.max(0, Math.min(255, value));
}
