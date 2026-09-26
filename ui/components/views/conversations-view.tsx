"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { clearSessions, deleteSession, fetchAgents, fetchSessions } from "@/lib/api";
import { formatCompact, formatDate, formatDay, formatNumber } from "@/lib/format";
import type { AgentBucket, SessionSummary, SessionsPayload } from "@/lib/types";
import { AppShell, LiveStatus, type LiveState } from "../app-shell";
import { AgentMark } from "../agent-mark";
import { CaptureButton } from "../capture-menu";
import { Badge, StatusDot } from "../ui/badge";
import { Button, Chip, IconButton } from "../ui/button";
import { ConfirmDialog } from "../ui/dialog";
import { EmptyState, Notice } from "../ui/feedback";
import { SearchField, Select } from "../ui/field";
import { ChevronLeftIcon, ChevronRightIcon, MoreIcon } from "../ui/icons";
import { Menu, MenuItem } from "../ui/menu";
import { Stat, StatList } from "../ui/stat";

const EMPTY: SessionsPayload = { sessions: [], total: 0, total_records: 0, total_tokens: 0, total_errors: 0, dates: [], has_legacy: false, has_more: false };
const PAGE_SIZE = 20;
const ROW_GRID = "lg:grid-cols-[minmax(0,1fr)_10rem_8rem_5rem_7rem_2.75rem]";

function isActive(session: SessionSummary): boolean {
  return Boolean(session.live) || session.status === "active";
}

/* Complete is the normal state and stays unmarked; only exceptions are labeled. */
function StatusMark({ session }: { session: SessionSummary }) {
  if (session.status === "error") return <Badge tone="danger">Error</Badge>;
  if (session.status === "empty") return <Badge tone="warning">Empty</Badge>;
  return null;
}

function ConversationRow({ onDelete, onOpen, onToggle, selected, session }: { onDelete: () => void; onOpen: () => void; onToggle: () => void; selected: boolean; session: SessionSummary }) {
  const active = isActive(session);
  const title = session.first_user || "Untitled conversation";
  const turns = session.turn_count ?? session.record_count ?? 0;
  const tokens = session.total_tokens || 0;
  const started = session.started_at || session.updated_at;
  const agent = session.agent || "Unknown";
  return <div className={`group relative grid grid-cols-[minmax(0,1fr)_2.75rem] items-center gap-x-3 gap-y-1 py-3 pl-4 pr-2 transition-colors hover:bg-fill-hover lg:min-h-14 lg:gap-4 lg:pl-5 ${ROW_GRID}`}>
    <div className="flex min-w-0 items-center gap-2.5">
      {/* Above the row's open target, so choosing a conversation to compare never opens it. */}
      <input aria-label={`Compare “${title}” (${agent})`} checked={selected} className="relative z-10 size-4 shrink-0 cursor-pointer accent-(--ink)" onChange={onToggle} type="checkbox"/>
      <StatusDot tone={active ? "success" : "none"}/>
      <button className="min-w-0 truncate text-left text-sm font-medium text-ink after:absolute after:inset-0 after:content-[''] focus-visible:outline-none focus-visible:after:rounded-control focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-(--focus)" onClick={onOpen} title={title} type="button">{title}</button>
      {active ? <span className="sr-only">Active</span> : null}
      <StatusMark session={session}/>
    </div>
    <span className="hidden min-w-0 items-center gap-2 text-sm text-muted lg:flex"><AgentMark label={agent}/><span className="truncate">{agent}</span></span>
    <span className="hidden text-sm text-muted lg:block" title={formatDate(started)}>{formatDay(started)}</span>
    <span className="hidden font-mono text-sm text-muted lg:block">{formatNumber(turns)}</span>
    <span className="hidden font-mono text-sm text-ink lg:block">{tokens ? formatNumber(tokens) : "—"}</span>
    <div className="relative z-10 row-span-2 justify-self-end lg:row-span-1">
      <Menu label={`Actions for ${title}`} trigger={(props) => <IconButton {...props} className="focus-visible:opacity-100 lg:opacity-0 lg:group-hover:opacity-100 lg:aria-expanded:opacity-100" label={`Actions for ${title}`}><MoreIcon/></IconButton>} width={220}>
        {(close) => <>
          <MenuItem onSelect={() => { close(); onOpen(); }}>Open conversation</MenuItem>
          <MenuItem danger disabled={active} onSelect={() => { close(); onDelete(); }}>{active ? "Active conversations can't be deleted" : "Delete conversation…"}</MenuItem>
        </>}
      </Menu>
    </div>
    <p className="col-start-1 flex min-w-0 items-center gap-1.5 pl-[44px] text-xs text-muted lg:hidden">
      <AgentMark label={agent}/><span className="truncate">{agent} · {formatDay(started)} · {tokens ? `${formatCompact(tokens)} tokens` : "no tokens"}</span>
    </p>
  </div>;
}

