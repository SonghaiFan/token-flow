"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchCaptureStatus, startCodexCapture, stopCodexCapture } from "@/lib/api";
import type { CaptureStatus } from "@/lib/types";

const IDLE: CaptureStatus = { available: false, client: "codexapp", state: "idle" };

export function CaptureControl() {
  const [status, setStatus] = useState<CaptureStatus>(IDLE);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const next = await fetchCaptureStatus(signal);
      setStatus(next);
      setError(next.error || "");
    } catch (reason) {
      if ((reason as Error).name !== "AbortError") setError((reason as Error).message || "Unable to read capture status");
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const initial = window.setTimeout(() => void load(controller.signal), 0);
    const timer = window.setInterval(() => void load(), 1500);
    return () => { controller.abort(); window.clearTimeout(initial); window.clearInterval(timer); };
  }, [load]);

  const active = status.state === "capturing" || status.state === "starting" || status.state === "stopping";
  const label = status.state === "starting" ? "Starting" : status.state === "stopping" ? "Stopping" : status.state === "capturing" ? "Stop capture" : status.state === "error" ? "Retry capture" : "Capture Codex";
  const compactLabel = status.state === "capturing" ? "Stop" : status.state === "starting" ? "Starting" : status.state === "stopping" ? "Stopping" : status.state === "error" ? "Retry" : "Capture";

  async function toggle() {
    setBusy(true);
    setError("");
    try {
      const next = active ? await stopCodexCapture() : await startCodexCapture();
      setStatus(next);
      setError(next.error || "");
    } catch (reason) {
      setError((reason as Error).message || "Unable to change capture state");
    } finally {
      setBusy(false);
    }
  }

  if (!status.available && !error) return null;

  return (
    <div className="relative">
      <button
        aria-label={label}
        aria-pressed={active}
        className={`tf-control inline-flex items-center gap-2 whitespace-nowrap rounded-control border px-3 text-sm font-medium transition-colors active:translate-y-px disabled:cursor-wait disabled:opacity-60 ${active ? "border-emerald-300 bg-emerald-50 text-emerald-800 hover:bg-emerald-100 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-300" : "border-line bg-panel text-ink hover:bg-canvas"}`}
        disabled={busy || status.state === "starting" || status.state === "stopping"}
        onClick={() => void toggle()}
        title={status.state === "capturing" ? "Stop recording Codex App conversations" : "Open Codex App and record new conversations"}
        type="button"
      >
        <span aria-hidden="true" className={`size-2 rounded-full ${active ? "bg-emerald-600" : status.state === "error" ? "bg-danger" : "bg-muted"}`} />
        <span className="sm:hidden">{busy ? "Working" : compactLabel}</span>
        <span className="hidden sm:inline">{busy ? "Working" : label}</span>
      </button>
      {error ? <div className="absolute right-0 top-[calc(100%+0.5rem)] z-[60] w-72 rounded-control border border-red-200 bg-panel p-3 text-xs leading-5 text-red-700 shadow-lg dark:border-red-900 dark:text-red-300" role="alert">{error}</div> : null}
    </div>
  );
}
