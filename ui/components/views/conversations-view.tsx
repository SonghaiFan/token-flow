"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { clearSessions, deleteSession, fetchAgents, fetchSessions } from "@/lib/api";
import { formatCompact, formatDate, formatDay, formatNumber } from "@/lib/format";
import type { AgentBucket, SessionSummary, SessionsPayload } from "@/lib/types";
import { AppShell } from "../app-shell";
import { AgentMark } from "../agent-mark";
import { CaptureButton } from "../capture-menu";
import { DeleteDialog } from "../delete-dialog";
import { ChevronRightIcon, MoreIcon, SearchIcon } from "../icons";
import { Menu, MenuItem } from "../menu";

const EMPTY: SessionsPayload = { sessions: [], total: 0, total_records: 0, total_tokens: 0, total_errors: 0, dates: [], has_legacy: false, has_more: false };
const PAGE_SIZE = 20;
const ROW_GRID = "lg:grid-cols-[minmax(0,1fr)_10rem_8rem_5rem_7rem_2.75rem]";

function isActive(session: SessionSummary): boolean {
  return Boolean(session.live) || session.status === "active";
}

/* Complete is the normal state and stays unmarked; only exceptions are labeled. */
function StatusMark({ session }: { session: SessionSummary }) {
  if (session.status === "error") return <span className="inline-flex shrink-0 items-center rounded-full bg-red-50 px-2 py-0.5 text-[11px] font-semibold text-red-700 ring-1 ring-inset ring-red-200 dark:bg-red-950 dark:text-red-300 dark:ring-red-900">Error</span>;
  if (session.status === "empty") return <span className="inline-flex shrink-0 items-center rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-700 ring-1 ring-inset ring-amber-200 dark:bg-amber-950 dark:text-amber-300 dark:ring-amber-900">Empty</span>;
  return null;
}

function Stat({ label, value }: { label: string; value: string }) {
  return <div className="min-w-0"><dd className="font-mono text-lg font-semibold tracking-[-0.03em] text-ink">{value}</dd><dt className="text-xs text-muted">{label}</dt></div>;
}

function FilterSelect({ children, label, onChange, value }: { children: ReactNode; label: string; onChange: (value: string) => void; value: string }) {
  return <label className="relative block shrink-0">
    <span className="sr-only">{label}</span>
    <select className="tf-control w-full appearance-none rounded-control border border-line bg-panel pl-3 pr-9 text-sm text-ink outline-none hover:bg-canvas focus-visible:ring-2 focus-visible:ring-ink/20" onChange={(event) => onChange(event.target.value)} value={value}>{children}</select>
    <ChevronRightIcon aria-hidden="true" className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 rotate-90 text-muted"/>
  </label>;
}

function ConversationRow({ onDelete, onOpen, session }: { onDelete: () => void; onOpen: () => void; session: SessionSummary }) {
  const active = isActive(session);
  const title = session.first_user || "Untitled conversation";
  const turns = session.turn_count ?? session.record_count ?? 0;
  const tokens = session.total_tokens || 0;
  const started = session.started_at || session.updated_at;
  const agent = session.agent || "Unknown";
  return <div className={`group relative grid grid-cols-[minmax(0,1fr)_2.75rem] items-center gap-x-3 gap-y-1 px-4 py-3 transition-colors hover:bg-canvas/70 lg:min-h-14 lg:gap-4 lg:px-5 ${ROW_GRID}`}>
    <div className="flex min-w-0 items-center gap-2.5">
      <span aria-hidden="true" className={`size-2 shrink-0 rounded-full ${active ? "bg-emerald-500" : "bg-transparent"}`}/>
      <button className="min-w-0 truncate text-left text-sm font-medium text-ink after:absolute after:inset-0 after:content-[''] focus-visible:outline-none focus-visible:after:rounded-control focus-visible:after:ring-2 focus-visible:after:ring-ink/30" onClick={onOpen} title={title} type="button">{title}</button>
      {active ? <span className="sr-only">Active</span> : null}
      <StatusMark session={session}/>
    </div>
    <span className="hidden min-w-0 items-center gap-2 text-sm text-muted lg:flex"><AgentMark label={agent}/><span className="truncate">{agent}</span></span>
    <span className="hidden text-sm text-muted lg:block" title={formatDate(started)}>{formatDay(started)}</span>
    <span className="hidden font-mono text-sm text-muted lg:block">{formatNumber(turns)}</span>
    <span className="hidden font-mono text-sm text-ink lg:block">{tokens ? formatNumber(tokens) : "—"}</span>
    <div className="relative z-10 row-span-2 justify-self-end lg:row-span-1">
      <Menu label={`Actions for ${title}`} trigger={(props) => <button {...props} aria-label={`Actions for ${title}`} className="tf-icon-control grid place-items-center rounded-control text-muted opacity-100 hover:bg-panel hover:text-ink focus-visible:opacity-100 lg:opacity-0 lg:group-hover:opacity-100 lg:aria-expanded:opacity-100" type="button"><MoreIcon className="size-5"/></button>} width={220}>
        {(close) => <>
          <MenuItem onSelect={() => { close(); onOpen(); }}>Open conversation</MenuItem>
          <MenuItem danger disabled={active} onSelect={() => { close(); onDelete(); }}>{active ? "Active conversations can't be deleted" : "Delete conversation…"}</MenuItem>
        </>}
      </Menu>
    </div>
    <p className="col-start-1 flex min-w-0 items-center gap-1.5 pl-[18px] text-xs text-muted lg:hidden">
      <AgentMark label={agent}/><span className="truncate">{agent} · {formatDay(started)} · {tokens ? `${formatCompact(tokens)} tokens` : "no tokens"}</span>
    </p>
  </div>;
}

