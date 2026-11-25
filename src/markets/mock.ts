import type { MarketInfo } from "./types";

const DAY = 24 * 60 * 60 * 1000;

export const CATEGORY_LABELS: Record<string, string> = {
  votes_government: "Votes and government",
  local_language: "Local-language sources",
  official_statistics: "Official statistics",
  releases_standards: "Releases and standards",
  niche_communities: "Niche communities",
  controls: "Macro and rates",
};

/** Sample markets shaped like the real competition list. Times are relative to `now` so they always look open. */
export function sampleMarkets(now = new Date()): MarketInfo[] {
  const make = (
    n: number,
    question: string,
    category: string,
    yesOdds: number,
    days: number,
    dataSources: string[],
  ): MarketInfo => {
    const close = new Date(now.getTime() + days * DAY);
    const opened = new Date(now.getTime() - DAY).toISOString();
    return {
      marketId: `0x${n.toString(16).padStart(40, "0")}`,
      question,
      category,
      yesOdds,
      closeTime: close.toISOString(),
      evidenceCutoff: new Date(close.getTime() - DAY).toISOString(),
      rewardPot: 20,
      url: null,
      resolutionCriteria: `Resolves from the official source, published strictly after ${opened} and before ${close.toISOString()}.`,
      dataSources,
      categoryLabel: CATEGORY_LABELS[category] ?? category,
    };
  };
  return [
    make(1, "Will Swiss voters approve the War Materiel Act amendment in the federal vote of Nov 29, 2026?", "votes_government", 0.55, 4, ["https://www.admin.ch"]),
    make(2, "Will Vox win at least 60 Congress seats in Spain's Nov 29, 2026 general election?", "local_language", 0.48, 4, ["https://infoelectoral.interior.gob.es"]),
    make(3, "Will Destatis's preliminary German CPI annual rate for Nov 2026 be 2.8% or higher?", "official_statistics", 0.57, 5, ["https://www.destatis.de"]),
    make(4, "Will Nigeria's NBS report November 2026 headline inflation below 20%?", "official_statistics", 0.44, 20, ["https://nigerianstat.gov.ng"]),
    make(5, "Will oven-sh/bun publish a GitHub release tagged bun-v1.4.6 or later before Dec 11, 2026?", "releases_standards", 0.54, 15, ["https://github.com/oven-sh/bun/releases"]),
    make(6, "Will the men's winner of the Valencia Marathon on Dec 6, 2026 finish in under 2:03:00?", "niche_communities", 0.57, 11, ["https://www.valenciaciudaddelrunning.com"]),
    make(7, "Will the FOMC's Dec 9, 2026 policy statement list at least one dissenting vote?", "controls", 0.36, 14, ["https://www.federalreserve.gov"]),
    make(8, "Will the Bank of Canada raise its overnight rate target above 2.50% on Dec 9, 2026?", "controls", 0.61, 14, ["https://www.bankofcanada.ca"]),
  ];
}
