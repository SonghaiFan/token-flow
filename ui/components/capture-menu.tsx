"use client";

import { useState } from "react";
import { useCapture } from "@/lib/capture-store";
import type { CaptureClient } from "@/lib/types";
import { AgentMark } from "./agent-mark";
import { StatusDot } from "./ui/badge";
import { Button } from "./ui/button";
import { ChevronRightIcon, PlusIcon } from "./ui/icons";
import { Menu, MenuItem, MenuLabel, MenuSeparator } from "./ui/menu";

function since(value: string | null | undefined): string {
  const started = value ? Date.parse(value) : NaN;
  if (!Number.isFinite(started)) return "";
  const seconds = Math.max(0, Math.round((Date.now() - started) / 1000));
  if (seconds < 60) return "started just now";
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `started ${minutes} min ago` : `started ${Math.round(minutes / 60)} h ago`;
}

function missingNote(client: CaptureClient): string {
  if (client.reason === "platform") return "Needs macOS";
  return client.command ? `${client.command} not found` : "App not found";
}

/* The dashboard's one entry for starting a capture. Installed agents are listed
   in its menu; supported agents that are not installed stay behind More agents. */
export function CaptureButton() {
  const capture = useCapture();
  const [showMore, setShowMore] = useState(false);
  const { status } = capture;
  const clients = status.clients || [];
  if (!status.enabled && !clients.length) return null;

  const ready = clients.filter((client) => client.available);
  const missing = clients.filter((client) => !client.available);
  const where = capture.client?.terminal ? "Running in a Terminal window" : "Running in the desktop app";

  return <div className="relative shrink-0">
    <Menu label="Capture with" trigger={(props) => <Button {...props} variant={capture.active ? "live" : "primary"}>
      {capture.active ? <StatusDot tone="success"/> : <PlusIcon className="size-4"/>}
      {capture.active ? `Capturing ${capture.clientLabel}` : "Capture"}
    </Button>} width={280}>
      {(close) => <>
        {capture.active ? <>
          <div className="flex items-center gap-2.5 px-2.5 pb-1 pt-2">
            <AgentMark label={capture.clientLabel}/>
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">Capturing {capture.clientLabel}</p>
              <p className="truncate text-xs text-muted">{[where, status.state === "capturing" ? since(status.started_at) : ""].filter(Boolean).join(" · ")}</p>
            </div>
          </div>
          <MenuItem danger disabled={capture.busy || status.state !== "capturing"} onSelect={() => { close(); void capture.stop(); }}>Stop capture</MenuItem>
          <MenuSeparator/>
        </> : null}
        <MenuLabel>Capture with</MenuLabel>
        {ready.map((client) => <MenuItem disabled={capture.busy || capture.active} key={client.id} onSelect={() => { close(); void capture.start(client.id); }}>
          <AgentMark label={client.label}/>
          <span className="min-w-0 flex-1 truncate">{client.label}</span>
          <span className="text-xs text-muted">{client.terminal ? "Terminal" : "App"}</span>
        </MenuItem>)}
        {!ready.length ? <p className="px-2.5 py-2 text-xs text-muted">No supported agent was found on this computer.</p> : null}
        {missing.length ? <>
          <MenuSeparator/>
          <MenuItem onSelect={() => setShowMore((open) => !open)}>
            <span className="flex-1 text-muted">More agents…</span>
            <ChevronRightIcon className={`size-4 text-muted transition-transform ${showMore ? "rotate-90" : ""}`}/>
          </MenuItem>
          {showMore ? <ul className="pb-1">{missing.map((client) => <li className="flex min-h-11 items-center gap-3 px-2.5" key={client.id}>
            <span className="opacity-50"><AgentMark label={client.label}/></span>
            <span className="min-w-0 flex-1"><span className="block truncate text-sm">{client.label}</span><span className="block truncate font-mono text-xs text-muted">{missingNote(client)}</span></span>
            {client.install_url && client.reason !== "platform" ? <a className="shrink-0 rounded-tag px-1 text-xs text-muted underline decoration-line underline-offset-4 hover:text-ink" href={client.install_url} rel="noreferrer" target="_blank">Install ↗</a> : null}
          </li>)}</ul> : null}
        </> : null}
        {status.cwd && ready.some((client) => client.terminal) ? <p className="-mx-1 border-t border-line px-3.5 pb-1 pt-2 text-xs text-muted">Terminal agents start in <code className="break-all font-mono">{status.cwd}</code></p> : null}
      </>}
    </Menu>
    {capture.error ? <p className="absolute right-0 top-[calc(100%+0.5rem)] z-(--z-popover) w-72 rounded-control border border-danger-line bg-panel p-3 text-xs text-danger-ink shadow-overlay" role="alert">{capture.error}</p> : null}
  </div>;
}

/* Toolbar indicator while a capture runs, so it can be stopped from a conversation. */
export function CaptureIndicator() {
  const capture = useCapture();
  if (!capture.active) return null;
  return <Button
    aria-label={`Stop ${capture.clientLabel} capture`}
    compact
    disabled={capture.busy || capture.status.state !== "capturing"}
    onClick={() => void capture.stop()}
    title={`Stop recording ${capture.clientLabel} conversations`}
    variant="live"
  >
    <StatusDot tone="success"/>
    <span className="hidden sm:inline">Capturing {capture.clientLabel} · Stop</span>
    <span className="sm:hidden">Stop</span>
  </Button>;
}
