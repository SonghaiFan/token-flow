"use client";

import { useState, type ReactNode } from "react";
import { CaptureIndicator } from "./capture-menu";
import { DatabaseSettingsDialog } from "./database-settings";
import { Badge, StatusDot } from "./ui/badge";
import { IconButton } from "./ui/button";
import { ArrowLeftIcon, MoonIcon, MoreIcon } from "./ui/icons";
import { Menu, MenuItem, MenuSeparator } from "./ui/menu";

export type LiveState = "connecting" | "watching" | "reconnecting" | "stale";

const LIVE_LABELS: Record<LiveState, string> = {
  connecting: "Connecting",
  reconnecting: "Reconnecting",
  stale: "Updates paused",
  watching: "Watching",
};

/* Whether the page is receiving new captures. Shown in the toolbar on every page. */
export function LiveStatus({ state }: { state: LiveState }) {
  return <span className="inline-flex items-center gap-2"><StatusDot tone={state === "watching" ? "success" : "warning"}/>{LIVE_LABELS[state]}</span>;
}

interface AppShellProps {
  children: ReactNode;
  onBack?: () => void;
  title?: string;
  meta?: ReactNode;
  /* Low-frequency service actions, shown in the toolbar's ••• menu. */
  menu?: (close: () => void) => ReactNode;
  /* The running-capture Stop indicator; pages with their own capture control hide it. */
  captureIndicator?: boolean;
}

export function AppShell({ captureIndicator = true, children, onBack, title, meta, menu }: AppShellProps) {
  const [databaseOpen, setDatabaseOpen] = useState(false);
  function toggleTheme() {
    const root = document.documentElement;
    const dark = root.dataset.theme ? root.dataset.theme === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches;
    const next = dark ? "light" : "dark";
    root.dataset.theme = next;
    localStorage.setItem("token-flow-theme", next);
  }

  return (
    <div className="min-h-dvh min-w-0 overflow-x-clip bg-canvas text-ink">
      <header className="sticky top-0 z-(--z-toolbar) border-b border-line bg-panel/95 backdrop-blur">
        <div className="tf-gutter mx-auto flex h-(--tf-toolbar-height) max-w-page items-center gap-2">
          {onBack ? <IconButton className="-ml-2 lg:hidden" label="Back to conversations" onClick={onBack}><ArrowLeftIcon/></IconButton> : null}
          <button className={`tf-control flex items-center gap-2 rounded-control px-1 ${onBack ? "lg:-ml-1" : "-ml-1"}`} onClick={onBack} type="button">
            <span aria-hidden="true" className="grid size-7 shrink-0 place-items-center rounded-inset bg-white p-0.5">
              <img alt="" className="size-full object-contain" src="/assets/token-flow-logo.svg" />
            </span>
            <span className="text-base font-semibold tracking-[-0.02em]">Token Flow</span>
            <span className="hidden sm:inline-flex"><Badge mono>v0.2</Badge></span>
          </button>
          {title ? (
            <>
              <span aria-hidden="true" className="mx-2 hidden h-6 w-px bg-line sm:block" />
              <span className="hidden max-w-[26rem] truncate text-sm font-medium text-muted sm:block">{title}</span>
            </>
          ) : null}
          <div className="-mr-2 ml-auto flex min-w-0 items-center gap-1">
            {meta ? <div className="mr-2 hidden min-w-0 items-center gap-4 text-xs text-muted lg:flex">{meta}</div> : null}
            {captureIndicator ? <CaptureIndicator /> : null}
            <IconButton label="Toggle appearance" onClick={toggleTheme}><MoonIcon/></IconButton>
            <Menu label="More actions" trigger={(props) => <IconButton {...props} label="More actions"><MoreIcon/></IconButton>} width={240}>
              {(close) => <>
                {menu ? <>{menu(close)}<MenuSeparator/></> : null}
                <MenuItem onSelect={() => { close(); setDatabaseOpen(true); }}>Database…</MenuItem>
              </>}
            </Menu>
          </div>
        </div>
      </header>
      {children}
      {databaseOpen ? <DatabaseSettingsDialog onClose={() => setDatabaseOpen(false)}/> : null}
    </div>
  );
}
