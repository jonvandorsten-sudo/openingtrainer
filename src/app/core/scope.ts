import { Side } from './repertoire';

export type RepertoireScope = { kind: 'all' } | { kind: 'side'; side: Side } | { kind: 'one'; id: string };

export function inScope(record: { id: string; side: Side }, scope: RepertoireScope): boolean {
  switch (scope.kind) {
    case 'all':
      return true;
    case 'side':
      return record.side === scope.side;
    case 'one':
      return record.id === scope.id;
  }
}

/** Older settings kept one active repertoire; that becomes a scope of one. */
export function scopeFromSettings(scope: RepertoireScope | undefined, legacyId: string | null): RepertoireScope {
  if (scope) {
    return scope;
  }
  return legacyId ? { kind: 'one', id: legacyId } : { kind: 'all' };
}

export function sameScope(a: RepertoireScope, b: RepertoireScope): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
