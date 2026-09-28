import { asObject } from "@/lib/json";
import { ChevronRightIcon } from "../ui/icons";
import { ReadableText, previewText } from "./section-views";

export interface EmbeddedConversation {
  project: string;
  source: string;
  instruction: string;
  items: Record<string, unknown>[];
}

function bodyText(item: Record<string, unknown>): string {
  const value = item.content ?? item.output ?? item.arguments ?? item.text ?? item.message ?? item.input;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((part) => {
    const content = asObject(part);
    return typeof content.text === "string" ? content.text : JSON.stringify(part, null, 2);
  }).join("\n\n");
  return JSON.stringify(value ?? item, null, 2);
}

/** A quoted history stays inside its captured block; its entries are not new turns. */
export function EmbeddedConversationView({ conversation }: { conversation: EmbeddedConversation }) {
  const { project, source, instruction, items } = conversation;
  return <section className="min-w-0 space-y-3">
    <div>
      <h4 className="tf-heading">Historical conversation{project ? ` · ${project.split("/").filter(Boolean).at(-1)}` : ""}</h4>
      <p className="mt-1 text-xs text-muted">{items.length} captured entries supplied for memory writing.</p>
    </div>
    <details className="text-xs text-muted">
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 [&>svg]:[[open]>&]:rotate-90"><ChevronRightIcon className="size-4 shrink-0"/>Task and source</summary>
      <div className="space-y-2 break-words"><p>{instruction}</p><p>{project}</p><p className="font-mono">{source}</p></div>
    </details>
    <ol className="divide-y divide-line">
      {items.map((item, index) => {
        const type = String(item.type || "unknown");
        const result = /(?:call_output|tool_result)$/.test(type);
        const call = /(?:tool_call|function_call)$/.test(type);
        const role = String(item.role || "");
        const label = result ? "Tool result" : call ? `Tool call${item.name ? ` · ${item.name}` : ""}` : type === "agent_message" ? "Agent message" : role === "user" ? "User" : role === "assistant" ? "Model" : role === "developer" || role === "system" ? "Context" : "Unknown";
        const body = bodyText(item);
        return <li key={index} className="min-w-0">
          <details>
            <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 py-3">
              <ChevronRightIcon className="size-4 shrink-0"/><span className="shrink-0 text-xs text-muted">{index + 1}</span>
              <span className="shrink-0 text-xs font-medium">{label}</span>
              <span className="min-w-0 truncate text-xs text-muted">{previewText(body)}</span>
            </summary>
            <div className="min-w-0 space-y-2 pb-3">
              <ReadableText value={body}/>
              <details className="text-xs text-muted">
                <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2"><ChevronRightIcon className="size-4 shrink-0"/>Captured entry</summary>
                <pre className="tf-code tf-well max-h-[24rem] overflow-auto p-3">{JSON.stringify(item, null, 2)}</pre>
              </details>
            </div>
          </details>
        </li>;
      })}
    </ol>
  </section>;
}
