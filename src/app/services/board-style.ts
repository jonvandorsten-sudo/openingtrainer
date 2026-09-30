import { BOARD_THEMES, BoardThemeName, PieceSetName, boardImage, highlightOverlay } from '../core/board-theme';

const PIECES = { king: 'K', queen: 'Q', rook: 'R', bishop: 'B', knight: 'N', pawn: 'P' };
const STYLE_ID = 'piece-set';

/** Applies the board colours (as CSS variables) and the piece set (as a style sheet) to every board. */
export function applyBoardStyle(themeName: BoardThemeName, pieceSet: PieceSetName): void {
  const theme = BOARD_THEMES[themeName];
  const root = document.documentElement.style;
  root.setProperty('--board-image', boardImage(theme.light, theme.dark));
  root.setProperty('--sq-light', theme.light);
  root.setProperty('--sq-dark', theme.dark);
  root.setProperty('--last-move', highlightOverlay(theme.light, theme.dark, theme.lastMoveLight, theme.lastMoveDark));
  root.setProperty('--selected', highlightOverlay(theme.light, theme.dark, theme.selection, theme.selection));

  let sheet = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!sheet) {
    sheet = document.createElement('style');
    sheet.id = STYLE_ID;
    document.head.appendChild(sheet);
  }
  sheet.textContent = Object.entries(PIECES)
    .flatMap(([role, letter]) =>
      (['white', 'black'] as const).map((color) => `.cg-wrap piece.${role}.${color} { background-image: url('pieces/${pieceSet}/${color[0]}${letter}.svg'); }`),
    )
    .join('\n');
}
