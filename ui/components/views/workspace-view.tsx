"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { deleteSession, fetchSessionRecords } from "@/lib/api";
import { useEstimatedTurns } from "@/lib/use-estimated-turns";
import type { SessionRecordsPayload, TokenSelection } from "@/lib/types";
import { AppShell, LiveStatus, type LiveState } from "../app-shell";
import { ConfirmDialog } from "../ui/dialog";
import { EmptyState, Notice } from "../ui/feedback";
import { MenuItem } from "../ui/menu";
import { ConversationOverview } from "../workspace/conversation-overview";
import type { CategoryFocus } from "../workspace/input-units";
import { RequestView, type RequestViewMode } from "../workspace/request-view";
import { TurnFlow } from "../workspace/turn-flow";

export function WorkspaceView({ sessionId, onBack }: { sessionId: string; onBack: () => void }) {
  const [data, setData] = useState<SessionRecordsPayload | null>(null);
  // No selected turn means the conversation overview: opening a conversation starts there.
  const [selectedId, setSelectedId] = useState("");
  // A category chosen in the overview treemap, followed through the flow until cleared.
  const [focusCategory, setFocusCategory] = useState<CategoryFocus | null>(null);
  const [tokenSelection, setTokenSelection] = useState<TokenSelection | null>(null);
  // The inspector is one projection of the selected turn. Keep its view beside
  // the turn selection so changing turns or visiting the overview does not
  // create a second, hidden selection state inside the inspector.
  const [requestView, setRequestView] = useState<RequestViewMode>("timeline");
  const [requestJump, setRequestJump] = useState<(TokenSelection & { nonce: number }) | null>(null);
  const [error, setError] = useState("");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [liveState, setLiveState] = useState<LiveState>("connecting");

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

  const turns = useEstimatedTurns(data?.records);
  const selected = useMemo(() => {
    const index = turns.findIndex((item) => item.id === selectedId);
    return index >= 0 ? index : null;
  }, [selectedId, turns]);
  const turn = selected === null ? undefined : turns[selected];
  const title = data?.session.title || turns.find((item) => item.kind === "user" && item.queryText)?.queryText || data?.session.first_user || "Conversation";
  const selectTurn = useCallback((index: number | null) => {
    const nextId = index === null ? "" : turns[index]?.id || "";
    setSelectedId(nextId);
    // Re-selecting the active turn must not silently break a linked block.
    // A different turn has different block identities, so its block selection
    // starts empty while the chosen view remains the same projection mode.
    if (nextId !== selectedId) setTokenSelection(null);
  }, [selectedId, turns]);
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

  if (error) return <AppShell onBack={onBack} title="Conversation"><main className="tf-gutter mx-auto max-w-3xl py-6"><Notice title="This conversation could not be loaded" tone="danger">{error}</Notice></main></AppShell>;
  if (!data) return <AppShell onBack={onBack} title="Conversation"><main className="grid min-h-[70dvh] place-items-center"><EmptyState>Loading conversation…</EmptyState></main></AppShell>;

  const active = data.session.live || data.session.status === "active";
  const menu = (close: () => void) => <>
    <MenuItem onSelect={() => { close(); window.location.href = `/api/sessions/${encodeURIComponent(sessionId)}/export/compact`; }}>Export conversation</MenuItem>
    <MenuItem danger disabled={active} onSelect={() => { close(); setDeleteOpen(true); }}>{active ? "Active conversations can't be deleted" : "Delete conversation…"}</MenuItem>
  </>;

  return <AppShell menu={menu} meta={<LiveStatus state={liveState}/>} onBack={onBack} title={title}>
    <main className="mx-auto grid w-full min-w-0 max-w-page gap-3 py-3 lg:grid-cols-[minmax(var(--tf-rail-min),var(--tf-rail-max))_minmax(0,1fr)] lg:px-3">
      <TurnFlow focus={turn ? null : focusCategory} onClearSelection={() => { setTokenSelection(null); setFocusCategory(null); }} onSelectNode={selectNode} onSelectTurn={selectTurn} selected={selected} selection={tokenSelection} turns={turns}/>
      {/* On narrow screens the selected turn opens over the flow; closing it returns to the same place. */}
      {/* Opening a turn slides forward from the overview and closing it slides back
          (page side-by-side); on narrow screens the turn rises over the flow instead. */}
      <div className={`t-page-enter ${turn ? "fixed inset-0 z-(--z-sheet) overflow-y-auto bg-canvas p-2 lg:static lg:z-auto lg:overflow-visible lg:bg-transparent lg:p-0" : "min-w-0 px-3 pb-5 lg:px-0"}`} data-overlay={turn ? "true" : undefined} key={turn ? "turn" : "overview"} style={{ "--t-page-dir": turn ? 1 : -1 } as React.CSSProperties}>
        {turn
          ? <RequestView jumpToBlock={requestJump?.turnId === turn.id ? requestJump : null} onNavigate={selectTurn} onSelectToken={setTokenSelection} onViewChange={setRequestView} selection={tokenSelection} turn={turn} turns={turns} view={requestView}/>
          : <section className="tf-panel"><ConversationOverview focus={focusCategory} onFocus={setFocusCategory} onSelectNode={selectNode} onSelectTurn={selectTurn} session={data.session} turns={turns}/></section>}
      </div>
    </main>
    <ConfirmDialog busy={deleting} busyLabel="Deleting…" confirmLabel="Delete" description={`This permanently deletes “${title}” and its captured records.`} error={deleteError} onCancel={closeDeleteDialog} onConfirm={() => void confirmDelete()} open={deleteOpen} title="Delete this conversation?"/>
  </AppShell>;
}
