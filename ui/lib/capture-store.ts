"use client";

import { useSyncExternalStore } from "react";
import { fetchCaptureStatus, startCapture, stopCapture } from "./api";
import type { CaptureClient, CaptureStatus } from "./types";

/* One shared view of the dashboard's capture process. The dashboard's Capture
   panel and the toolbar's active-capture indicator read the same state, and it
   is polled once however many components use it. */

export interface CaptureSnapshot {
  status: CaptureStatus;
  error: string;
  busy: boolean;
}

const IDLE: CaptureStatus = { available: false, client: "codexapp", state: "idle" };
const POLL_MS = 1500;

let snapshot: CaptureSnapshot = { status: IDLE, error: "", busy: false };
const listeners = new Set<() => void>();
let timer = 0;

function update(next: Partial<CaptureSnapshot>) {
  snapshot = { ...snapshot, ...next };
  for (const listener of listeners) listener();
}

async function poll() {
  try {
    const status = await fetchCaptureStatus();
    update({ status, error: status.error || "" });
  } catch (reason) {
    update({ error: (reason as Error).message || "Unable to read capture status" });
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    void poll();
    timer = window.setInterval(() => void poll(), POLL_MS);
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) window.clearInterval(timer);
  };
}

async function run(action: () => Promise<CaptureStatus>) {
  update({ busy: true, error: "" });
  try {
    const status = await action();
    update({ status, error: status.error || "" });
  } catch (reason) {
    update({ error: (reason as Error).message || "Unable to change capture state" });
  } finally {
    update({ busy: false });
  }
}

export function useCapture() {
  const current = useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
  const { status } = current;
  const active = status.state === "capturing" || status.state === "starting" || status.state === "stopping";
  const client: CaptureClient | undefined = status.clients?.find((item) => item.id === status.client);
  return {
    ...current,
    active,
    client,
    clientLabel: client?.label || "Agent",
    start: (id: string, workingDirectory?: string) => run(() => startCapture(id, workingDirectory)),
    stop: () => run(stopCapture),
  };
}
