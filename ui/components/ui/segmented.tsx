"use client";

import { useEffect, useLayoutEffect, useRef } from "react";

/* One view switch for the content beside it (Structured, Raw, Changes). The active
   pill slides between options (Tabs sliding). */
export function Segmented<T extends string>({ label, onChange, options, value }: { label: string; onChange: (value: T) => void; options: Array<[T, string]>; value: T }) {
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

  return <div aria-label={label} className="t-tabs tf-control grid grid-flow-col auto-cols-fr items-center rounded-control bg-canvas p-0.5 text-sm font-medium [--tabs-inset:2px]" ref={barRef} role="group">
    <span aria-hidden="true" className="t-tabs-pill rounded-[calc(var(--tf-radius-control)-var(--tabs-inset))] border border-line bg-panel shadow-raised" ref={pillRef}/>
    {options.map(([item, text]) => <button aria-pressed={value === item} className={`t-tab min-h-11 w-full rounded-[calc(var(--tf-radius-control)-var(--tabs-inset))] px-3 ${value === item ? "text-ink" : "text-muted hover:text-ink"}`} key={item} onClick={() => onChange(item)} type="button">{text}</button>)}
  </div>;
}
