"use client";

import { useEffect } from "react";

export function DeleteDialog({ busy, description, error, onCancel, onConfirm, open, title }: {
  busy: boolean;
  description: string;
  error?: string;
  onCancel: () => void;
  onConfirm: () => void;
  open: boolean;
  title: string;
}) {
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onCancel();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [busy, onCancel, open]);

  if (!open) return null;
  return <div className="fixed inset-0 z-[100] grid place-items-center bg-black/45 p-4" onMouseDown={(event) => { if (event.currentTarget === event.target && !busy) onCancel(); }}>
    <section aria-describedby="delete-dialog-description" aria-labelledby="delete-dialog-title" aria-modal="true" className="w-full max-w-md rounded-2xl border border-line bg-panel p-5 shadow-2xl" role="alertdialog">
      <h2 className="text-lg font-semibold tracking-[-0.02em]" id="delete-dialog-title">{title}</h2>
      <p className="mt-2 text-sm leading-6 text-muted" id="delete-dialog-description">{description}</p>
      {error ? <div className="mt-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">{error}</div> : null}
      <div className="mt-5 flex justify-end gap-2">
        <button autoFocus className="min-h-10 rounded-xl border border-line px-4 text-sm font-medium hover:bg-canvas disabled:opacity-50" disabled={busy} onClick={onCancel} type="button">Cancel</button>
        <button className="min-h-10 rounded-xl bg-red-600 px-4 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-50" disabled={busy} onClick={onConfirm} type="button">{busy ? "Deleting…" : "Delete"}</button>
      </div>
    </section>
  </div>;
}
