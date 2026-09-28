"use client";

import { createContext, useContext, useRef, useState, type ReactNode } from "react";
import { Button } from "../ui/button";
import { ChevronRightIcon } from "../ui/icons";

type JsonPathPart = number | string;

function jsonPath(parts: JsonPathPart[]): string {
  return parts.reduce<string>((path, part) => {
    if (typeof part === "number") return `${path}[${part}]`;
    if (/^[A-Za-z_$][\w$]*$/.test(part)) return path ? `${path}.${part}` : part;
    return `${path}[${JSON.stringify(part)}]`;
  }, "");
}

function pathStartsWith(path: JsonPathPart[], prefix: JsonPathPart[]): boolean {
  return prefix.length <= path.length && prefix.every((part, index) => part === path[index]);
}

type SourceRange = { start: number; end: number };
export type RawTarget = { path: JsonPathPart[]; range?: SourceRange; cached: boolean };
const TargetsContext = createContext<{ targets: RawTarget[]; active: boolean }>({ targets: [], active: false });

function TargetValue({ targets, value, range }: { targets: RawTarget[]; value: unknown; range?: SourceRange }) {
  if (typeof value !== "string" || !targets.some((target) => target.range)) {
    const cached = targets.length > 0 && targets.every((target) => target.cached);
    return <span className={cached ? "tf-cached-content" : undefined} data-cache-state={cached ? "cached" : undefined}><Primitive range={range} value={value}/></span>;
  }
  const boundaries = [...new Set([0, value.length, ...targets.flatMap((target) => target.range ? [target.range.start, target.range.end] : [])])].filter((offset) => offset >= 0 && offset <= value.length).sort((a, b) => a - b);
  return <span className="text-syntax-string">&quot;{boundaries.slice(0, -1).map((start, index) => {
    const end = boundaries[index + 1];
    const covering = targets.filter((target) => !target.range || (target.range.start <= start && target.range.end >= end));
    const cached = covering.length > 0 && covering.every((target) => target.cached);
    if (!covering.length) return <details className="inline" key={start}><summary className="inline cursor-pointer text-muted" title="Unrelated text; expand to inspect">…</summary>{JSON.stringify(value.slice(start, end)).slice(1, -1)}</details>;
    const current = range && start >= range.start && end <= range.end;
    return <span className={cached ? "tf-cached-content" : undefined} data-cache-state={cached ? "cached" : undefined} data-source-range={current ? "" : undefined} key={start}>{JSON.stringify(value.slice(start, end)).slice(1, -1)}</span>;
  })}&quot;</span>;
}

function Primitive({ value, range }: { value: unknown; range?: SourceRange }) {
  if (value === null) return <span className="text-muted">null</span>;
  if (typeof value === "string") {
    if (range && range.start >= 0 && range.end <= value.length && range.start < range.end) {
      const escaped = (text: string) => JSON.stringify(text).slice(1, -1);
      return <span className="text-syntax-string">&quot;{escaped(value.slice(0, range.start))}<mark className="bg-highlight-soft text-inherit" data-source-range="" tabIndex={-1}>{escaped(value.slice(range.start, range.end))}</mark>{escaped(value.slice(range.end))}&quot;</span>;
    }
    return <span className="text-syntax-string">{JSON.stringify(value)}</span>;
  }
  if (typeof value === "number") return <span className="text-syntax-number">{String(value)}</span>;
  if (typeof value === "boolean") return <span className="text-syntax-boolean">{String(value)}</span>;
  return <span className="text-muted">{JSON.stringify(String(value))}</span>;
}

function JsonKey({ children }: { children: ReactNode }) {
  return <span className="text-syntax-key">{children}</span>;
}

