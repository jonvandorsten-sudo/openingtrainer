# Repertoire Horse

*The name is set in one place, `src/app/app-name.ts`.*

A free opening-repertoire trainer, working from any PGN file. Fully client-side: there is no backend, all data lives in the visitor's browser.

- Live: https://enpassant-texel.nl/openingtrainer/ and https://jonvandorsten-sudo.github.io/openingtrainer/
- Source: https://github.com/jonvandorsten-sudo/openingtrainer

## Usage

```bash
npm install
npm start        # http://localhost:4200
npm test         # unit tests (vitest)
npm run build    # static site in dist/chess-opening-trainer/browser
```

`npm run deploy:pages` builds the app and publishes it to the `gh-pages` branch, which GitHub Pages serves.

The build output is a static site; host it anywhere that serves files (GitHub Pages, Netlify, Cloudflare Pages, any web server).

## Views

The repertoire picker at the top selects what every view works over: all repertoires, all repertoires of one colour, or a single one. It is grouped by colour, searches repertoire and line names, and shows lines, lines to review and mastery per repertoire. Sessions over several repertoires turn the board per line to the colour you play in it.

Train, free start and Explore share one position: switching between them keeps the board where it was.

- **Train**: the opponent's moves are played automatically. Modes: *Free start* (default with several repertoires): play moves for both colours and see which repertoires still have lines from the position and how they continue; *Train* starts a session over that repertoire's lines from there. *Review* (spaced repetition: lines that are due), *Weak spots* (moves you often miss, drilled from the position before them), *All*, and *Random*: an endless session where the opponent chooses at every branch as often as the move is really played (the stored frequencies of a prepared player, otherwise equal odds), like a game against them. Opening moves you found the set number of times in a row are played for you, so a line starts at your first move that is not known yet (switchable). *Settings* also choose the board colours (stone, walnut, slate, green) and the piece set, the training depth (lines trained up to move N; lines that become equal merge) and the review schedule: days until the first review and how much longer every next interval gets after a flawless run (default 1, 3, 8, 20, 50 days); a mistake starts it again. Hint in two steps (piece, then move), *Peek* shows the rest of the line; both count as a mistake. Keys: `H` hint, `R` restart, `to` skip / next.
- **Map**: grouped per repertoire, one row per line, one cell per move of yours, coloured by how often you miss it. Click a cell to drill from that position.
- **Repertoire**: manage repertoires, browse and search the move tree, edit comments, import and export PGN. *Edit* opens Explore in edit mode at the current position.
- **Statistics**: mastered lines, accuracy, streaks, training time, weak spots, mastery per repertoire, activity.
- **Explore**: build and prepare. Play freely on the board and see per position: the opening name, the best three Stockfish lines, and moves with statistics from the Lichess opening explorer (Lichess and masters games), or from the games of a player loaded from Lichess or Chess.com (filter by colour and time control, with links to the games). *Your repertoires here* lists every repertoire in scope that has the position, with its moves, *Train from here*, *In repertoire* and *Edit*. Opponent moves that none of your repertoires of that colour answers yet are listed as *not covered* and can be added with one click. In **edit mode** you play moves for both colours; new moves stay marked until *Save to repertoire*, book moves can be added with +, continuations can be made the main line or deleted, comments edited, and every change can be undone from the message that follows.

- **Preparation against a player**: *Create preparation* (Explore, with a player selected) builds a repertoire from that player's games: where they are to move it takes their real replies (minimum games/share, max replies per position); where you are to move it uses your own repertoire, otherwise Stockfish: optionally the good move the player scores worst against. Where the player has no games it continues with the most popular Lichess moves or the move Stockfish expects. Moves are annotated ("plays this in 36 of 40 games, score 61%") and stored as a normal repertoire with the move frequencies, so training shows the lines the player is most likely to play first, with their chance. Regenerating replaces the preparation and keeps the progress of lines that stay the same.

Player games are stored locally with a hash of every position (first 20 moves), computed once on import, so filtering and building the tree stay fast with thousands of games. Imports run in the background, can be stopped keeping what arrived, and can later be updated with only the newer games.

### Lichess and Chess.com

