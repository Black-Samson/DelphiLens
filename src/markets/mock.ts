import type { MarketInfo } from "./types";

const DAY = 24 * 60 * 60 * 1000;

/** Sample competition markets. Times are relative to `now` so they always look open. */
export function sampleMarkets(now = new Date()): MarketInfo[] {
  const make = (
    n: number,
    question: string,
    category: string,
    yesOdds: number,
    days: number,
    rewardPot: number,
  ): MarketInfo => {
    const close = new Date(now.getTime() + days * DAY);
    return {
      marketId: `0x${n.toString(16).padStart(40, "0")}`,
      question,
      category,
      yesOdds,
      closeTime: close.toISOString(),
      evidenceCutoff: new Date(close.getTime() - DAY).toISOString(),
      rewardPot,
      url: null,
    };
  };
  return [
    make(1, "Will the US Senate pass a continuing resolution before Dec 15?", "politics", 0.62, 21, 500),
    make(2, "Will the European Commission publish new AI Act guidance before Dec 31?", "politics", 0.48, 40, 350),
    make(3, "Will the SEC approve staking in a spot Ethereum ETF before Jan 15?", "crypto", 0.35, 55, 800),
    make(4, "Will Bitcoin close above $100,000 on Dec 31?", "crypto", 0.41, 44, 650),
    make(5, "Will the Federal Reserve cut rates at its December meeting?", "economics", 0.57, 28, 900),
    make(6, "Will Nigeria's annual inflation rate for November be below 20%?", "economics", 0.44, 35, 400),
    make(7, "Will Linux kernel 7.0 be released before Jan 31?", "technology", 0.29, 70, 300),
    make(8, "Will Arsenal be top of the Premier League on Dec 25?", "sports", 0.52, 34, 450),
  ];
}
