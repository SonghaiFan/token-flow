import type { AgentBucket, CaptureStatus, DeleteSessionsResult, SessionRecordsPayload, SessionsPayload } from "./types";

async function readJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal, headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`Request failed (${response.status})`);
  return response.json() as Promise<T>;
}

async function deleteJson<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "DELETE",
    headers: { Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
  return payload as T;
}

async function captureMutation(method: "POST" | "DELETE", body?: unknown): Promise<CaptureStatus> {
  const health = await readJson<{ quit_token?: string }>("/dashboard/health");
  if (!health.quit_token) throw new Error("Capture controls are unavailable for this dashboard");
  const response = await fetch("/dashboard/captures", {
    method,
    headers: {
      Accept: "application/json",
      "X-Claude-Tap-Dashboard-Token": health.quit_token,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({})) as CaptureStatus & { error?: string };
  if (!response.ok && response.status !== 409) throw new Error(payload.error || `Request failed (${response.status})`);
  return payload;
}

export async function fetchSessions(
  filters: { agent?: string; date?: string; status?: string; search?: string } = {},
  signal?: AbortSignal,
): Promise<SessionsPayload> {
  const params = new URLSearchParams({ offset: "0", limit: "200" });
  for (const [key, value] of Object.entries(filters)) {
    if (value) params.set(key, value);
  }
  return readJson<SessionsPayload>(`/api/sessions?${params}`, signal);
}

export async function fetchAgents(signal?: AbortSignal): Promise<AgentBucket[]> {
  const payload = await readJson<{ agents: AgentBucket[] }>("/api/agents", signal);
  return payload.agents;
}

export function fetchSessionRecords(sessionId: string, signal?: AbortSignal): Promise<SessionRecordsPayload> {
  return readJson<SessionRecordsPayload>(`/api/sessions/${encodeURIComponent(sessionId)}/records?view=turns`, signal);
}

export function deleteSession(sessionId: string): Promise<DeleteSessionsResult> {
  return deleteJson<DeleteSessionsResult>(`/api/sessions/${encodeURIComponent(sessionId)}`);
}

export function clearSessions(): Promise<DeleteSessionsResult> {
  return deleteJson<DeleteSessionsResult>("/api/sessions", { clear_all: true });
}

export function fetchCaptureStatus(signal?: AbortSignal): Promise<CaptureStatus> {
  return readJson<CaptureStatus>("/dashboard/captures", signal);
}

export function startCapture(client: string): Promise<CaptureStatus> {
  return captureMutation("POST", { client });
}

export function stopCapture(): Promise<CaptureStatus> {
  return captureMutation("DELETE");
}

/* Local tokenizer estimates for prompt blocks, in request order. Sent in batches
   under the server's size limits; a missing tokenizer rejects with the reason. */
export async function fetchTokenEstimates(texts: string[], signal?: AbortSignal): Promise<number[]> {
  const counts: number[] = [];
  let batch: string[] = [];
  let size = 0;
  const flush = async () => {
    if (!batch.length) return;
    const response = await fetch("/api/token-estimates", {
      method: "POST",
      signal,
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ texts: batch }),
    });
    const payload = await response.json().catch(() => ({})) as { counts?: number[]; error?: string };
    if (!response.ok || !Array.isArray(payload.counts)) throw new Error(payload.error || `Request failed (${response.status})`);
    counts.push(...payload.counts);
    batch = [];
    size = 0;
  };
  for (const text of texts) {
    if (batch.length >= 1000 || size + text.length > 4_000_000) await flush();
    batch.push(text);
    size += text.length;
  }
  await flush();
  return counts;
}
