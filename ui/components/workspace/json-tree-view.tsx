"use client";

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import JsonView, { type JsonViewProps } from "@uiw/react-json-view";

type JsonDepth = 1 | 2 | 3 | "all";
type JsonPathPart = number | string;

interface SearchMatch {
  path: string;
  preview: string;
}

const MAX_SEARCH_RESULTS = 40;
const MAX_PREVIEW_LENGTH = 160;

const jsonTreeStyle: CSSProperties & Record<`--w-rjv-${string}`, string | number> = {
  "--w-rjv-background-color": "transparent",
  "--w-rjv-border-left-color": "var(--line)",
  "--w-rjv-color": "var(--ink)",
  "--w-rjv-font-family": "var(--font-token-flow-mono)",
  "--w-rjv-info-color": "var(--muted)",
  "--w-rjv-key-number": "#2563eb",
  "--w-rjv-key-string": "#2563eb",
  "--w-rjv-line-color": "var(--line)",
  "--w-rjv-type-bigint-color": "#9333ea",
  "--w-rjv-type-boolean-color": "#c2410c",
  "--w-rjv-type-float-color": "#9333ea",
  "--w-rjv-type-int-color": "#9333ea",
  "--w-rjv-type-null-color": "var(--muted)",
  "--w-rjv-type-string-color": "#087f5b",
  minWidth: "100%",
  width: "max-content",
};

function jsonPath(parts: JsonPathPart[]): string {
  return parts.reduce<string>((path, part) => {
    if (typeof part === "number") return `${path}[${part}]`;
    if (/^[A-Za-z_$][\w$]*$/.test(part)) return path ? `${path}.${part}` : part;
    return `${path}[${JSON.stringify(part)}]`;
  }, "");
}

function valuePreview(value: unknown): string {
  if (Array.isArray(value)) return `Array · ${value.length} items`;
  if (value && typeof value === "object") return `Object · ${Object.keys(value).length} fields`;
  if (value === null) return "null";
  const text = String(value).replace(/\s+/g, " ").trim();
  return text.length > MAX_PREVIEW_LENGTH ? `${text.slice(0, MAX_PREVIEW_LENGTH)}…` : text;
}

function findMatches(value: object, query: string): SearchMatch[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [];

  const matches: SearchMatch[] = [];
  const pending: Array<{ parts: JsonPathPart[]; value: unknown }> = [{ parts: ["trace"], value }];

  while (pending.length && matches.length < MAX_SEARCH_RESULTS) {
    const current = pending.pop();
    if (!current) break;
    const currentPath = jsonPath(current.parts);
    const key = current.parts.at(-1);
    const primitive = current.value === null || typeof current.value !== "object";
    const haystack = `${String(key ?? "")} ${primitive ? String(current.value) : ""}`.toLocaleLowerCase();
    if (haystack.includes(needle)) matches.push({ path: currentPath, preview: valuePreview(current.value) });

    if (Array.isArray(current.value)) {
      for (let index = current.value.length - 1; index >= 0; index -= 1) {
        pending.push({ parts: [...current.parts, index], value: current.value[index] });
      }
    } else if (current.value && typeof current.value === "object") {
      const entries = Object.entries(current.value as Record<string, unknown>);
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const [childKey, childValue] = entries[index];
        pending.push({ parts: [...current.parts, childKey], value: childValue });
      }
    }
  }
  return matches;
}

function findPathElement(root: HTMLElement, path: string): HTMLElement | undefined {
  return [...root.querySelectorAll<HTMLElement>("[data-json-path]")].find((element) => element.dataset.jsonPath === path);
}

