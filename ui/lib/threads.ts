import type { TurnModel } from "./types";

/* One capture can hold several agent threads: the main conversation, other
   conversations opened in the same app, and sub-agents they spawn. The token
   flow reads each thread on its own, so a thread's ribbons stay continuous
   instead of bridging over other threads' requests.

   A thread with a captured parent is a branch of it, placed after the parent's
   last request before the branch began. Threads without one are top-level
   sections. Auxiliary requests (title generation, empty requests) sit apart. */

export interface ThreadNode {
  id: string;
  label?: string;
  /* The agent's task path, when it was spawned for one. */
  name?: string;
  /* This thread's own turn indices, in capture order. */
  indices: number[];
  /* Branches, each after a turn index of this thread (-1: before its first turn). */
  branches: Array<{ after: number; node: ThreadNode }>;
}

export interface ThreadTree {
  roots: ThreadNode[];
  auxiliary: number[];
  /* The thread ids from a root down to the thread of each turn. */
  pathOf: Map<number, string[]>;
}

export function isAuxiliary(turn: TurnModel): boolean {
  return turn.kind === "metadata" || (turn.input === 0 && turn.output === 0);
}

export function threadTree(turns: TurnModel[]): ThreadTree {
  const auxiliary: number[] = [];
  const nodes = new Map<string, ThreadNode & { parentId?: string }>();
  turns.forEach((turn, index) => {
    if (isAuxiliary(turn)) {
      auxiliary.push(index);
      return;
    }
    const id = turn.thread.id;
    const node = nodes.get(id) || { branches: [], id, indices: [], label: turn.thread.label, name: turn.thread.name, parentId: turn.thread.parentId };
    node.indices.push(index);
    node.label ||= turn.thread.label;
    node.name ||= turn.thread.name;
    node.parentId ||= turn.thread.parentId;
    nodes.set(id, node);
  });

  const roots: ThreadNode[] = [];
  for (const node of [...nodes.values()].sort((left, right) => left.indices[0] - right.indices[0])) {
    const parent = node.parentId && node.parentId !== node.id ? nodes.get(node.parentId) : undefined;
    if (!parent) {
      roots.push(node);
      continue;
    }
    const first = node.indices[0];
    const after = parent.indices.filter((index) => index < first).pop() ?? -1;
    parent.branches.push({ after, node });
  }

  const pathOf = new Map<number, string[]>();
  const walk = (node: ThreadNode, path: string[]) => {
    const here = [...path, node.id];
    for (const index of node.indices) pathOf.set(index, here);
    for (const branch of node.branches) walk(branch.node, here);
  };
  for (const root of roots) walk(root, []);
  return { auxiliary, pathOf, roots };
}

/* Every turn index in a thread and its branches. */
export function threadIndices(node: ThreadNode): number[] {
  return [...node.indices, ...node.branches.flatMap((branch) => threadIndices(branch.node))];
}
