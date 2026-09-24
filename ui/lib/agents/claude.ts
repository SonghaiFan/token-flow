import type { AgentPlugin } from "./types";

/* Claude Code injects reminders into user turns as `<system-reminder>` blocks. */
export const claude: AgentPlugin = {
  id: "claude",
  clients: ["claude"],
  textPatterns: [[/^<system-reminder/i, { layer: "context", label: "System reminder" }]],
  injectedUserPrefixes: ["<system-reminder"],
};
