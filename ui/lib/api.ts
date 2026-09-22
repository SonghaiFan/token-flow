import type { AgentBucket, SessionRecordsPayload, SessionsPayload } from "./types";

async function readJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal, headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`Request failed (${response.status})`);
  return response.json() as Promise<T>;
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
