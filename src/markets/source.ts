import { DelphiClient, type Network } from "@gensyn-ai/gensyn-delphi-sdk";
import type { Settings } from "../config";
import { fetchFrom } from "../net";
import { sampleMarkets } from "./mock";
import { normalizeMarket, normalizeMarketList } from "./normalize";
import type { MarketInfo } from "./types";

export interface MarketSourceDeps {
  fetch?: typeof fetch;
  sdkClient?: Pick<DelphiClient, "listMarkets">;
  now?: Date;
}

/** Load the open competition markets from the configured source. */
export async function fetchMarkets(settings: Settings, deps: MarketSourceDeps = {}): Promise<MarketInfo[]> {
  switch (settings.marketsSource) {
    case "mock":
      return sampleMarkets(deps.now);

    case "url": {
      if (!settings.marketsUrl) throw new Error("MARKETS_SOURCE=url needs MARKETS_URL");
      const res = await fetchFrom(
        "the competition market list (MARKETS_URL)",
        settings.marketsUrl,
        { headers: { Accept: "application/json", "X-Agent-Id": settings.agentId } },
        deps.fetch ?? fetch,
      );
      if (!res.ok) throw new Error(`Market list returned HTTP ${res.status}`);
      return normalizeMarketList(await res.json());
    }

    case "sdk": {
      if (!settings.delphiApiKey) throw new Error("MARKETS_SOURCE=sdk needs DELPHI_API_ACCESS_KEY");
      const client =
        deps.sdkClient ??
        new DelphiClient({
          network: settings.delphiNetwork as Network,
          apiKey: settings.delphiApiKey,
          extraHeaders: { "X-Agent-Id": settings.agentId },
        });
      const { markets } = await client.listMarkets({
        status: "open",
        limit: 100,
        pricesAndImpliedProbabilities: true,
      });
      return (markets ?? []).map(normalizeMarket).filter((m): m is MarketInfo => m !== null);
    }
  }
}
