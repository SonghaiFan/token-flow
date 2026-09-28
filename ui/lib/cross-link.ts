import type { TokenSelection, TurnBlock, TurnModel } from "./types";

export function selectedBlocks(turn: TurnModel, selection: TokenSelection | null): TurnBlock[] {
  if (selection?.turnId !== turn.id) return [];
  const ids = new Set(selection.blockIds || [selection.blockId]);
  return turn.blocks.filter((block) => selection.layer ? block.inputClass.layer === selection.layer : ids.has(block.id));
}

// A mixed aggregate does not tell us which member was cached. Never distribute
// its cache count over text characters or assume unchanged means a cache hit.
export function fullyCachedBlockIds(turn: TurnModel): Set<string> {
  const cached = new Set<string>();
  for (const block of turn.blocks) {
    const counts = turn.categories.filter((category) => (category.memberIds || [category.id]).includes(block.id));
    if (counts.length && counts.every((count) => count.tokens > 0 && count.cached >= count.tokens)) cached.add(block.id);
  }
  return cached;
}