function RawJsonNode({ blockId, isLast = true, keyName, path, selectedPath, selectedRange, turnId, value }: { blockId?: string; isLast?: boolean; keyName?: JsonPathPart; path: JsonPathPart[]; selectedPath?: JsonPathPart[] | null; selectedRange?: SourceRange; turnId: string; value: unknown }) {
  const { targets, active: focused } = useContext(TargetsContext);
  const related = targets.some((target) => pathStartsWith(target.path, path) || pathStartsWith(path, target.path));
  const ownTargets = targets.filter((target) => pathStartsWith(path, target.path));
  const [collapsed, setCollapsed] = useState(focused && !related && path.length > 1);
  const selected = Boolean(selectedPath && path.length === selectedPath.length && pathStartsWith(selectedPath, path));
  const containsSelection = Boolean(selectedPath && pathStartsWith(selectedPath, path));
  const open = !collapsed || (!focused && containsSelection);
  const pathString = jsonPath(path);
  const itemProps = selected ? { "data-block-id": blockId, "data-json-selected": "true", "data-turn-id": turnId, tabIndex: -1 } : {};
  const key = keyName === undefined ? null : <><JsonKey>{typeof keyName === "number" ? keyName : JSON.stringify(keyName)}</JsonKey><span className="text-muted">: </span></>;
  const comma = isLast ? null : <span className="text-muted">,</span>;
  const objectLike = value !== null && typeof value === "object";

  if (!objectLike) {
    if (focused && !related) return <details className="raw-json-line rounded-tag px-1" data-json-path={pathString}><summary className="cursor-pointer">{key}<span className="text-muted">…</span>{comma}</summary><Primitive value={value}/></details>;
    return <div className={`raw-json-line rounded-tag px-1 ${selected ? "raw-json-selected" : ""}`} data-json-path={pathString} {...itemProps}>{key}<TargetValue targets={ownTargets} range={selected ? selectedRange : undefined} value={value}/>{comma}</div>;
  }

  const isArray = Array.isArray(value);
  const entries = isArray ? value.map((item, index) => [index, item] as const) : Object.entries(value as Record<string, unknown>);
  const openMark = isArray ? "[" : "{";
  const closeMark = isArray ? "]" : "}";
  const countLabel = `${entries.length} ${isArray ? (entries.length === 1 ? "item" : "items") : (entries.length === 1 ? "key" : "keys")}`;

  return <div className="raw-json-branch" data-json-path={pathString}>
    <div className={`raw-json-line flex min-w-0 items-start rounded-tag px-1 ${selected ? "raw-json-selected" : ""}`} data-json-path={pathString} {...itemProps}>
      <button aria-expanded={open} aria-label={`${open ? "Collapse" : "Expand"} ${pathString}`} className="mr-1 mt-[0.15em] inline-flex size-4 shrink-0 items-center justify-center rounded-tag text-muted hover:bg-fill-hover hover:text-ink" onClick={() => setCollapsed(open)} type="button"><ChevronRightIcon className={`size-3 transition-transform ${open ? "rotate-90" : ""}`} strokeWidth={2.25}/></button>
      <span className="min-w-0 break-words">{key}<span className="text-muted">{openMark}</span>{open ? null : <><span className="ml-1 text-muted">… {countLabel}</span><span className="text-muted">{closeMark}</span>{comma}</>}</span>
    </div>
    {open ? <>
      <div className="ml-2 border-l border-line pl-3">
        {entries.map(([entryKey, entryValue], index) => <RawJsonNode blockId={blockId} isLast={index === entries.length - 1} key={`${String(entryKey)}-${index}`} keyName={entryKey} path={[...path, entryKey]} selectedPath={selectedPath} selectedRange={selectedRange} turnId={turnId} value={entryValue}/>) }
      </div>
      <div className="raw-json-line px-1 text-muted">{closeMark}{comma}</div>
    </> : null}
  </div>;
}

export function RawJsonTree({ active = false, targets = [], selectedBlockId, selectedPath, selectedRange, turnId, value }: { active?: boolean; targets?: RawTarget[]; selectedBlockId?: string; selectedPath?: JsonPathPart[] | null; selectedRange?: SourceRange; turnId: string; value: object }) {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<number | undefined>(undefined);

  const copyRaw = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(value, null, 2));
      setCopied(true);
      window.clearTimeout(resetTimer.current);
      resetTimer.current = window.setTimeout(() => setCopied(false), 1400);
    } catch {
      setCopied(false);
    }
  };

  return <div>
    <div className="tf-inset flex flex-wrap items-center justify-between gap-2 border-b border-line bg-panel py-2">
      <p className="text-xs text-muted">{active || targets.length ? "Exact captured JSON · matching paths expanded" : "Exact captured JSON · expanded by default · fold nodes in place"}</p>
      <Button compact onClick={() => void copyRaw()}>{copied ? "Copied" : "Copy raw JSON"}</Button>
    </div>
    <div aria-label="Raw captured JSON tree" className="token-flow-raw-json tf-code tf-pad max-h-[68dvh] overflow-auto bg-canvas text-ink" role="region">
      <TargetsContext.Provider value={{ targets, active: active || targets.length > 0 }}><RawJsonNode blockId={selectedBlockId} key={JSON.stringify([active, targets, selectedPath])} path={["trace"]} selectedPath={selectedPath} selectedRange={selectedRange} turnId={turnId} value={value}/></TargetsContext.Provider>
    </div>
  </div>;
}
