import { isAuxiliary, threadIndices, threadTree } from "./threads";
import { queryGroups } from "./turn-order";
import type { TurnModel } from "./types";

/* Which part of a capture a request belongs to: the conversation itself (its
   threads and the branches they spawn, such as sub-agents and web searches),
   background work the harness did on its own, or auxiliary requests (title
   generation, empty requests). Conversations are compared by their own scope. */
export type TurnScope = "conversation" | "background" | "auxiliary";

export function turnScopes(turns: TurnModel[]): TurnScope[] {
  const tree = threadTree(turns);
  const background = new Set(tree.background.flatMap(threadIndices));
  return turns.map((turn, index) => (isAuxiliary(turn) ? "auxiliary" : background.has(index) ? "background" : "conversation"));
}

export interface ScopeTotals {
  requests: number;
  input: number;
  cached: number;
  output: number;
  durationMs: number;
}

export function scopeTotals(turns: TurnModel[]): ScopeTotals {
  return turns.reduce((sum, turn) => ({
    requests: sum.requests + 1,
    input: sum.input + turn.input,
    cached: sum.cached + turn.cached,
    output: sum.output + turn.output,
    durationMs: sum.durationMs + turn.durationMs,
  }), { requests: 0, input: 0, cached: 0, output: 0, durationMs: 0 });
}

export interface QuerySummary extends ScopeTotals {
  text: string;
  /* Indices into the conversation's turns, in capture order. */
  indices: number[];
  compactions: number;
}

/* The conversation's requests grouped by the user query they serve. Queries are
   read from its top-level threads; a branch request joins the query of the
   latest top-level request before it. */
export function conversationQueries(turns: TurnModel[]): QuerySummary[] {
  const scopes = turnScopes(turns);
  const tree = threadTree(turns);
  const roots = new Set(tree.roots.flatMap((root) => root.indices));
  const main = turns.map((_, index) => index).filter((index) => scopes[index] === "conversation" && roots.has(index));
  const groups = queryGroups(main.map((index) => turns[index])).map((group) => ({ text: turns[main[group.indices[0]]].queryText || turns[main[group.indices[0]]].title, indices: group.indices.map((position) => main[position]) }));
  const groupOf = new Map<number, number>();
  groups.forEach((group, position) => group.indices.forEach((index) => groupOf.set(index, position)));
  turns.forEach((_, index) => {
    if (scopes[index] !== "conversation" || groupOf.has(index)) return;
    const before = main.filter((candidate) => candidate < index).pop();
    const position = before === undefined ? 0 : groupOf.get(before);
    if (position === undefined || !groups[position]) return;
    groups[position].indices.push(index);
    groupOf.set(index, position);
  });
  return groups.map((group) => {
    const indices = [...group.indices].sort((left, right) => left - right);
    const members = indices.map((index) => turns[index]);
    return { ...scopeTotals(members), compactions: members.filter((turn) => turn.kind === "compaction").length, indices, text: group.text };
  });
}
