import { asNumber, asObject, type AnyObject } from "../json";
import type { ProtocolAdapter } from "./types";
import { promptUsage, responseBody, usageObject } from "./usage";

/* Gemini `generateContent`, including Code Assist's `v1internal` wrapper that
   nests the request and response under `request` / `response`. */
function geminiRequest(body: AnyObject): AnyObject {
  const nested = asObject(body.request);
  return Object.keys(nested).length ? nested : body;
}

export const gemini: ProtocolAdapter = {
  id: "gemini",
  matches: (_record, path) => path.includes("generatecontent"),
  usage(record) {
    const body = responseBody(record);
    const metadata = asObject(body.usageMetadata ?? asObject(body.response).usageMetadata);
    if (!Object.keys(metadata).length) return promptUsage(usageObject(record), false);
    // Gemini counts cached content inside the prompt and bills thoughts as output.
    const input = asNumber(metadata.promptTokenCount);
    return {
      input,
      cached: Math.min(input, asNumber(metadata.cachedContentTokenCount)),
      output: asNumber(metadata.candidatesTokenCount) + asNumber(metadata.thoughtsTokenCount),
    };
  },
  system: (body) => {
    const request = geminiRequest(body);
    return request.system_instruction ?? request.systemInstruction;
  },
  items(body) {
    const contents = geminiRequest(body).contents;
    return Array.isArray(contents) ? contents : [];
  },
  isToolResultPart: (part) => part.functionResponse !== undefined,
};
