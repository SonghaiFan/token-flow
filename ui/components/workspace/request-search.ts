import { categoryColor } from "@/lib/category-palette";
import { CATEGORY_META } from "@/lib/input-categories";
import type { InputCategory, TraceRecord, TurnBlock } from "@/lib/types";

export type JsonPathPart = number | string;

export interface SearchHit {
  after: string;
  before: string;
  /* The structured-view block that holds the match, when one exists. */
  blockId?: string;
  category?: InputCategory;
  color: string;
  key: string;
  label: string;
  location: string;
  match: string;
  path: JsonPathPart[];
  pathText: string;
}

export const MIN_QUERY = 2;
const MAX_HITS = 200;
const PER_VALUE = 3;
const CONTEXT = 48;
const MAX_RANGES = 2000;
const ALL_MATCHES = "token-flow-search";
const CURRENT_MATCH = "token-flow-search-current";

export function jsonPath(parts: JsonPathPart[]): string {
  return parts.reduce<string>((path, part) => {
    if (typeof part === "number") return `${path}[${part}]`;
    if (/^[A-Za-z_$][\w$]*$/.test(part)) return path ? `${path}.${part}` : part;
    return `${path}[${JSON.stringify(part)}]`;
  }, "");
}

/* Name the part of the request a JSON path points into, in the structured view's
   vocabulary, and the block that opens it there. Paths start at the record root. */
function locate(parts: JsonPathPart[], blocks: TurnBlock[], at: number, length: number, isKey: boolean): { blockId?: string; category?: InputCategory; color: string; label: string; location: string } {
  const block = !isKey ? blocks.filter((candidate) => candidate.rawPath?.every((part, index) => parts[index] === part)
    && (!candidate.rawRange || (parts.length === candidate.rawPath.length && at >= candidate.rawRange.start && at + length <= candidate.rawRange.end)))
    .sort((left, right) => (right.rawPath?.length || 0) - (left.rawPath?.length || 0) || Number(Boolean(right.rawRange)) - Number(Boolean(left.rawRange)))[0] : undefined;
  if (block) {
    const { category, label } = block.inputClass;
    return { blockId: block.id, category, color: categoryColor(category), label, location: `${CATEGORY_META[category].title} › ${label}` };
  }
  const [scope, section, field] = parts.slice(1);
  if (scope === "request" && section === "body") {
    return { color: "", label: "Captured request", location: `Captured request › ${String(field ?? "body")}` };
  }
  if (scope === "request") return { color: "", label: "Request", location: `Request ${String(section ?? "")}`.trim() };
  if (scope === "response") return { color: "", label: "Response", location: section === "body" && field !== undefined ? `Response › ${String(field)}` : "Response" };
  return { color: "", label: "Captured record", location: "Captured record" };
}

function snippet(text: string, at: number, length: number): Pick<SearchHit, "after" | "before" | "match"> {
  const start = Math.max(0, at - CONTEXT);
  const end = Math.min(text.length, at + length + CONTEXT);
  const clean = (value: string) => value.replace(/\s+/g, " ");
  return {
    after: `${clean(text.slice(at + length, end))}${end < text.length ? "…" : ""}`,
    before: `${start > 0 ? "…" : ""}${clean(text.slice(start, at))}`,
    match: clean(text.slice(at, at + length)),
  };
}

/* Case-insensitive search over the captured record's keys and scalar values, in
   document order, so results read top to bottom like the request itself. */
export function searchRecord(record: TraceRecord, query: string, blocks: TurnBlock[] = []): SearchHit[] {
  const needle = query.trim().toLowerCase();
  if (needle.length < MIN_QUERY) return [];
  const hits: SearchHit[] = [];
  const push = (path: JsonPathPart[], text: string, at: number, isKey = false) => {
    const place = locate(path, blocks, at, needle.length, isKey);
    hits.push({ ...place, ...snippet(text, at, needle.length), key: `${jsonPath(path)}@${at}:${hits.length}`, path, pathText: jsonPath(path) });
  };
  const visit = (value: unknown, path: JsonPathPart[]) => {
    if (hits.length >= MAX_HITS || value === null || value === undefined) return;
    if (typeof value === "object") {
      if (Array.isArray(value)) value.forEach((item, index) => visit(item, [...path, index]));
      else for (const [key, item] of Object.entries(value)) {
        if (key.toLowerCase().includes(needle)) push([...path, key], key, key.toLowerCase().indexOf(needle), true);
        visit(item, [...path, key]);
      }
      return;
    }
    const text = String(value);
    const lower = text.toLowerCase();
    let at = lower.indexOf(needle);
    for (let count = 0; at >= 0 && count < PER_VALUE && hits.length < MAX_HITS; count += 1) {
      push(path, text, at);
      at = lower.indexOf(needle, at + needle.length);
    }
  };
  visit(record, ["trace"]);
  return hits;
}

export const SEARCH_HIT_LIMIT = MAX_HITS;

function registry(): HighlightRegistry | null {
  return typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight !== "undefined" ? CSS.highlights : null;
}

/* Mark every visible occurrence inside the inspector without touching its markup.
   Anything under [data-search-ignore], such as the results list, is skipped. */
export function highlightMatches(root: HTMLElement | null, query: string): Range[] {
  const highlights = registry();
  if (!highlights) return [];
  highlights.delete(ALL_MATCHES);
  const needle = query.trim().toLowerCase();
  if (!root || needle.length < MIN_QUERY) {
    highlights.delete(CURRENT_MATCH);
    return [];
  }
  const ranges: Range[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => node.parentElement?.closest("[data-search-ignore]") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });
  for (let node = walker.nextNode(); node && ranges.length < MAX_RANGES; node = walker.nextNode()) {
    const text = (node.nodeValue || "").toLowerCase();
    for (let at = text.indexOf(needle); at >= 0 && ranges.length < MAX_RANGES; at = text.indexOf(needle, at + needle.length)) {
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + needle.length);
      ranges.push(range);
    }
  }
  highlights.set(ALL_MATCHES, new Highlight(...ranges));
  return ranges;
}

/* Emphasize the first occurrence inside a container and bring it into view, opening
   any closed native disclosure around it. Falls back to the container itself. */
export function focusMatch(container: Element, ranges: Range[]): void {
  const range = ranges.find((candidate) => container.contains(candidate.startContainer));
  const highlights = registry();
  if (!range) {
    highlights?.delete(CURRENT_MATCH);
    container.scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }
  highlights?.set(CURRENT_MATCH, new Highlight(range));
  for (let element = range.startContainer.parentElement; element; element = element.parentElement) {
    if (element instanceof HTMLDetailsElement && !element.open) element.open = true;
    if (element === container) break;
  }
  range.startContainer.parentElement?.scrollIntoView({ behavior: "smooth", block: "center" });
}

export function clearCurrentMatch(): void {
  registry()?.delete(CURRENT_MATCH);
}

export function clearHighlights(): void {
  const highlights = registry();
  highlights?.delete(ALL_MATCHES);
  highlights?.delete(CURRENT_MATCH);
}
