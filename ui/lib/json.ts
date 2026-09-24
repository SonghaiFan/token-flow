/* Tolerant readers for captured JSON. Captures come from many clients, so every
   field is optional and may have an unexpected type. */

export type AnyObject = Record<string, unknown>;

export function asObject(value: unknown): AnyObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as AnyObject) : {};
}

export function asNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

export function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  const block = asObject(value);
  if (typeof block.text === "string" && block.text.trim()) return block.text;
  if (typeof block.output === "string") return block.output;
  return "";
}

export function textParts(value: unknown): string[] {
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  if (Array.isArray(value)) return value.flatMap(textParts);
  const item = asObject(value);
  if (!Object.keys(item).length) return [];
  const direct = item.text ?? item.output ?? item.input_text ?? item.output_text ?? item.prompt ?? item.query;
  if (direct !== undefined && direct !== value) return textParts(direct);
  if (item.content !== undefined && item.content !== value) return textParts(item.content);
  if (item.parts !== undefined && item.parts !== value) return textParts(item.parts);
  return [];
}