export function ConversationsView({ onOpen }: { onOpen: (id: string) => void }) {
  const [payload, setPayload] = useState(EMPTY);
  const [agents, setAgents] = useState<AgentBucket[]>([]);
  const [agent, setAgent] = useState("");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<SessionSummary | "all" | null>(null);
  const [deleteError, setDeleteError] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [liveState, setLiveState] = useState<"connecting" | "watching" | "reconnecting">("connecting");

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      const [nextPayload, nextAgents] = await Promise.all([
        fetchSessions({ agent, search, status }, signal),
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
  }, [agent, search, status]);

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

  const setFilter = useCallback((update: () => void) => {
    update();
    setPage(0);
  }, []);
  const filtered = Boolean(agent || search.trim() || status);
  const turnTotal = useMemo(() => payload.sessions.reduce((sum, session) => sum + (session.turn_count || 0), 0), [payload.sessions]);
  const pageCount = Math.max(1, Math.ceil(payload.sessions.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const rows = payload.sessions.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);

  const closeDeleteDialog = useCallback(() => {
    if (deleting) return;
    setDeleteTarget(null);
    setDeleteError("");
  }, [deleting]);
  const confirmDelete = useCallback(async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    setDeleteError("");
    try {
      const result = deleteTarget === "all" ? await clearSessions() : await deleteSession(deleteTarget.id);
      const skipped = result.skipped_active_sessions?.length || 0;
      setNotice(`${result.deleted_sessions} ${result.deleted_sessions === 1 ? "conversation" : "conversations"} deleted${skipped ? `; ${skipped} active ${skipped === 1 ? "conversation was" : "conversations were"} kept` : ""}.`);
      setDeleteTarget(null);
      await load();
    } catch (reason) {
      setDeleteError((reason as Error).message || "Unable to delete conversations");
    } finally {
      setDeleting(false);
    }
  }, [deleteTarget, load]);

  const watching = <span className="inline-flex items-center gap-2"><i className={`size-2 rounded-full ${liveState === "watching" ? "bg-emerald-500" : "bg-amber-500"}`}/>{liveState === "watching" ? "Watching" : liveState === "reconnecting" ? "Reconnecting" : "Connecting"}</span>;

  return (
    <AppShell
      captureIndicator={false}
      menu={(close) => <>
        <MenuItem onSelect={() => { close(); void load(); }}>Refresh conversations</MenuItem>
        <MenuItem danger disabled={!payload.total || loading} onSelect={() => { close(); setDeleteError(""); setDeleteTarget("all"); }}>Clear all conversations…</MenuItem>
      </>}
      meta={watching}
    >
      <main className="mx-auto w-full max-w-[1280px] px-4 pb-10 pt-8 sm:px-6 sm:pt-12">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-3xl font-semibold tracking-[-0.045em] sm:text-4xl">Conversations</h1>
            <p className="mt-2 text-sm text-muted sm:text-base">Capture, inspect, and understand what your agents are doing.</p>
          </div>
          <CaptureButton/>
        </div>

        <dl className="mt-6 flex flex-wrap items-end gap-x-10 gap-y-3">
          <Stat label={payload.total === 1 ? "conversation" : "conversations"} value={formatNumber(payload.total)}/>
          <Stat label="turns" value={formatNumber(turnTotal)}/>
          <Stat label="tokens" value={formatCompact(payload.total_tokens)}/>
          {payload.total_errors ? <button className="inline-flex items-center gap-1.5 self-center rounded-full bg-amber-50 px-3 py-1 text-xs font-semibold text-amber-800 ring-1 ring-inset ring-amber-200 hover:bg-amber-100 dark:bg-amber-950 dark:text-amber-300 dark:ring-amber-900" onClick={() => setFilter(() => setStatus("error"))} type="button">⚠ {formatNumber(payload.total_errors)} {payload.total_errors === 1 ? "issue" : "issues"}</button> : null}
        </dl>

        <div className="mt-6 flex flex-col gap-2 sm:flex-row">
          <label className="relative block min-w-0 flex-1">
            <span className="sr-only">Search conversations</span>
            <SearchIcon className="pointer-events-none absolute left-3.5 top-1/2 size-[18px] -translate-y-1/2 text-muted"/>
            <input className="tf-control w-full rounded-control border border-line bg-panel pl-10 pr-3 text-sm outline-none placeholder:text-muted focus-visible:ring-2 focus-visible:ring-ink/20" onChange={(event) => setFilter(() => setSearch(event.target.value))} placeholder="Search conversations…" type="search" value={search}/>
          </label>
          <div className="grid grid-cols-2 gap-2 sm:flex">
            <FilterSelect label="Agent" onChange={(value) => setFilter(() => setAgent(value))} value={agent}>
              <option value="">All agents</option>
              {agents.map((item) => <option key={item.key} value={item.key}>{item.label} ({item.sessions})</option>)}
            </FilterSelect>
            <FilterSelect label="Status" onChange={(value) => setFilter(() => setStatus(value))} value={status}>
              <option value="">All statuses</option>
              <option value="active">Active</option>
              <option value="complete">Complete</option>
              <option value="empty">Empty</option>
              <option value="error">Error</option>
            </FilterSelect>
          </div>
        </div>

        {error ? <div className="mt-4 rounded-control border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300" role="alert">{error}</div> : null}
        {notice ? <div aria-live="polite" className="mt-4 flex items-center justify-between gap-3 rounded-control border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300"><span>{notice}</span><button aria-label="Dismiss notice" className="text-lg leading-none" onClick={() => setNotice("")} type="button">×</button></div> : null}

        <section aria-label="Conversations" className="mt-6">
          <div className={`hidden gap-4 border-b border-line px-5 pb-2 text-[11px] font-semibold uppercase tracking-[0.1em] text-muted lg:grid ${ROW_GRID}`}>
            <span className="pl-[18px]">Conversation</span><span>Agent</span><span className="text-ink">Started ↓</span><span>Turns</span><span>Tokens</span><span className="sr-only">Actions</span>
          </div>
          <div className="divide-y divide-line border-b border-line">
            {rows.map((session) => <ConversationRow key={session.id} onDelete={() => { setDeleteError(""); setDeleteTarget(session); }} onOpen={() => onOpen(session.id)} session={session}/>)}
            {!loading && !payload.sessions.length && filtered ? <div className="px-5 py-12 text-center text-sm text-muted">No conversations match these filters.</div> : null}
            {!loading && !payload.sessions.length && !filtered ? <div className="flex flex-col items-center gap-2 px-5 py-14 text-center">
              <p className="text-sm font-medium text-ink">No conversations yet</p>
              <p className="max-w-sm text-sm text-muted">Use Capture to open an agent through Token Flow. Each conversation it runs appears here as it happens.</p>
            </div> : null}
            {loading && !payload.sessions.length ? <div className="px-5 py-12 text-center text-sm text-muted">Loading conversations…</div> : null}
          </div>
          {payload.sessions.length ? <div className="mt-4 flex items-center justify-between gap-3 text-xs text-muted">
            <span>Showing {formatNumber(rows.length)} of {formatNumber(payload.total)} {payload.total === 1 ? "conversation" : "conversations"}</span>
            {pageCount > 1 ? <nav aria-label="Pages" className="flex items-center gap-1">
              <button aria-label="Previous page" className="tf-icon-control grid place-items-center rounded-control hover:bg-canvas disabled:opacity-30" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)} type="button"><ChevronRightIcon className="size-4 rotate-180"/></button>
              {Array.from({ length: pageCount }, (_, index) => <button aria-current={index === currentPage ? "page" : undefined} className={`tf-icon-control grid place-items-center rounded-control font-mono text-xs ${index === currentPage ? "border border-line bg-panel text-ink" : "hover:bg-canvas"}`} key={index} onClick={() => setPage(index)} type="button">{index + 1}</button>)}
              <button aria-label="Next page" className="tf-icon-control grid place-items-center rounded-control hover:bg-canvas disabled:opacity-30" disabled={currentPage >= pageCount - 1} onClick={() => setPage(currentPage + 1)} type="button"><ChevronRightIcon className="size-4"/></button>
            </nav> : null}
          </div> : null}
        </section>
      </main>
      <DeleteDialog busy={deleting} description={deleteTarget === "all" ? "This permanently deletes every stored conversation that is not currently active. Active conversations are kept." : `This permanently deletes “${deleteTarget?.first_user || "Untitled conversation"}” and its captured records.`} error={deleteError} onCancel={closeDeleteDialog} onConfirm={() => void confirmDelete()} open={deleteTarget !== null} title={deleteTarget === "all" ? "Clear all conversations?" : "Delete this conversation?"}/>
    </AppShell>
  );
}
