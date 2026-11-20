import { describe, expect, it } from "vitest";
import { MockEvidenceApi } from "../src/evidence/mock";
import { baseUnitsToUsdc } from "../src/evidence/types";

const params = { note: "The agency confirmed the rule on Nov 20.", links: ["https://a.gov/r/1"], marketAddress: "0xabc" };

describe("mock evidence api", () => {
  it("queues a submission, then judges it after the delay", async () => {
    const api = new MockEvidenceApi(0);
    const { data } = await api.submitEvidence(params);
    const judged = (await api.waitForSubmission(data.id)).data;
    expect(judged.status).toBe("judged");
    const market = judged.markets[0];
    expect(market.marketAddress).toBe("0xabc");
    expect(["accepted", "rejected"]).toContain(market.verdict);
    expect(market.reason).toBeTruthy();
    if (market.verdict === "accepted") expect(baseUnitsToUsdc(market.bounty?.amount)).toBeGreaterThan(0);
  });

  it("stays queued before the delay and is deterministic across instances", async () => {
    const { data } = await new MockEvidenceApi(60_000).submitEvidence(params);
    expect(data.status).toBe("queued");
    const a = (await new MockEvidenceApi(0).getSubmission(data.id)).data;
    const b = (await new MockEvidenceApi(0).getSubmission(data.id)).data;
    expect(a.markets).toEqual(b.markets);
  });

  it("rejects bad input like the real API", async () => {
    const api = new MockEvidenceApi(0);
    await expect(api.submitEvidence({ note: "x" })).rejects.toThrow(/marketAddress/);
    await expect(api.getSubmission("nonsense")).rejects.toThrow(/Unknown/);
  });

  it("converts USDC.e base units", () => {
    expect(baseUnitsToUsdc("1500000")).toBe(1.5);
    expect(baseUnitsToUsdc(null)).toBe(0);
    expect(baseUnitsToUsdc("abc")).toBe(0);
  });
});
