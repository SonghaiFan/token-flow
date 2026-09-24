"use client";

import type { ReactNode } from "react";
import { CaptureIndicator } from "./capture-menu";
import { ArrowLeftIcon, MoonIcon, MoreIcon } from "./icons";
import { Menu } from "./menu";

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
  function toggleTheme() {
    const root = document.documentElement;
    const next = root.dataset.theme === "dark" ? "light" : "dark";
    root.dataset.theme = next;
    localStorage.setItem("token-flow-theme", next);
  }

  return (
    <div className="min-h-dvh min-w-0 overflow-x-clip bg-canvas text-ink">
      <header className="sticky top-0 z-50 border-b border-line bg-panel/95 backdrop-blur">
        <div className="mx-auto flex min-h-14 max-w-[1600px] items-center gap-2 px-3 sm:px-5">
          {onBack ? (
            <button aria-label="Back to conversations" className="tf-icon-control grid place-items-center rounded-control hover:bg-canvas lg:hidden" onClick={onBack}>
              <ArrowLeftIcon />
            </button>
          ) : null}
          <button className="tf-control flex items-center gap-2 rounded-control px-1" onClick={onBack} type="button">
            <span aria-hidden="true" className="grid size-7 shrink-0 place-items-center rounded-lg bg-white p-0.5">
              <img alt="" className="size-full object-contain" src="/assets/token-flow-logo.svg" />
            </span>
            <span className="text-base font-semibold tracking-[-0.02em]">Token Flow</span>
            <span className="hidden rounded-md border border-line bg-canvas px-1.5 py-0.5 font-mono text-xs text-muted sm:inline">v0.2</span>
          </button>
          {title ? (
            <>
              <span className="mx-2 hidden h-6 w-px bg-line sm:block" />
              <span className="hidden max-w-[26rem] truncate text-sm font-medium text-muted sm:block">{title}</span>
            </>
          ) : null}
          <div className="ml-auto flex min-w-0 items-center gap-2">
            {meta ? <div className="hidden min-w-0 items-center gap-4 text-xs text-muted lg:flex">{meta}</div> : null}
            {captureIndicator ? <CaptureIndicator /> : null}
            <button aria-label="Toggle appearance" className="tf-icon-control grid place-items-center rounded-control text-muted hover:bg-canvas hover:text-ink" onClick={toggleTheme} type="button">
              <MoonIcon className="size-[18px]" />
            </button>
            {menu ? <Menu label="More actions" trigger={(props) => <button {...props} aria-label="More actions" className="tf-icon-control grid place-items-center rounded-control text-muted hover:bg-canvas hover:text-ink" type="button"><MoreIcon className="size-5"/></button>} width={240}>{menu}</Menu> : null}
          </div>
        </div>
      </header>
      {children}
    </div>
  );
}
