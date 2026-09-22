"use client";

import type { ReactNode } from "react";
import { ArrowLeftIcon, ClockIcon, MoonIcon } from "./icons";

interface AppShellProps {
  children: ReactNode;
  onBack?: () => void;
  title?: string;
  meta?: ReactNode;
}

export function AppShell({ children, onBack, title, meta }: AppShellProps) {
  function toggleTheme() {
    const root = document.documentElement;
    const next = root.dataset.theme === "dark" ? "light" : "dark";
    root.dataset.theme = next;
    localStorage.setItem("token-flow-theme", next);
  }

  return (
    <div className="min-h-dvh min-w-0 overflow-x-hidden bg-canvas text-ink">
      <header className="sticky top-0 z-50 border-b border-line bg-panel/95 backdrop-blur">
        <div className="mx-auto flex min-h-14 max-w-[1600px] items-center gap-2 px-3 sm:px-5">
          {onBack ? (
            <button aria-label="Back to conversations" className="grid size-11 place-items-center rounded-xl hover:bg-canvas lg:hidden" onClick={onBack}>
              <ArrowLeftIcon />
            </button>
          ) : null}
          <button className="flex min-h-11 items-center gap-2 rounded-xl px-1" onClick={onBack} type="button">
            <ClockIcon className="size-6" />
            <span className="text-[15px] font-semibold tracking-[-0.02em]">Token Flow</span>
            <span className="rounded-md border border-line bg-canvas px-1.5 py-0.5 font-mono text-[10px] text-muted">v0.2</span>
          </button>
          {title ? (
            <>
              <span className="mx-2 hidden h-6 w-px bg-line sm:block" />
              <span className="hidden max-w-[26rem] truncate text-sm font-medium text-muted sm:block">{title}</span>
            </>
          ) : null}
          <div className="ml-auto flex min-w-0 items-center gap-2">
            {meta ? <div className="hidden min-w-0 items-center gap-4 text-xs text-muted lg:flex">{meta}</div> : null}
            <button aria-label="Toggle appearance" className="grid size-11 place-items-center rounded-xl border border-line bg-panel hover:bg-canvas" onClick={toggleTheme} type="button">
              <MoonIcon className="size-[18px]" />
            </button>
          </div>
        </div>
      </header>
      {children}
    </div>
  );
}
