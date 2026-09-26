import { useEffect, useMemo, useState } from "react";
import { fetchTokenEstimates } from "./api";
import { buildTurns, estimateTexts, type TokenEstimates } from "./token-model";
import type { TraceRecord, TurnModel } from "./types";

/* Turns for captured records. Categories render from measured counts first; local
   estimates for blocks the provider did not count arrive afterwards and refine them. */
export function useEstimatedTurns(records: TraceRecord[] | undefined): TurnModel[] {
  const measuredTurns = useMemo(() => buildTurns(records || []), [records]);
  const [estimates, setEstimates] = useState<TokenEstimates>(() => new Map());
  const [estimatesUnavailable, setEstimatesUnavailable] = useState(false);
  const pendingTexts = useMemo(() => (estimatesUnavailable ? [] : estimateTexts(measuredTurns).filter((text) => !estimates.has(text))), [estimates, estimatesUnavailable, measuredTurns]);
  useEffect(() => {
    if (!pendingTexts.length) return;
    const controller = new AbortController();
    fetchTokenEstimates(pendingTexts, controller.signal)
      .then((counts) => setEstimates((current) => new Map([...current, ...pendingTexts.map((text, index) => [text, counts[index]] as const)])))
      .catch((reason: Error) => {
        if (reason.name !== "AbortError") setEstimatesUnavailable(true);
      });
    return () => controller.abort();
  }, [pendingTexts]);
  return useMemo(() => (estimates.size ? buildTurns(records || [], estimates) : measuredTurns), [records, estimates, measuredTurns]);
}
