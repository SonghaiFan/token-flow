import type { KeyboardEvent, ReactNode, Ref } from "react";
import { ChevronDownIcon, CloseIcon, SearchIcon } from "./icons";

const FIELD = "tf-control w-full rounded-control border border-line bg-panel text-sm text-ink placeholder:text-muted hover:border-muted/50";

/* The one search input: icon, field, and a clear button once it has a value.
   Escape handling belongs to the caller, since each search clears differently. */
export function SearchField({ autoFocus, inputRef, label, onChange, onKeyDown, placeholder, value }: { autoFocus?: boolean; inputRef?: Ref<HTMLInputElement>; label: string; onChange: (value: string) => void; onKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void; placeholder: string; value: string }) {
  return <label className="relative block min-w-0 flex-1">
    <span className="sr-only">{label}</span>
    <SearchIcon className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted"/>
    <input autoFocus={autoFocus} className={`${FIELD} pl-10 pr-11`} onChange={(event) => onChange(event.target.value)} onKeyDown={onKeyDown} placeholder={placeholder} ref={inputRef} type="search" value={value}/>
    {value ? <button aria-label={`Clear ${label.toLowerCase()}`} className="absolute inset-y-0 right-0 grid w-11 place-items-center rounded-control text-muted hover:text-ink" onClick={() => onChange("")} title="Clear" type="button"><CloseIcon className="size-4"/></button> : null}
  </label>;
}

/* A native select styled as a field. The label is for assistive technology;
   the first option names the unfiltered state ("All agents"). */
export function Select({ children, label, onChange, value }: { children: ReactNode; label: string; onChange: (value: string) => void; value: string }) {
  return <label className="relative block shrink-0">
    <span className="sr-only">{label}</span>
    <select className={`${FIELD} appearance-none pl-3 pr-10`} onChange={(event) => onChange(event.target.value)} value={value}>{children}</select>
    <ChevronDownIcon className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-muted"/>
  </label>;
}
