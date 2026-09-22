"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchSessionRecords } from "@/lib/api";
import { formatCompact, formatNumber } from "@/lib/format";
import { buildTurns } from "@/lib/token-model";
import type { SessionRecordsPayload, TokenSelection, WorkspaceLens } from "@/lib/types";
import { AppShell } from "../app-shell";
import { DownloadIcon } from "../icons";
import { SankeyChart } from "../charts/sankey-chart";
import { TreemapChart } from "../charts/treemap-chart";
import { MetricStrip } from "../workspace/metric-strip";
import { RequestView } from "../workspace/request-view";
import { TurnNavigator } from "../workspace/turn-navigator";

export function WorkspaceView({ sessionId, onBack }: { sessionId: string; onBack: () => void }) {
  const [data, setData] = useState<SessionRecordsPayload | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [lens, setLens] = useState<WorkspaceLens>("composition");
  const [tokenSelection, setTokenSelection] = useState<TokenSelection | null>(null);
  const [requestJump, setRequestJump] = useState<(TokenSelection & { nonce: number }) | null>(null);
  const [error, setError] = useState("");
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
    return index >= 0 ? index : 0;
  }, [selectedId, turns]);
  const turn = turns[selected] || turns[0];
  const title = data?.session.first_user || "Conversation";
  const selectTurn = useCallback((index: number) => {
    const id = turns[index]?.id;
    if (!id) return;
    setSelectedId(id);
    setTokenSelection(null);
  }, [turns]);
  const openSelectionInRequest = useCallback((selection: TokenSelection) => {
    setSelectedId(selection.turnId);
    setTokenSelection(selection);
    setRequestJump({ ...selection, nonce: Date.now() });
    setLens("request");
  }, []);

  if (error) return <AppShell onBack={onBack} title="Conversation"><main className="mx-auto max-w-3xl p-6"><div className="rounded-2xl border border-red-200 bg-red-50 p-5 text-red-700">{error}</div></main></AppShell>;
  if (!data || !turn) return <AppShell onBack={onBack} title="Conversation"><main className="grid min-h-[70dvh] place-items-center text-sm text-muted">Loading conversation…</main></AppShell>;

  const liveLabel = liveState === "watching" ? "Watching" : liveState === "stale" ? "Updates paused" : liveState === "reconnecting" ? "Reconnecting" : "Connecting";
  const meta = <><span>{turns.length} turns</span><span>{formatCompact(data.session.total_tokens || turns.reduce((sum, item) => sum + item.input + item.output, 0))} tokens</span><span className={liveState === "watching" ? "text-success" : "text-warning"}>● {liveLabel}</span><a className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-line px-3 text-ink hover:bg-canvas" href={`/api/sessions/${encodeURIComponent(sessionId)}/export/compact`}><DownloadIcon className="size-4"/> Export</a></>;

  return <AppShell meta={meta} onBack={onBack} title={title}>
    <nav aria-label="Analysis view" className="sticky top-14 z-40 border-b border-line bg-panel/95 px-3 py-1.5 backdrop-blur sm:px-5">
      <div className="mx-auto grid max-w-xl grid-cols-3 rounded-xl bg-canvas p-1 text-xs font-semibold">
        {(["composition", "flow", "request"] as const).map((item) => <button aria-current={lens === item ? "page" : undefined} className={`min-h-10 rounded-lg px-2 transition ${lens === item ? "bg-ink text-panel shadow-sm" : "text-muted hover:text-ink"}`} key={item} onClick={() => setLens(item)} type="button">{item === "composition" ? "Composition" : item === "flow" ? "Token flow" : "Request"}</button>)}
      </div>
    </nav>

    <main className="mx-auto grid min-w-0 w-full max-w-[1600px] gap-3 py-3 lg:grid-cols-[252px_minmax(0,1fr)] lg:px-4">
      <TurnNavigator onSelect={selectTurn} selected={selected} turns={turns}/>
      <div className="min-w-0 space-y-3 px-3 lg:px-0">
        <MetricStrip previous={turns[selected - 1]} turn={turn}/>
        {lens === "composition" ? <TreemapChart key={turn.id} onOpenRequest={openSelectionInRequest} onSelectToken={setTokenSelection} selection={tokenSelection} turn={turn}/> : null}
        {lens === "flow" ? <SankeyChart onOpenRequest={openSelectionInRequest} onSelectToken={setTokenSelection} onSelectTurn={selectTurn} selected={selected} selection={tokenSelection} turns={turns}/> : null}
        {lens === "request" ? <RequestView jumpToBlock={requestJump?.turnId === turn.id ? requestJump : null} onSelectToken={setTokenSelection} selection={tokenSelection} turn={turn} turns={turns}/> : null}
        <div className="flex flex-wrap items-center justify-between gap-3 px-1 pb-5 text-[11px] text-muted"><span>{data.session.agent || "Unknown agent"} · {turn.model}</span><span>{formatNumber(turn.input)} input · {formatNumber(turn.output)} output</span></div>
      </div>
    </main>
  </AppShell>;
}
