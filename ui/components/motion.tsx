"use client";

import { useEffect, useState } from "react";

/* Read a duration token (for example --acc-collapse) so JS timing stays in sync with
   the CSS recipe. Falls back when the token is missing or motion is reduced. */
export function motionMs(name: string, fallback: number): number {
  if (typeof window === "undefined") return fallback;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return 0;
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const value = parseFloat(raw);
  if (!Number.isFinite(value)) return fallback;
  return raw.endsWith("ms") ? value : value * 1000;
}

/* Accordion expand state: the body mounts closed, then opens on the next frames so the
   grid-rows tween runs; after collapsing it unmounts, so long content does not linger.
   A programmatic open (defaultOpen turning true, e.g. from a selection) opens at once,
   so anything scrolling to the content lands on its final position. */
export function useAccordion(defaultOpen: boolean, resetKey?: string) {
  const [open, setOpen] = useState(defaultOpen);
  const [mounted, setMounted] = useState(defaultOpen);
  const [requested, setRequested] = useState(defaultOpen);
  const [previousKey, setPreviousKey] = useState(resetKey);
  if (previousKey !== resetKey) {
    setPreviousKey(resetKey);
    setRequested(defaultOpen);
    setOpen(defaultOpen);
    setMounted(defaultOpen);
  }
  if (defaultOpen !== requested) {
    setRequested(defaultOpen);
    if (defaultOpen) {
      setMounted(true);
      setOpen(true);
    }
  }
  useEffect(() => {
    if (open || !mounted) return;
    const timer = window.setTimeout(() => setMounted(false), motionMs("--acc-collapse", 250));
    return () => window.clearTimeout(timer);
  }, [mounted, open]);
  const toggle = () => {
    if (open) {
      setOpen(false);
      return;
    }
    setMounted(true);
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => setOpen(true)));
  };
  return { mounted, open, toggle };
}

/* Keyboard activation for a header that is a role="button" region (it may contain
   its own buttons, so it cannot be a <button>). Inner controls keep their own keys. */
export function activateOnKey(event: React.KeyboardEvent<Element>, action: () => void) {
  if (event.target !== event.currentTarget) return;
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    action();
  }
}
