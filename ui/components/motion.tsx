"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";

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
export function useAccordion(defaultOpen: boolean) {
  const [open, setOpen] = useState(defaultOpen);
  const [mounted, setMounted] = useState(defaultOpen);
  const [requested, setRequested] = useState(defaultOpen);
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
export function activateOnKey(event: React.KeyboardEvent<HTMLElement>, action: () => void) {
  if (event.target !== event.currentTarget) return;
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    action();
  }
}

/* Tabs sliding: a segmented control whose active pill slides between options. */
export function Segmented<T extends string>({ compact = false, label, onChange, options, value }: { compact?: boolean; label: string; onChange: (value: T) => void; options: Array<[T, string]>; value: T }) {
  const barRef = useRef<HTMLDivElement | null>(null);
  const pillRef = useRef<HTMLSpanElement | null>(null);
  const placedRef = useRef(false);

  const place = (animate: boolean) => {
    const bar = barRef.current;
    const pill = pillRef.current;
    const tab = bar?.querySelector<HTMLElement>('[aria-pressed="true"]');
    if (!bar || !pill || !tab) return;
    if (animate) {
      pill.style.transform = `translateX(${tab.offsetLeft}px)`;
      pill.style.width = `${tab.offsetWidth}px`;
      return;
    }
    // First paint and resizes snap into place without a tween.
    const previous = pill.style.transition;
    pill.style.transition = "none";
    pill.style.transform = `translateX(${tab.offsetLeft}px)`;
    pill.style.width = `${tab.offsetWidth}px`;
    void pill.offsetWidth;
    pill.style.transition = previous;
  };

  useLayoutEffect(() => {
    place(placedRef.current);
    placedRef.current = true;
  }, [value]);

  useEffect(() => {
    const bar = barRef.current;
    if (!bar) return;
    const observer = new ResizeObserver(() => place(false));
    observer.observe(bar);
    return () => observer.disconnect();
  }, []);

  return <div aria-label={label} className="t-tabs tf-control flex items-center rounded-control bg-canvas font-semibold text-sm [--tabs-inset:2px]" ref={barRef} role="group">
    <span aria-hidden="true" className="t-tabs-pill rounded-md bg-panel shadow-sm" ref={pillRef}/>
    {options.map(([item, text]) => <button aria-pressed={value === item} className={`t-tab min-h-11 rounded-md ${compact ? "px-2.5" : "px-3"} ${value === item ? "text-ink" : "text-muted hover:text-ink"}`} key={item} onClick={() => onChange(item)} type="button">{text}</button>)}
  </div>;
}
