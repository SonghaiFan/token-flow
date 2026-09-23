"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { deleteSession, fetchSessionRecords } from "@/lib/api";
import { formatCompact } from "@/lib/format";
import { buildTurns } from "@/lib/token-model";
import type { SessionRecordsPayload, TokenSelection } from "@/lib/types";
import { AppShell } from "../app-shell";
import { DeleteDialog } from "../delete-dialog";
import { DownloadIcon, TrashIcon } from "../icons";
import { ConversationOverview } from "../workspace/conversation-overview";
import type { CategoryFocus } from "../workspace/input-units";
import { RequestView } from "../workspace/request-view";
import { TurnFlow } from "../workspace/turn-flow";

export function WorkspaceView({ sessionId, onBack }: { sessionId: string; onBack: () => void }) {
  const [data, setData] = useState<SessionRecordsPayload | null>(null);
  // No selected turn means the conversation overview: opening a conversation starts there.
  const [selectedId, setSelectedId] = useState("");
  // A category chosen in the overview treemap, followed through the flow until cleared.
  const [focusCategory, setFocusCategory] = useState<CategoryFocus | null>(null);
  const [tokenSelection, setTokenSelection] = useState<TokenSelection | null>(null);
  const [requestJump, setRequestJump] = useState<(TokenSelection & { nonce: number }) | null>(null);
  const [error, setError] = useState("");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [liveState, setLiveState] = useState<"connecting" | "watching" | "reconnecting" | "stale">("connecting");

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    let loaded = false;
    let connected = false;
    let requestVersion = 0;
    let refreshTimer = 0;

    async function load() {
      const version = ++requestVersion;
      try {
        const next = await fetchSessionRecords(sessionId, controller.signal);
        if (!active || version !== requestVersion) return;
        loaded = true;
        setData(next);
        setError("");
        if (connected) setLiveState("watching");
      } catch (reason) {
        if (!active || (reason as Error).name === "AbortError" || version !== requestVersion) return;
        if (loaded) setLiveState("stale");
        else setError((reason as Error).message || "Unable to load conversation");
      }
    }

    function scheduleRefresh(event: Event) {
      const message = event as MessageEvent<string>;
      try {
        const payload = JSON.parse(message.data) as { session_id?: string };
        if (payload.session_id && payload.session_id !== sessionId) return;
      } catch {
        // Ignore an invalid notification and keep the last trustworthy data.
      }
      window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => void load(), 120);
    }

    void load();
    const events = new EventSource("/dashboard/events");
    events.onopen = () => {
      connected = true;
      setLiveState("watching");
    };
    events.onerror = () => {
      connected = false;
      setLiveState("reconnecting");
    };
    events.addEventListener("record", scheduleRefresh);
    events.addEventListener("refresh", scheduleRefresh);
    return () => {
      active = false;
      controller.abort();
      events.close();
      window.clearTimeout(refreshTimer);
    };
  }, [sessionId]);

  const turns = useMemo(() => buildTurns(data?.records || []), [data?.records]);
  const selected = useMemo(() => {
    const index = turns.findIndex((item) => item.id === selectedId);
    return index >= 0 ? index : null;
  }, [selectedId, turns]);
  const turn = selected === null ? undefined : turns[selected];
  const title = data?.session.first_user || "Conversation";
  const selectTurn = useCallback((index: number | null) => {
    setSelectedId(index === null ? "" : turns[index]?.id || "");
    setTokenSelection(null);
  }, [turns]);
  // A Sankey node opens its turn and jumps to that layer, or to that category's blocks.
  const selectNode = useCallback((index: number, selection: TokenSelection) => {
    if (!turns[index]) return;
    setSelectedId(turns[index].id);
    setTokenSelection(selection);
    setRequestJump({ ...selection, nonce: Date.now() });
  }, [turns]);
  const closeDeleteDialog = useCallback(() => {
    if (deleting) return;
    setDeleteOpen(false);
    setDeleteError("");
  }, [deleting]);
  const confirmDelete = useCallback(async () => {
    setDeleting(true);
    setDeleteError("");
    try {
      await deleteSession(sessionId);
      onBack();
    } catch (reason) {
      setDeleteError((reason as Error).message || "Unable to delete conversation");
      setDeleting(false);
    }
  }, [onBack, sessionId]);

  if (error) return <AppShell onBack={onBack} title="Conversation"><main className="mx-auto max-w-3xl p-6"><div className="rounded-2xl border border-red-200 bg-red-50 p-5 text-red-700">{error}</div></main></AppShell>;
  if (!data) return <AppShell onBack={onBack} title="Conversation"><main className="grid min-h-[70dvh] place-items-center text-sm text-muted">Loading conversation…</main></AppShell>;

  const liveLabel = liveState === "watching" ? "Watching" : liveState === "stale" ? "Updates paused" : liveState === "reconnecting" ? "Reconnecting" : "Connecting";
  const active = data.session.live || data.session.status === "active";
  const meta = <><span>{turns.length} turns</span><span>{formatCompact(data.session.total_tokens || turns.reduce((sum, item) => sum + item.input + item.output, 0))} tokens</span><span className={liveState === "watching" ? "text-success" : "text-warning"}>● {liveLabel}</span><a className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-line px-3 text-ink hover:bg-canvas" href={`/api/sessions/${encodeURIComponent(sessionId)}/export/compact`}><DownloadIcon className="size-4"/> Export</a><button className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-red-200 px-3 text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-red-900 dark:text-red-300 dark:hover:bg-red-950" disabled={active} onClick={() => setDeleteOpen(true)} title={active ? "Active conversations cannot be deleted" : "Delete conversation"} type="button"><TrashIcon className="size-4"/> Delete</button></>;

  return <AppShell meta={meta} onBack={onBack} title={title}>
    <main className="mx-auto grid min-w-0 w-full max-w-[1600px] gap-3 py-3 lg:grid-cols-[minmax(24rem,32rem)_minmax(0,1fr)] lg:px-4">
      <TurnFlow focus={turn ? null : focusCategory} onSelectNode={selectNode} onSelectTurn={selectTurn} selected={selected} selection={tokenSelection} turns={turns}/>
      {/* On narrow screens the selected turn opens over the flow; closing it returns to the same place. */}
      {/* Opening a turn slides forward from the overview and closing it slides back
          (page side-by-side); on narrow screens the turn rises over the flow instead. */}
      <div className={`t-page-enter ${turn ? "fixed inset-0 z-50 overflow-y-auto bg-canvas p-2 lg:static lg:z-auto lg:overflow-visible lg:bg-transparent lg:p-0" : "min-w-0 px-3 pb-5 lg:px-0"}`} data-overlay={turn ? "true" : undefined} key={turn ? "turn" : "overview"} style={{ "--t-page-dir": turn ? 1 : -1 } as React.CSSProperties}>
        {turn
          ? <RequestView jumpToBlock={requestJump?.turnId === turn.id ? requestJump : null} onNavigate={selectTurn} onSelectToken={setTokenSelection} selection={tokenSelection} turn={turn} turns={turns}/>
          : <section className="rounded-2xl border border-line bg-panel shadow-sm"><ConversationOverview focus={focusCategory} onFocus={setFocusCategory} onSelectNode={selectNode} onSelectTurn={selectTurn} session={data.session} turns={turns}/></section>}
      </div>
    </main>
    <DeleteDialog busy={deleting} description={`This permanently deletes “${title}” and its captured records.`} error={deleteError} onCancel={closeDeleteDialog} onConfirm={() => void confirmDelete()} open={deleteOpen} title="Delete this conversation?"/>
  </AppShell>;
}
