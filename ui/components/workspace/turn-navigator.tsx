"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { formatCompact, formatDuration, formatTime } from "@/lib/format";
import { groupTurns, type TurnOrderMode } from "@/lib/turn-order";
import type { TurnModel } from "@/lib/types";
import { SearchIcon } from "../icons";

const SEARCH_THRESHOLD = 7;
const ORDER_MODES: TurnOrderMode[] = ["model", "turn", "query"];
const ORDER_STORAGE_KEY = "token-flow-turn-order";
const LEGACY_ORDER_STORAGE_KEY = "packlite-turn-order";
const ORDER_CHANGE_EVENT = "token-flow-turn-order-change";

function readOrderMode(): TurnOrderMode {
  const saved = window.localStorage.getItem(ORDER_STORAGE_KEY) ?? window.localStorage.getItem(LEGACY_ORDER_STORAGE_KEY);
  return saved && ORDER_MODES.includes(saved as TurnOrderMode) ? saved as TurnOrderMode : "model";
}

function subscribeOrderMode(onChange: () => void): () => void {
  window.addEventListener("storage", onChange);
  window.addEventListener(ORDER_CHANGE_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(ORDER_CHANGE_EVENT, onChange);
  };
}

function gapLabel(previous: TurnModel | undefined, current: TurnModel): string {
  if (!previous?.timestamp || !current.timestamp) return "";
  const gap = new Date(current.timestamp).getTime() - new Date(previous.timestamp).getTime();
  if (!Number.isFinite(gap) || gap < 60_000) return "";
  if (gap < 3_600_000) return `${Math.round(gap / 60_000)} min gap`;
  return `${(gap / 3_600_000).toFixed(gap < 7_200_000 ? 1 : 0)} hr gap`;
}

function matchesTurn(turn: TurnModel, query: string): boolean {
  if (!query) return true;
  return [turn.label, turn.captureTurn, turn.title, turn.kind, turn.model, turn.method, turn.path, turn.status]
    .some((value) => String(value ?? "").toLowerCase().includes(query));
}