export function ConversationsView({ onCompare, onOpen }: { onCompare: (ids: string[]) => void; onOpen: (id: string) => void }) {
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
  const [liveState, setLiveState] = useState<LiveState>("connecting");
  // Conversations chosen for comparison, kept across searches and filters.
  const [chosen, setChosen] = useState<string[]>([]);
  const toggleChosen = (id: string) => setChosen((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]));

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

  return (
    <AppShell
      captureIndicator={false}
      menu={(close) => <>
        <MenuItem onSelect={() => { close(); void load(); }}>Refresh conversations</MenuItem>
        <MenuItem danger disabled={!payload.total || loading} onSelect={() => { close(); setDeleteError(""); setDeleteTarget("all"); }}>Clear all conversations…</MenuItem>
      </>}
      meta={<LiveStatus state={liveState}/>}
    >
      <main className="tf-gutter mx-auto w-full max-w-content pb-10 pt-8 sm:pt-12">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="tf-display">Conversations</h1>
            <p className="mt-2 text-sm text-muted">Capture, inspect, and understand what your agents are doing.</p>
          </div>
          <CaptureButton/>
        </div>

        <div className="mt-6 flex flex-wrap items-center gap-x-8 gap-y-3">
          <StatList>
            <Stat label={payload.total === 1 ? "conversation" : "conversations"} value={formatNumber(payload.total)}/>
            <Stat label="turns" value={formatNumber(turnTotal)}/>
            <Stat label="tokens" value={formatCompact(payload.total_tokens)}/>
          </StatList>
          {payload.total_errors ? <Chip onClick={() => setFilter(() => setStatus("error"))} tone="warning">⚠ {formatNumber(payload.total_errors)} {payload.total_errors === 1 ? "issue" : "issues"}</Chip> : null}
        </div>

        <div className="mt-6 flex flex-col gap-2 sm:flex-row">
          <SearchField label="Search conversations" onChange={(value) => setFilter(() => setSearch(value))} placeholder="Search conversations…" value={search}/>
          <div className="grid grid-cols-2 gap-2 sm:flex">
            <Select label="Agent" onChange={(value) => setFilter(() => setAgent(value))} value={agent}>
              <option value="">All agents</option>
              {agents.map((item) => <option key={item.key} value={item.key}>{item.label} ({item.sessions})</option>)}
            </Select>
            <Select label="Status" onChange={(value) => setFilter(() => setStatus(value))} value={status}>
              <option value="">All statuses</option>
              <option value="active">Active</option>
              <option value="complete">Complete</option>
              <option value="empty">Empty</option>
              <option value="error">Error</option>
            </Select>
          </div>
        </div>

        {error ? <div className="mt-4"><Notice tone="danger">{error}</Notice></div> : null}
        {notice ? <div className="mt-4"><Notice onDismiss={() => setNotice("")} tone="success">{notice}</Notice></div> : null}

        {chosen.length ? <div className="mt-4 flex flex-wrap items-center gap-3 rounded-control border border-line bg-panel py-1.5 pl-4 pr-1.5">
          <span className="min-w-0 flex-1 text-sm text-ink">{chosen.length} selected{chosen.length < 2 ? <span className="text-muted"> · choose one more to compare</span> : null}</span>
          <Button compact onClick={() => setChosen([])} variant="ghost">Clear</Button>
          <Button compact disabled={chosen.length < 2} onClick={() => onCompare(chosen)} variant="primary">Compare</Button>
        </div> : null}

        <section aria-label="Conversations" className="mt-6">
          <div className={`tf-eyebrow hidden gap-4 border-b border-line pb-2 pl-5 pr-2 lg:grid ${ROW_GRID}`}>
            <span className="pl-[44px]">Conversation</span><span>Agent</span><span className="text-ink">Started ↓</span><span>Turns</span><span>Tokens</span><span className="sr-only">Actions</span>
          </div>
          <div className="divide-y divide-line border-b border-line">
            {rows.map((session) => <ConversationRow key={session.id} onDelete={() => { setDeleteError(""); setDeleteTarget(session); }} onOpen={() => onOpen(session.id)} onToggle={() => toggleChosen(session.id)} selected={chosen.includes(session.id)} session={session}/>)}
            {!loading && !payload.sessions.length && filtered ? <EmptyState title="No conversations match these filters">Clear the search or choose All agents and All statuses.</EmptyState> : null}
            {!loading && !payload.sessions.length && !filtered ? <EmptyState title="No conversations yet">Use Capture to open an agent through Token Flow. Each conversation it runs appears here as it happens.</EmptyState> : null}
            {loading && !payload.sessions.length ? <EmptyState>Loading conversations…</EmptyState> : null}
          </div>
          {payload.sessions.length ? <div className="mt-4 flex items-center justify-between gap-3 text-xs text-muted">
            <span>Showing {formatNumber(rows.length)} of {formatNumber(payload.total)} {payload.total === 1 ? "conversation" : "conversations"}</span>
            {pageCount > 1 ? <nav aria-label="Pages" className="flex items-center gap-1">
              <IconButton disabled={currentPage === 0} label="Previous page" onClick={() => setPage(currentPage - 1)}><ChevronLeftIcon/></IconButton>
              {Array.from({ length: pageCount }, (_, index) => <button aria-current={index === currentPage ? "page" : undefined} className={`tf-icon-control grid place-items-center rounded-control font-mono text-xs transition-colors ${index === currentPage ? "bg-fill-selected text-ink" : "hover:bg-fill-hover hover:text-ink"}`} key={index} onClick={() => setPage(index)} type="button">{index + 1}</button>)}
              <IconButton disabled={currentPage >= pageCount - 1} label="Next page" onClick={() => setPage(currentPage + 1)}><ChevronRightIcon/></IconButton>
            </nav> : null}
          </div> : null}
        </section>
      </main>
      <ConfirmDialog busy={deleting} busyLabel="Deleting…" confirmLabel="Delete" description={deleteTarget === "all" ? "This permanently deletes every stored conversation that is not currently active. Active conversations are kept." : `This permanently deletes “${deleteTarget?.first_user || "Untitled conversation"}” and its captured records.`} error={deleteError} onCancel={closeDeleteDialog} onConfirm={() => void confirmDelete()} open={deleteTarget !== null} title={deleteTarget === "all" ? "Clear all conversations?" : "Delete this conversation?"}/>
    </AppShell>
  );
}
