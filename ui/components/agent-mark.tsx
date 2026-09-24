const AGENT_ICON_FILES: Record<string, string> = {
  agy: "antigravity",
  antigravity: "antigravity",
  "antigravity cli": "antigravity",
  claude: "claude",
  "claude code": "claude",
  codex: "codex",
  "codex app": "codex",
  "codex cli": "codex",
  codebuddy: "codebuddy",
  dsh: "deepseek",
  "deepseek harness": "deepseek",
  gemini: "gemini-cli",
  "gemini cli": "gemini-cli",
  grok: "grok",
  "grok build cli": "grok",
  hermes: "hermes",
  "hermes agent": "hermes",
  kimi: "kimi",
  "kimi code": "kimi",
  "kimi code cli": "kimi",
  mimo: "mimo",
  "mimo code": "mimo",
  openclaw: "openclaw",
  opencode: "opencode",
  pi: "pi",
  qoder: "qoder",
  "qoder cli": "qoder",
};

export function AgentMark({ label }: { label: string }) {
  const icon = AGENT_ICON_FILES[label.trim().toLowerCase()];
  if (!icon) return null;

  return (
    <span aria-hidden="true" className="grid size-6 shrink-0 place-items-center rounded-tag border border-line/70 bg-white p-0.5">
      <img alt="" className="size-full object-contain" src={`/assets/agents/${icon}.svg`} />
    </span>
  );
}
