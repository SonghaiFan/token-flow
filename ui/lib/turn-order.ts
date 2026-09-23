import type { TurnModel } from "./types";

export interface TurnGroup {
  id: string;
  label: string;
  indices: number[];
}

/* Group chronological turns by the user query they serve. The token flow shows a
   header wherever a new query starts. */
export function queryGroups(turns: TurnModel[]): TurnGroup[] {
  const groups: TurnGroup[] = [];
  const metadataIndices: number[] = [];
  turns.forEach((turn, index) => {
    if (turn.kind === "metadata") {
      metadataIndices.push(index);
      return;
    }

    const current = groups[groups.length - 1];
    const continuesCurrent = Boolean(
      current
      && turn.queryText
      && turn.queryText === turns[current.indices[0]].queryText
      && turn.queryMessageCount > 1
      && turn.queryUserIndex === turns[current.indices[0]].queryUserIndex,
    );

    if (!current || (turn.queryText && !continuesCurrent)) {
      groups.push({
        id: `query:${turn.id}`,
        label: turn.queryText || turn.title,
        indices: [index],
      });
      return;
    }
    current.indices.push(index);
  });

  // Token Flow treats title generation as metadata and attaches it to the
  // nearest real session group rather than presenting it as another query.
  metadataIndices.forEach((index) => {
    if (!groups.length) {
      groups.push({ id: `query:${turns[index].id}`, label: turns[index].title, indices: [index] });
      return;
    }
    let nearest = groups[0];
    let nearestDistance = Number.POSITIVE_INFINITY;
    groups.forEach((group) => {
      const distance = Math.min(...group.indices.map((candidate) => Math.abs(candidate - index)));
      if (distance < nearestDistance) {
        nearest = group;
        nearestDistance = distance;
      }
    });
    nearest.indices.push(index);
    nearest.indices.sort((left, right) => left - right);
  });

  return groups.map((group, index) => ({
    ...group,
    label: `Query ${index + 1}${group.label ? ` · ${group.label}` : ""}`,
  }));
}