- *Log in with Lichess* uses OAuth 2 with PKCE as a public client (no backend, no password in the app); the token is kept in `localStorage` and not included in backups. It is needed for the opening explorer and for downloading Lichess games.
- Chess.com offers no self-service login or explorer API, but its public game archives (`api.chess.com/pub`) work from the browser without an account.

## Data

*Import PGN* accepts several files or a ZIP at once, and a single export with many repertoires (for example an export of all your repertoires, one game per repertoire). Grouping: as in the file, collected per main opening via the opening book (e.g. all Sicilian sub-repertoires of one colour become "Sicilian Defense"), or one repertoire per colour. Importing a repertoire with the same name and colour updates it and keeps progress and comments, so re-exporting and importing again keeps everything in sync.

The topbar chip and *File* in the rail show whether there are changes that are not in your file yet, save to a dated JSON file or open one (with a confirmation, as loading replaces everything), and in Chrome and Edge link a file on disk that every change is written to. An optional reminder appears after every 10 unsaved changes. *Settings to Recent changes* keeps the last 20 repertoire changes, including deleted repertoires, to restore them.

Everything is stored in IndexedDB on the device (falls back to memory in private windows). *Save to file* in the file panel downloads a JSON file with all repertoires, progress and statistics; *Open file* restores it, also on another device. Exported PGN includes your own comments.

The app is an installable PWA: fonts and icons are bundled and the service worker caches the app and the opening book, so it works offline after the first visit (production build only).

The evaluation bar uses Stockfish 19 (lite, single-threaded WASM from [stockfish.js](https://github.com/nmrugg/stockfish.js), GPL-3.0) in a Web Worker, searching the shown position up to the depth set in *Settings*. Alternatively it shows the `[%eval]` values stored in the PGN (both pawns and `cp,depth` centipawns are read). The engine files are copied from `node_modules/stockfish` into `stockfish/` at build time; the host must serve `.wasm` as `application/wasm`.

Opening names come from the [Lichess chess-openings](https://github.com/lichess-org/chess-openings) dataset (CC0) in `data/lichess-openings`; `node scripts/build-openings.mjs` turns it into `public/openings.json`. App icons are rendered by `scripts/build-icons.mjs`.

## Structure

- `src/app/core`: framework-free logic, unit tested (`training.spec.ts`)
  - `repertoire.ts`: PGN to move tree (nested variations, comments, `%eval`)
  - `lines.ts`: tree to training lines with group and name
  - `line-attempt.ts`: walks one line: judging moves, hints, peeking
  - `progress.ts`: spaced repetition and mastery per line and per move
  - `queue.ts`: session order per mode, weak spots
  - `stats.ts`: streaks, accuracy, activity
  - `pgn-writer.ts`: tree to PGN
- `src/app/services`: `AppStore` (state + persistence), `LocalDatabase` (IndexedDB), `TrainingController` (one board session), translations (English, Dutch, German, French, Spanish, Italian, Brazilian Portuguese; missing keys fall back to English)
- `src/app/components`: shell, the four views, dialogs, `chess-board` (chessground wrapper)
- `scripts/screenshots.mjs`: captures all screens with headless Chrome into `screenshots/`

## Licence

The piece sets in `public/pieces` come from Lichess and keep their own licences, listed in [public/pieces/CREDITS.md](public/pieces/CREDITS.md). Staunty (the default), maestro and alpha are for non-commercial use only; cburnett and merida are GPLv2+.


GPL-3.0-or-later, see [LICENSE](LICENSE). The app bundles Stockfish (GPL-3.0) and chessground (GPL-3.0), so it is distributed under the same licence; other dependencies are chess.js (BSD-2-Clause), @mliebelt/pgn-parser (Apache-2.0), Angular (MIT), IBM Plex Sans and IBM Plex Mono (OFL-1.1) and Material Icons (Apache-2.0). Opening names come from the Lichess chess-openings dataset (CC0). The privacy statement is in [public/privacy.html](public/privacy.html).

Test fixtures contain move trees only; do not commit third-party course material (PGN comments, screenshots of annotated positions). `screenshots/` and PGN files in the project root are ignored for that reason; `scripts/screenshots.mjs` takes the PGN to show as an argument.
