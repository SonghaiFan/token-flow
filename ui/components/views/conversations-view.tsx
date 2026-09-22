"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchAgents, fetchSessions } from "@/lib/api";
import { formatDate, formatNumber } from "@/lib/format";
import type { AgentBucket, SessionSummary, SessionsPayload } from "@/lib/types";
import { AppShell } from "../app-shell";
import { ChevronRightIcon, RefreshIcon, SearchIcon } from "../icons";

const EMPTY: SessionsPayload = { sessions: [], total: 0, total_records: 0, total_tokens: 0, total_errors: 0, dates: [], has_legacy: false, has_more: false };

function statusOf(session: SessionSummary): string {
  if (session.live || session.status === "active") return "Active";
  if (session.status === "error") return "Error";
  if (session.status === "empty") return "Empty";
  if (session.status === "complete") return "Complete";
  return "Unknown";
}

function StatusBadge({ session }: { session: SessionSummary }) {
  const status = statusOf(session);
  const tone = status === "Active" ? "bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-950 dark:text-emerald-300" : status === "Error" ? "bg-red-50 text-red-700 ring-red-200 dark:bg-red-950 dark:text-red-300" : status === "Empty" ? "bg-amber-50 text-amber-700 ring-amber-200 dark:bg-amber-950 dark:text-amber-300" : "bg-canvas text-muted ring-line";
  return <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold ring-1 ring-inset ${tone}`}><i className="size-1.5 rounded-full bg-current" />{status}</span>;
}

function Metric({ label, value }: { label: string; value: number }) {
  return <div className="min-w-0"><dt className="text-[11px] font-medium text-muted">{label}</dt><dd className="mt-1 font-mono text-xl font-semibold tracking-[-0.04em] sm:text-2xl">{formatNumber(value)}</dd></div>;
}

export function ConversationsView({ onOpen }: { onOpen: (id: string) => void }) {
  const [payload, setPayload] = useState(EMPTY);
  const [agents, setAgents] = useState<AgentBucket[]>([]);
  const [agent, setAgent] = useState("");
  const [search, setSearch] = useState("");
  const [date, setDate] = useState("");
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [liveState, setLiveState] = useState<"connecting" | "watching" | "reconnecting">("connecting");

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      const [nextPayload, nextAgents] = await Promise.all([
        fetchSessions({ agent, search, date, status }, signal),
        fetchAgents(signal),
      ]);
      setPayload(nextPayload);
      setAgents(nextAgents);
      setError("");
    } catch (reason) {
      if ((reason as Error).name !== "AbortError") setError((reason as Error).message || "Unable to load conversations");
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [agent, date, search, status]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => void load(controller.signal), 180);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [load]);

  useEffect(() => {
    const events = new EventSource("/dashboard/events");
    const refresh = () => void load();
    events.onopen = () => setLiveState("watching");
    events.onerror = () => setLiveState("reconnecting");
    events.addEventListener("record", refresh);
    events.addEventListener("refresh", refresh);
    return () => {
      events.removeEventListener("record", refresh);
      events.removeEventListener("refresh", refresh);
      events.close();
    };
  }, [load]);

  const agentOptions = useMemo(() => [{ key: "", label: "All agents", sessions: payload.total, records: payload.total_records }, ...agents], [agents, payload.total, payload.total_records]);
  const turnTotal = useMemo(() => payload.sessions.reduce((sum, session) => sum + (session.turn_count || 0), 0), [payload.sessions]);

  return (
    <AppShell meta={<><span>{formatNumber(payload.total)} conversations</span><span>{formatNumber(turnTotal)} turns</span><span className={liveState === "watching" ? "text-success" : "text-warning"}>● {liveState === "watching" ? "Watching" : liveState === "reconnecting" ? "Reconnecting" : "Connecting"}</span></>}>
      <main className="mx-auto w-full max-w-[1480px] px-4 py-6 sm:px-6 sm:py-8">
        <div className="flex items-end justify-between gap-4">
          <div><h1 className="text-2xl font-semibold tracking-[-0.04em] sm:text-3xl">Conversations</h1><p className="mt-1 text-sm text-muted">Choose one to understand what the agent sent.</p></div>
          <button aria-label="Refresh conversations" className="grid size-11 place-items-center rounded-xl border border-line bg-panel hover:bg-canvas" onClick={() => void load()} type="button"><RefreshIcon className={loading ? "animate-spin" : ""} /></button>
        </div>

        <div className="scrollbar-none -mx-4 mt-5 flex gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:px-0">
          {agentOptions.map((item) => <button className={`min-h-11 shrink-0 rounded-full border px-4 text-sm font-medium ${agent === item.key ? "border-ink bg-ink text-panel" : "border-line bg-panel text-muted hover:text-ink"}`} key={item.key || "all"} onClick={() => setAgent(item.key)} type="button">{item.label} <span className="ml-1 font-mono text-xs opacity-70">{item.sessions}</span></button>)}
        </div>

        <section className="mt-5 rounded-2xl border border-line bg-panel p-4 shadow-sm sm:p-5">
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Metric label="Conversations" value={payload.total} />
            <Metric label="Turns" value={turnTotal} />
            <Metric label="Problems" value={payload.total_errors} />
            <Metric label="Total tokens" value={payload.total_tokens} />
          </div>
        </section>

        <section className="mt-4">
          <div className="grid gap-3 lg:grid-cols-[minmax(18rem,1fr)_10rem_10rem]">
            <label className="relative block"><span className="sr-only">Search conversations</span><SearchIcon className="pointer-events-none absolute left-3.5 top-3 size-[18px] text-muted"/><input className="h-11 w-full rounded-xl border border-line bg-panel pl-10 pr-3 text-sm outline-none placeholder:text-muted" onChange={(event) => setSearch(event.target.value)} placeholder="Search conversations" type="search" value={search}/></label>
            <select aria-label="Date" className="h-11 rounded-xl border border-line bg-panel px-3 text-sm" onChange={(event) => setDate(event.target.value)} value={date}><option value="">All dates</option>{payload.dates.map((item) => <option key={item} value={item}>{item}</option>)}</select>
            <select aria-label="Status" className="h-11 rounded-xl border border-line bg-panel px-3 text-sm" onChange={(event) => setStatus(event.target.value)} value={status}><option value="">All statuses</option><option value="active">Active</option><option value="complete">Complete</option><option value="error">Error</option><option value="empty">Empty</option></select>
          </div>
        </section>

        {error ? <div className="mt-4 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</div> : null}
        <section className="mt-4 overflow-hidden rounded-2xl border border-line bg-panel shadow-sm">
          <div className="hidden grid-cols-[minmax(16rem,1fr)_9rem_12rem_6rem_8rem_7rem] gap-4 border-b border-line px-5 py-3 text-[10px] font-semibold uppercase tracking-[0.1em] text-muted lg:grid"><span>Conversation</span><span>Agent</span><span>Started</span><span>Turns</span><span>Tokens</span><span>Status</span></div>
          <div className="divide-y divide-line">
            {payload.sessions.map((session) => (
              <button className="grid min-h-[94px] w-full grid-cols-[1fr_auto] gap-3 p-4 text-left hover:bg-canvas lg:min-h-[66px] lg:grid-cols-[minmax(16rem,1fr)_9rem_12rem_6rem_8rem_7rem] lg:items-center lg:gap-4 lg:px-5 lg:py-3" key={session.id} onClick={() => onOpen(session.id)} type="button">
                <div className="min-w-0"><div className="line-clamp-2 text-sm font-medium lg:truncate">{session.first_user || "Untitled conversation"}</div><div className="mt-2 flex items-center gap-2 text-xs text-muted lg:hidden"><span>{session.agent || "Unknown"}</span><span>·</span><span>{formatDate(session.started_at || session.updated_at)}</span></div></div>
                <ChevronRightIcon className="self-center text-muted lg:hidden"/>
                <span className="hidden text-sm text-muted lg:block">{session.agent || "Unknown"}</span>
                <span className="hidden font-mono text-xs text-muted lg:block">{formatDate(session.started_at || session.updated_at)}</span>
                <span className="hidden font-mono text-sm lg:block">{formatNumber(session.turn_count ?? session.record_count ?? 0)}</span>
                <span className="hidden font-mono text-sm lg:block">{formatNumber(session.total_tokens || 0)}</span>
                <span className="hidden lg:block"><StatusBadge session={session}/></span>
                <div className="col-span-2 flex items-center justify-between lg:hidden"><div className="flex gap-4 font-mono text-xs"><span>{formatNumber(session.turn_count ?? session.record_count ?? 0)} turns</span><span>{formatNumber(session.total_tokens || 0)} tok</span></div><StatusBadge session={session}/></div>
              </button>
            ))}
            {!loading && !payload.sessions.length ? <div className="p-10 text-center text-sm text-muted">No conversations match these filters.</div> : null}
            {loading && !payload.sessions.length ? <div className="p-10 text-center text-sm text-muted">Loading conversations…</div> : null}
          </div>
        </section>
      </main>
    </AppShell>
  );
}
