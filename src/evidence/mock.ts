import { createHash, randomUUID } from "node:crypto";
import type {
  EntryState,
  EvidenceApi,
  EvidenceLimits,
  EvidenceResult,
  EvidenceTerms,
  Submission,
  SubmissionSummary,
  SubmitEvidenceParams,
} from "./types";

const ACCEPT_REASONS = [
  "Primary source, dated inside the evidence window and not yet reflected in the forecast.",
  "Verifiable official document that moved the forecaster's probability.",
  "Specific, dated and sourced; the forecaster had not seen it.",
];
const REJECT_REASONS = [
  "The fact was already known to the forecaster.",
  "Secondary commentary rather than a primary, dated fact.",
  "The claim could not be verified from the linked source.",
];

function result<T>(data: T): EvidenceResult<T> {
  return { data, meta: { requestId: `mock-${randomUUID()}` } };
}

/**
 * Offline stand-in for the Delphi Evidence API.
 *
 * It is stateless: the submission id carries the market, submit time and a
 * content hash, so the worker and the dashboard (separate processes) agree on
 * every verdict. About 70% of submissions are accepted, after `judgeDelayMs`.
 */
export class MockEvidenceApi implements EvidenceApi {
  constructor(private readonly judgeDelayMs = 5000) {}

  async submitEvidence(p: SubmitEvidenceParams): Promise<EvidenceResult<Submission>> {
    if (!p.marketAddress) throw new Error("marketAddress is required");
    const items = (p.note ? 1 : 0) + (p.links?.length ?? 0) + (p.files?.length ?? 0);
    if (items === 0) throw new Error("invalid_request: send a note, links or files");
    if (items > 3) throw new Error("invalid_request: at most 3 items in all (the note is 1, each link and file is 1)");
    const digest = createHash("sha256")
      .update(`${p.note}|${(p.links ?? []).join("|")}`)
      .digest("hex")
      .slice(0, 8);
    const id = `mock_${p.marketAddress}_${Date.now()}_${digest}`;
    return result(this.build(id, p.note, p.links ?? []));
  }

  async getSubmission(id: string): Promise<EvidenceResult<Submission>> {
    return result(this.build(id, null, []));
  }

  async listSubmissions(): Promise<EvidenceResult<{ items: SubmissionSummary[]; nextCursor: string | null }>> {
    return result({ items: [], nextCursor: null });
  }

  async getEntryState(): Promise<EvidenceResult<EntryState>> {
    return result({
      canSubmit: true,
      remainingOnMarket: 3,
      judgementPotRemainingBaseUnits: "500000000",
      rateLimit: { resetAt: new Date(Date.now() + 3_600_000).toISOString() },
    });
  }

  async getLimits(): Promise<EvidenceResult<EvidenceLimits>> {
    const hour = new Date(Date.now() + 3_600_000).toISOString();
    return result({ submitsLeftThisHour: 20, hourEndsAt: hour, dailyCapLeft: 50, dailyCapResetAt: hour });
  }

  async getTerms(): Promise<EvidenceResult<EvidenceTerms>> {
    return result({ version: "mock-1", url: "https://example.com/terms", acceptedAt: new Date(0).toISOString() });
  }

  async acceptTerms(version: string) {
    return result({ version, acceptedAt: new Date().toISOString() });
  }

  async waitForSubmission(id: string): Promise<EvidenceResult<Submission>> {
    const wait = Math.max(0, this.submittedAt(id) + this.judgeDelayMs - Date.now());
    await new Promise((resolve) => setTimeout(resolve, wait));
    return this.getSubmission(id);
  }

  private submittedAt(id: string): number {
    return Number(id.split("_")[2] ?? 0);
  }

  private build(id: string, note: string | null, links: string[]): Submission {
    const [prefix, marketAddress, , digest] = id.split("_");
    if (prefix !== "mock" || !marketAddress || !digest) throw new Error(`Unknown mock submission: ${id}`);
    const base: Submission = {
      id,
      createdAt: new Date(this.submittedAt(id)).toISOString(),
      agentId: "DelphiLens",
      note,
      links,
      files: [],
      status: "queued",
      judgingEstimateSeconds: Math.ceil(this.judgeDelayMs / 1000),
      markets: [],
    };
    if (Date.now() - this.submittedAt(id) < this.judgeDelayMs) return base;

    const accepted = parseInt(digest.slice(0, 2), 16) % 10 < 7;
    const pick = parseInt(digest.slice(2, 4), 16);
    const reward = accepted ? String(500_000 + (parseInt(digest.slice(4, 8), 16) % 4_500_000)) : "0";
    return {
      ...base,
      status: "judged",
      markets: [
        {
          marketAddress,
          status: "judged",
          verdict: accepted ? "accepted" : "rejected",
          reason: accepted ? ACCEPT_REASONS[pick % 3] : REJECT_REASONS[pick % 3],
          bounty: accepted ? { amount: reward, state: "held" } : null,
          settlementUpTo: accepted ? reward : null,
        },
      ],
    };
  }
}
