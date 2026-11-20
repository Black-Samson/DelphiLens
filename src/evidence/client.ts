import { EvidenceClient } from "@gensyn-ai/gensyn-delphi-sdk";
import { agentIdentity, type Settings } from "../config";
import { MockEvidenceApi } from "./mock";
import type { EvidenceApi } from "./types";

/**
 * The Evidence API client. In mock mode this is the offline MockEvidenceApi;
 * otherwise it is the SDK's EvidenceClient, which sends
 * Authorization: Bearer <key>, X-Agent-Id, X-Agent-Harness and X-Agent-Model
 * on every request.
 */
export function createEvidenceApi(settings: Settings): EvidenceApi {
  if (settings.mockMode) return new MockEvidenceApi();
  const missing = [
    !settings.delphiApiKey && "DELPHI_API_ACCESS_KEY",
    !settings.evidenceBaseUrl && "DELPHI_EVIDENCE_BASE_URL",
  ].filter(Boolean);
  if (missing.length) throw new Error(`Live mode needs ${missing.join(" and ")} in .env`);
  if (!/\/v1$/.test(settings.evidenceBaseUrl)) {
    throw new Error("DELPHI_EVIDENCE_BASE_URL must end with /v1, e.g. https://<delphi app domain>/v1");
  }
  return new EvidenceClient({
    baseUrl: settings.evidenceBaseUrl,
    apiKey: settings.delphiApiKey,
    ...agentIdentity(settings),
  });
}
