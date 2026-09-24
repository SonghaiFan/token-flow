"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

interface TriggerProps {
  "aria-expanded": boolean;
  "aria-haspopup": "menu";
  onClick: () => void;
  ref: (element: HTMLButtonElement | null) => void;
}

/* A popover menu anchored to its trigger. It renders into the page body so tables
   with clipped overflow and the blurred toolbar never cut it off, opens below the
   trigger (above when there is no room), and closes on outside click, Escape,
   scroll, or resize. */
export function Menu({ children, label, trigger, width = 240 }: {
  children: (close: () => void) => ReactNode;
  label: string;
  trigger: (props: TriggerProps) => ReactNode;
  width?: number;
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ left: number; top?: number; bottom?: number } | null>(null);
  const [triggerElement, setTriggerElement] = useState<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const close = useCallback(() => setOpen(false), []);

  const toggle = () => {
    if (open || !triggerElement) {
      setOpen(false);
      return;
    }
    const rect = triggerElement.getBoundingClientRect();
    const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8));
    const below = window.innerHeight - rect.bottom;
    setPosition(below < 280 && rect.top > below ? { left, bottom: window.innerHeight - rect.top + 6 } : { left, top: rect.bottom + 6 });
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!panelRef.current?.contains(target) && !triggerElement?.contains(target)) close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        close();
        triggerElement?.focus();
      }
    };
    const onScroll = (event: Event) => {
      if (!panelRef.current?.contains(event.target as Node)) close();
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", close);
    };
  }, [close, open, triggerElement]);

  useEffect(() => {
    if (open && position) panelRef.current?.querySelector<HTMLElement>("button:not(:disabled), a")?.focus();
  }, [open, position]);

  return <>
    {trigger({ "aria-expanded": open, "aria-haspopup": "menu", onClick: toggle, ref: setTriggerElement })}
    {open && position ? createPortal(<div
      aria-label={label}
      className="fixed z-(--z-popover) max-h-[min(70dvh,32rem)] overflow-y-auto rounded-control border border-line bg-panel p-1 shadow-overlay"
      ref={panelRef}
      role="menu"
      style={{ ...position, width }}
    >{children(close)}</div>, document.body) : null}
  </>;
}

export function MenuItem({ children, danger = false, disabled = false, onSelect }: { children: ReactNode; danger?: boolean; disabled?: boolean; onSelect: () => void }) {
  return <button
    className={`tf-focus-inset flex min-h-11 w-full items-center gap-3 rounded-inset px-2.5 text-left text-sm disabled:cursor-not-allowed disabled:opacity-(--tf-opacity-disabled) ${danger ? "text-danger-ink hover:bg-danger-soft" : "text-ink hover:bg-fill-hover"}`}
    disabled={disabled}
    onClick={onSelect}
    role="menuitem"
    type="button"
  >{children}</button>;
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <p className="px-2.5 pb-1 pt-2 text-xs font-medium text-muted">{children}</p>;
}

export function MenuSeparator() {
  return <hr className="-mx-1 my-1 border-line"/>;
}
