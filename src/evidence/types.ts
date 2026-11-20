import type { EvidenceClient } from "@gensyn-ai/gensyn-delphi-sdk";

/** The part of the SDK's EvidenceClient DelphiLens uses. The mock implements the same shape. */
export type EvidenceApi = Pick<
  EvidenceClient,
  | "submitEvidence"
  | "getSubmission"
  | "listSubmissions"
  | "getEntryState"
  | "getLimits"
  | "getTerms"
  | "acceptTerms"
  | "waitForSubmission"
>;

export type {
  EntryState,
  EvidenceLimits,
  EvidenceResult,
  EvidenceTerms,
  Submission,
  SubmissionMarket,
  SubmissionStatus,
  SubmissionSummary,
  SubmitEvidenceParams,
} from "@gensyn-ai/gensyn-delphi-sdk";

/** USDC.e has 6 decimals; the API reports amounts in base units. */
export const USDC_DECIMALS = 6;

export function baseUnitsToUsdc(amount: string | null | undefined): number {
  if (!amount || !/^\d+$/.test(amount)) return 0;
  return Number(BigInt(amount)) / 10 ** USDC_DECIMALS;
}
