import { AfterViewInit, Component, ElementRef, OnDestroy, effect, input, output, viewChild } from '@angular/core';
import { Chess } from 'chess.js';
import { Chessground } from 'chessground';
import { Api } from 'chessground/api';
import { DrawShape } from 'chessground/draw';
import { Key } from 'chessground/types';

export interface BoardPosition {
  fen: string;
  lastMove?: [string, string];
  movable: boolean;
  shapes?: DrawShape[];
  hintSquare?: string;
}

export interface BoardMove {
  from: string;
  to: string;
}

@Component({
  selector: 'app-chess-board',
  standalone: true,
  template: `<div #board class="board"></div>`,
  styles: [
    `
      :host {
        display: block;
        width: 100%;
      }
      .board {
        width: 100%;
        aspect-ratio: 1;
      }
    `,
  ],
})
export class ChessBoardComponent implements AfterViewInit, OnDestroy {
  readonly position = input.required<BoardPosition>();
  readonly orientation = input<'white' | 'black'>('white');
  readonly moved = output<BoardMove>();

  private readonly boardElement = viewChild.required<ElementRef<HTMLElement>>('board');
  private ground?: Api;
  private resizeObserver?: ResizeObserver;

  constructor() {
    effect(() => this.render(this.position(), this.orientation()));
  }

  ngAfterViewInit(): void {
    const element = this.boardElement().nativeElement;
    this.ground = Chessground(element, {
      animation: { enabled: true, duration: 200 },
      highlight: { lastMove: true, check: true },
      movable: { free: false, showDests: true, events: { after: (from, to) => this.moved.emit({ from, to }) } },
      premovable: { enabled: false },
      draggable: { showGhost: true },
      drawable: {
        enabled: true,
        brushes: {
          green: { key: 'g', color: '#2f7d4e', opacity: 0.85, lineWidth: 10 },
          red: { key: 'r', color: '#d32f2f', opacity: 0.85, lineWidth: 10 },
          blue: { key: 'b', color: '#003088', opacity: 0.6, lineWidth: 10 },
          yellow: { key: 'y', color: '#e68f00', opacity: 0.8, lineWidth: 10 },
        },
      },
    });
    this.render(this.position(), this.orientation());
    this.resizeObserver = new ResizeObserver(() => requestAnimationFrame(() => this.ground?.redrawAll()));
    this.resizeObserver.observe(element);
  }

  ngOnDestroy(): void {
    this.resizeObserver?.disconnect();
    this.ground?.destroy();
  }

  private render(position: BoardPosition, orientation: 'white' | 'black'): void {
    if (!this.ground) {
      return;
    }
    const chess = new Chess(position.fen);
    const turnColor = chess.turn() === 'w' ? 'white' : 'black';
    this.ground.set({
      fen: position.fen,
      orientation,
      turnColor,
      check: chess.inCheck(),
      lastMove: position.lastMove as Key[] | undefined,
      highlight: { custom: new Map(position.hintSquare ? [[position.hintSquare as Key, 'hint-square']] : []) },
      movable: {
        color: position.movable ? turnColor : undefined,
        dests: position.movable ? legalDestinations(chess) : new Map(),
      },
    });
    this.ground.setAutoShapes(position.shapes ?? []);
  }
}

function legalDestinations(chess: Chess): Map<Key, Key[]> {
  const dests = new Map<Key, Key[]>();
  for (const move of chess.moves({ verbose: true })) {
    const from = move.from as Key;
    dests.set(from, [...(dests.get(from) ?? []), move.to as Key]);
  }
  return dests;
}