export function TurnNavigator({ turns, selected, onSelect }: { turns: TurnModel[]; selected: number; onSelect: (index: number) => void }) {
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const orderMode = useSyncExternalStore<TurnOrderMode>(subscribeOrderMode, readOrderMode, () => "model");
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set());
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLowerCase();
  const groups = useMemo(() => groupTurns(turns, orderMode), [orderMode, turns]);
  const filteredGroups = useMemo(() => groups.map((group) => ({
    ...group,
    indices: group.indices.filter((index) => matchesTurn(turns[index], normalizedQuery)),
  })).filter((group) => group.indices.length), [groups, normalizedQuery, turns]);
  const filteredIndices = useMemo(() => filteredGroups.flatMap((group) => group.indices), [filteredGroups]);
  const visualIndices = useMemo(() => filteredGroups.flatMap((group) => normalizedQuery || !collapsedGroups.has(group.id) ? group.indices : []), [collapsedGroups, filteredGroups, normalizedQuery]);
  const visiblePosition = filteredIndices.indexOf(selected);

  function changeOrderMode(mode: TurnOrderMode) {
    window.localStorage.setItem(ORDER_STORAGE_KEY, mode);
    window.dispatchEvent(new Event(ORDER_CHANGE_EVENT));
  }

  function toggleGroup(id: string) {
    setCollapsedGroups((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function updateQuery(value: string) {
    setQuery(value);
    const normalized = value.trim().toLowerCase();
    const matches = groups.flatMap((group) => group.indices.filter((index) => matchesTurn(turns[index], normalized)));
    if (matches.length && !matches.includes(selected)) onSelect(matches[0]);
  }

  useEffect(() => {
    buttonRefs.current[selected]?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [selected]);

  useEffect(() => {
    function navigate(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target?.isContentEditable || target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.tagName === "SELECT") return;
      if (event.key === "/" && !event.metaKey && !event.ctrlKey && !event.altKey && turns.length >= SEARCH_THRESHOLD) {
        event.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey || !visualIndices.length) return;

      const visualPosition = visualIndices.indexOf(selected);
      let next = visualPosition >= 0 ? visualPosition : 0;
      if (event.key === "ArrowDown" || event.key === "ArrowRight" || event.key.toLowerCase() === "j") next += 1;
      else if (event.key === "ArrowUp" || event.key === "ArrowLeft" || event.key.toLowerCase() === "k") next -= 1;
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = visualIndices.length - 1;
      else if (event.key === "PageDown") next += 10;
      else if (event.key === "PageUp") next -= 10;
      else return;

      event.preventDefault();
      onSelect(visualIndices[Math.max(0, Math.min(next, visualIndices.length - 1))]);
    }

    window.addEventListener("keydown", navigate);
    return () => window.removeEventListener("keydown", navigate);
  }, [onSelect, selected, turns.length, visualIndices]);

  return (
    <aside className="min-w-0 max-w-full overflow-hidden border-b border-line bg-panel lg:sticky lg:top-[73px] lg:flex lg:h-[calc(100dvh-89px)] lg:flex-col lg:rounded-2xl lg:border lg:shadow-sm">
      <div className="border-b border-line px-3 pb-2 pt-3">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-semibold">Turns</h2>
          <span aria-live="polite" className="font-mono text-[11px] text-muted">{visiblePosition >= 0 ? visiblePosition + 1 : 0} of {filteredIndices.length}{normalizedQuery ? ` · ${turns.length} total` : ""}</span>
        </div>
        <div aria-label="Turn order" className="mt-2 grid grid-cols-3 rounded-lg bg-canvas p-1 text-[10px] font-semibold">
          {ORDER_MODES.map((mode) => <button aria-pressed={orderMode === mode} className={`min-h-8 rounded-md px-2 transition ${orderMode === mode ? "bg-panel text-ink shadow-sm" : "text-muted hover:text-ink"}`} key={mode} onClick={() => changeOrderMode(mode)} type="button">{mode === "model" ? "Model" : mode === "turn" ? "Turn" : "Query"}</button>)}
        </div>
        {turns.length >= SEARCH_THRESHOLD ? <label className="relative mt-2 block">
          <span className="sr-only">Search turns</span>
          <SearchIcon className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted"/>
          <input className="h-9 w-full rounded-lg border border-line bg-canvas pl-8 pr-8 text-xs outline-none placeholder:text-muted" onChange={(event) => updateQuery(event.target.value)} placeholder="Search turns  /" ref={searchRef} type="search" value={query}/>
          {query ? <button aria-label="Clear turn search" className="absolute right-1 top-0 grid size-9 place-items-center text-sm text-muted hover:text-ink" onClick={() => updateQuery("")} type="button">×</button> : null}
        </label> : null}
      </div>
      <div className="scrollbar-none flex snap-x gap-3 overflow-x-auto px-3 pb-3 pt-2 lg:min-h-0 lg:flex-1 lg:snap-none lg:flex-col lg:gap-2 lg:overflow-x-hidden lg:overflow-y-auto lg:px-2">
        {filteredGroups.map((group) => {
          const collapsed = !normalizedQuery && collapsedGroups.has(group.id);
          const showHeader = orderMode === "query" || (orderMode === "model" && groups.length > 1);
          const containsSelected = group.indices.includes(selected);
          return <section className="shrink-0 lg:w-full" key={group.id}>
            {showHeader ? <button aria-expanded={!collapsed} className={`mb-1 flex min-h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[10px] hover:bg-canvas ${containsSelected ? "text-ink" : "text-muted"}`} onClick={() => toggleGroup(group.id)} title={group.label} type="button">
              <span aria-hidden="true" className={`text-[8px] transition ${collapsed ? "" : "rotate-90"}`}>▶</span>
              <span className="max-w-[176px] flex-1 truncate font-medium lg:max-w-none">{group.label}</span>
              <span className="rounded-full bg-canvas px-1.5 font-mono text-[9px]">{group.indices.length}</span>
            </button> : null}
            {!collapsed ? <ol className="flex gap-2 lg:flex-col lg:gap-1">{group.indices.map((index) => {
          const turn = turns[index];
          const active = index === selected;
          const failed = turn.status >= 400;
          const gap = orderMode === "turn" ? gapLabel(turns[index - 1], turn) : "";
          const kindLabel = turn.kind === "metadata" ? "Meta" : turn.kind === "tool" ? "Tool" : "";
          return (
            <li className="relative shrink-0 after:absolute after:left-full after:top-1/2 after:h-px after:w-2 after:bg-line last:after:hidden lg:w-full lg:after:left-1/2 lg:after:top-full lg:after:h-1 lg:after:w-px" key={turn.id} style={{ contentVisibility: "auto", containIntrinsicSize: "90px" }}>
              {gap ? <div className="mb-1 flex items-center gap-2 px-1 text-[9px] text-muted"><span className="h-px flex-1 bg-line"/><span className="whitespace-nowrap font-mono">{gap}</span><span className="h-px flex-1 bg-line"/></div> : null}
              <button
                aria-current={active ? "page" : undefined}
                aria-label={`Turn ${turn.label}, ${turn.title}, ${formatCompact(turn.input + turn.output)} tokens, ${turn.model}${failed ? `, HTTP ${turn.status}` : ""}`}
                className={`relative min-h-[88px] w-[228px] snap-start rounded-lg px-2.5 py-2 text-left transition focus-visible:outline-ink lg:w-full ${active ? "bg-canvas shadow-[inset_0_0_0_1px_var(--line)]" : "hover:bg-canvas/70"}`}
                onClick={() => onSelect(index)}
                ref={(element) => { buttonRefs.current[index] = element; }}
                title={turn.captureTurn !== undefined ? `Captured request ${turn.captureTurn}` : undefined}
                type="button"
              >
                <span className="min-w-0">
                  <span className="flex items-center justify-between gap-2">
                    <span className="flex min-w-0 items-center gap-1.5"><strong className="text-[13px]">Turn {turn.label}</strong>{kindLabel ? <span className="rounded-full border border-line px-1.5 py-0.5 font-mono text-[8px] uppercase tracking-wide text-muted">{kindLabel}</span> : null}</span>
                    <span className="truncate font-mono text-[9px] text-muted">{turn.model}</span>
                  </span>
                  <span className="mt-0.5 block truncate text-[11px] font-medium text-ink">{turn.title}</span>
                  <span className="mt-0.5 flex items-center gap-2 font-mono text-[10px]"><b>{formatCompact(turn.input + turn.output)} tok</b><span className="text-warning">{formatDuration(turn.durationMs)}</span><span className="ml-auto text-muted">{formatTime(turn.timestamp)}</span></span>
                  <span className="mt-0.5 flex min-w-0 items-center gap-2 font-mono text-[9px]"><span className={`truncate ${failed ? "text-danger" : "text-muted"}`}>{turn.method} {turn.path}</span>{failed ? <span className="ml-auto inline-flex shrink-0 items-center gap-1 font-semibold text-danger"><i className="size-1.5 rounded-full bg-current"/>HTTP {turn.status}</span> : null}</span>
                </span>
              </button>
            </li>
          );
        })}</ol> : null}
          </section>;
        })}
        {!filteredIndices.length ? <div className="w-full px-2 py-10 text-center text-xs text-muted">No turns match “{query}”.</div> : null}
      </div>
    </aside>
  );
}
