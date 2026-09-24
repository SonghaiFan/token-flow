import { asObject } from "../json";
import type { TraceRecord } from "../types";
import { claude } from "./claude";
import { codex } from "./codex";
import { pi } from "./pi";
import type { AgentPlugin } from "./types";

export type { AgentPlugin, SectionFact, SectionView } from "./types";

/* Add an agent by writing a plugin and listing it here. Its capture side is the
   matching `token_tap/agents/<id>.py`. */
const AGENTS: AgentPlugin[] = [codex, pi, claude];

/* Agents without their own plugin, and records captured before `capture.client`
   existed, keep the conventions every known harness uses. Those rules only match
   their own markers, so combining them does not misread one agent as another. */
export const fallbackAgent: AgentPlugin = {
  id: "generic",
  clients: [],
  declaredKind: codex.declaredKind,
  contentKinds: codex.contentKinds,
  textPatterns: [...(codex.textPatterns || []), ...(claude.textPatterns || [])],
  injectedUserPrefixes: [...(codex.injectedUserPrefixes || []), ...(claude.injectedUserPrefixes || [])],
  metadataPrompts: codex.metadataPrompts,
  cleanPrompt: codex.cleanPrompt,
  sections: codex.sections,
};

const BY_CLIENT = new Map(AGENTS.flatMap((agent) => agent.clients.map((client) => [client, agent] as const)));
const BY_ID = new Map([...AGENTS, fallbackAgent].map((agent) => [agent.id, agent] as const));

export function recordClient(record: TraceRecord): string {
  const client = asObject(asObject(record as unknown).capture).client;
  return typeof client === "string" ? client.toLowerCase() : "";
}

export function agentForRecord(record: TraceRecord): AgentPlugin {
  return BY_CLIENT.get(recordClient(record)) || fallbackAgent;
}

export function agentById(id: string): AgentPlugin {
  return BY_ID.get(id) || fallbackAgent;
}