export function JsonTreeView({ selectedBlockId, selectedPath, value }: { selectedBlockId?: string; selectedPath?: JsonPathPart[] | null; value: object }) {
  const [depth, setDepth] = useState<JsonDepth>("all");
  const [query, setQuery] = useState("");
  const [copiedPath, setCopiedPath] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const selectedPathString = useMemo(() => selectedPath?.length ? jsonPath(selectedPath) : "", [selectedPath]);
  const matches = useMemo(() => findMatches(value, query), [query, value]);
  // react-json-view 1.12.x uses a boolean collapsed value as its initial expand state.
  const initialExpansion = depth === "all" ? true : depth;
  const components = useMemo<NonNullable<JsonViewProps<object>["components"]>>(() => ({
    objectKey: ({ children, className, namespace, style }) => {
      const path = jsonPath(["trace", ...(namespace || [])]);
      const selected = Boolean(selectedPathString && path === selectedPathString);
      return <span aria-current={selected ? "true" : undefined} className={`${className || ""} ${selected ? "token-flow-json-key-selected" : ""}`} data-block-id={selected ? selectedBlockId : undefined} data-json-path={path} data-json-selected={selected ? "true" : undefined} style={style} tabIndex={selected ? -1 : undefined}>{children}</span>;
    },
  }), [selectedBlockId, selectedPathString]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || !selectedPath?.length || !selectedPathString) return;
    let cancelled = false;
    let retries = 0;
    let prefixLength = 2;

    const revealNext = () => {
      if (cancelled) return;
      const prefix = jsonPath(selectedPath.slice(0, prefixLength));
      const key = findPathElement(root, prefix);
      if (!key) {
        retries += 1;
        if (retries < 16) window.requestAnimationFrame(revealNext);
        return;
      }

      retries = 0;
      const node = key.closest<HTMLElement>(".w-rjv-inner");
      const header = node?.firstElementChild as HTMLElement | null;
      const expanded = Boolean(node?.querySelector(":scope > .w-rjv-content"));
      if (!expanded) header?.click();

      if (prefixLength < selectedPath.length) {
        prefixLength += 1;
        window.requestAnimationFrame(revealNext);
        return;
      }

      const row = key.closest<HTMLElement>(".w-rjv-line") || header || key;
      row.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
      key.focus({ preventScroll: true });
    };

    const frame = window.requestAnimationFrame(revealNext);
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frame);
    };
  }, [depth, selectedPath, selectedPathString]);

  const copyPath = async (path: string) => {
    try {
      await navigator.clipboard.writeText(path);
      setCopiedPath(path);
      window.setTimeout(() => setCopiedPath((current) => current === path ? "" : current), 1400);
    } catch {
      setCopiedPath("");
    }
  };

  return <div className="border-t border-line" ref={rootRef}>
    <div className="space-y-3 border-b border-line bg-panel p-3 sm:p-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <label className="relative min-w-0 flex-1">
          <span className="sr-only">Search JSON keys and values</span>
          <span aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted">⌕</span>
          <input className="min-h-11 w-full rounded-lg border border-line bg-canvas py-2 pl-9 pr-9 text-xs text-ink placeholder:text-muted" onChange={(event) => setQuery(event.target.value)} placeholder="Search keys or values" role="searchbox" type="text" value={query}/>
          {query ? <button aria-label="Clear JSON search" className="absolute right-1 top-1/2 min-h-9 min-w-9 -translate-y-1/2 rounded-md text-muted hover:bg-panel hover:text-ink" onClick={() => setQuery("")} type="button">×</button> : null}
        </label>
        <div aria-label="Initial JSON depth" className="grid grid-cols-4 rounded-lg bg-canvas p-1 text-[10px] font-semibold">
          {([1, 2, 3, "all"] as const).map((item) => <button aria-pressed={depth === item} className={`min-h-9 rounded-md px-3 ${depth === item ? "bg-panel text-ink shadow-sm" : "text-muted hover:text-ink"}`} key={item} onClick={() => setDepth(item)} type="button">{item === "all" ? "All" : `L${item}`}</button>)}
        </div>
      </div>
      {query ? <div>
        <div className="mb-2 flex items-center justify-between gap-2 text-[10px] text-muted"><span>{matches.length === MAX_SEARCH_RESULTS ? `${MAX_SEARCH_RESULTS}+` : matches.length} matches</span><span>Select a result to copy its path</span></div>
        {matches.length ? <div className="scrollbar-none flex max-h-40 flex-col gap-1 overflow-y-auto">{matches.map((match) => <button className="grid min-h-10 gap-0.5 rounded-lg border border-line bg-canvas px-3 py-2 text-left hover:border-muted sm:grid-cols-[minmax(12rem,0.8fr)_minmax(0,1fr)] sm:items-center sm:gap-3" key={match.path} onClick={() => void copyPath(match.path)} title={`Copy ${match.path}`} type="button"><code className="truncate font-mono text-[10px] font-medium text-ink">{match.path}</code><span className="truncate text-[10px] text-muted">{copiedPath === match.path ? "Path copied" : match.preview}</span></button>)}</div> : <p className="rounded-lg border border-dashed border-line p-3 text-center text-xs text-muted">No matching key or scalar value.</p>}
      </div> : <p className="text-[10px] text-muted">Expand objects in place, copy any subtree, or search the captured keys and scalar values.</p>}
    </div>
    <div className="max-h-[68dvh] overflow-auto bg-canvas p-3 text-[11px] leading-5 sm:p-4">
      <JsonView className="token-flow-json-tree" collapsed={initialExpansion} components={components} displayDataTypes={false} displayObjectSize enableClipboard highlightUpdates={false} key={depth} keyName="trace" objectSortKeys={false} shortenTextAfterLength={120} style={jsonTreeStyle} value={value}/>
    </div>
  </div>;
}
