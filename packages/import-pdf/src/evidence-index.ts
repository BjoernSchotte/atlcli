/**
 * Private: evidence lookup by the ids a block answers to. Callers used to
 * filter the whole evidence list once per block (blocks x evidence).
 */
interface RefEvidence {
  sourceId: string;
  targetNodeId?: string;
}

export type EvidenceIndex<T> = ReadonlyMap<string, readonly T[]>;

export function indexEvidenceByRef<T extends RefEvidence>(evidence: readonly T[]): EvidenceIndex<T> {
  const index = new Map<string, T[]>();
  const add = (id: string, item: T): void => {
    const list = index.get(id);
    if (list) list.push(item);
    else index.set(id, [item]);
  };
  for (const item of evidence) {
    add(item.sourceId, item);
    if (item.targetNodeId && item.targetNodeId !== item.sourceId) add(item.targetNodeId, item);
  }
  return index;
}

/** Every evidence entry whose source or target id is the block's id or one of its source refs. */
export function evidenceForBlock<T>(
  index: EvidenceIndex<T>,
  block: { id: string; sourceRefs?: string[] },
): T[] {
  const matches = new Set<T>();
  for (const id of new Set([block.id, ...(block.sourceRefs ?? [])])) {
    for (const item of index.get(id) ?? []) matches.add(item);
  }
  return [...matches];
}

/** Appends to a per-page evidence index that is kept alongside a growing evidence list. */
export function addEvidenceByPage<T extends { locator: { pageIndex: number } }>(
  index: Map<number, T[]>,
  item: T,
): void {
  const list = index.get(item.locator.pageIndex);
  if (list) list.push(item);
  else index.set(item.locator.pageIndex, [item]);
}
