export function formatCompact(value: number): string {
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value || 0);
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat("en").format(value || 0);
}

export function formatDuration(milliseconds: number): string {
  if (!milliseconds) return "—";
  if (milliseconds < 1000) return `${Math.round(milliseconds)}ms`;
  return `${(milliseconds / 1000).toFixed(milliseconds >= 10_000 ? 0 : 1)}s`;
}

export function formatDate(value?: string): string {
  if (!value) return "Unknown";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

export function formatTime(value?: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(date);
}

/* A start time as people scan a list: the time today, "Yesterday", the month and
   day this year, the full date before that. The exact time belongs in a title. */
export function formatDay(value?: string, now = new Date()): string {
  if (!value) return "Unknown";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const time = date.getTime();
  if (time >= startOfToday) return new Intl.DateTimeFormat("en", { timeStyle: "short" }).format(date);
  if (time >= startOfToday - 86_400_000) return "Yesterday";
  if (date.getFullYear() === now.getFullYear()) return new Intl.DateTimeFormat("en", { month: "short", day: "numeric" }).format(date);
  return new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(date);
}
