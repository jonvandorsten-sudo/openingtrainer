import { DEFAULT_POSITION } from 'chess.js';
import { MoveNode, Repertoire, moveNumber } from './repertoire';

export interface PgnExportOptions {
  headers: Record<string, string>;
  comments?: Record<string, string>;
}

export function writePgn(repertoire: Repertoire, options: PgnExportOptions): string {
  return repertoire.roots.map((root) => writeGame(root, options)).join('\n\n');
}

function writeGame(root: MoveNode, options: PgnExportOptions): string {
  const headers: Record<string, string> = { Event: '?', Site: '?', Date: '????.??.??', Round: '?', White: '?', Black: '?', Result: '*', ...options.headers };
  if (root.fen !== DEFAULT_POSITION) {
    headers['SetUp'] = '1';
    headers['FEN'] = root.fen;
  }
  const tagSection = Object.entries(headers)
    .map(([name, value]) => `[${name} "${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`)
    .join('\n');
  const movetext = [...writeContinuation(root, true, options.comments ?? {}), '*'].join(' ');
  return `${tagSection}\n\n${wrap(movetext)}`;
}

function writeContinuation(start: MoveNode, forceNumber: boolean, comments: Record<string, string>): string[] {
  const tokens: string[] = [];
  let node = start;
  let needNumber = forceNumber;
  while (node.children.length > 0) {
    const [main, ...alternatives] = node.children;
    tokens.push(...writeMove(main, needNumber, comments));
    for (const alternative of alternatives) {
      tokens.push(`(${[...writeMove(alternative, true, comments), ...writeContinuation(alternative, false, comments)].join(' ')})`);
    }
    needNumber = alternatives.length > 0 || hasComment(main, comments);
    node = main;
  }
  return tokens;
}

function writeMove(node: MoveNode, forceNumber: boolean, comments: Record<string, string>): string[] {
  const number = moveNumber(node);
  const tokens = [node.color === 'w' ? `${number}. ${node.san}` : forceNumber ? `${number}... ${node.san}` : node.san];
  const annotation = [node.eval !== undefined ? `[%eval ${node.eval.toFixed(2)}]` : '', commentOf(node, comments)].filter(Boolean).join(' ');
  if (annotation) {
    tokens.push(`{ ${annotation.replace(/}/g, ')')} }`);
  }
  return tokens;
}

function commentOf(node: MoveNode, comments: Record<string, string>): string {
  return (comments[node.key] ?? node.comment ?? '').trim();
}

function hasComment(node: MoveNode, comments: Record<string, string>): boolean {
  return commentOf(node, comments) !== '' || node.eval !== undefined;
}

function wrap(text: string, width = 80): string {
  const lines: string[] = [];
  let current = '';
  for (const word of text.split(' ')) {
    if (current && current.length + word.length + 1 > width) {
      lines.push(current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) {
    lines.push(current);
  }
  return lines.join('\n');
}
