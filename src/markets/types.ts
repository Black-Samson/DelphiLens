/** A competition market, normalized from whichever source supplied it. */
export interface MarketInfo {
  /** The market's on-chain address. Sent as marketAddress when submitting evidence. */
  marketId: string;
  question: string;
  category: string;
  /** Implied probability of YES, 0 to 1, or null if the source has no price. */
  yesOdds: number | null;
  closeTime: string | null;
  evidenceCutoff: string | null;
  /** Judgment reward pot in USDC.e (human units, not base units). */
  rewardPot: number;
  url: string | null;
  /** How the market resolves, word for word from Delphi. */
  resolutionCriteria?: string | null;
  /** Official sources the market resolves from. Research looks here first. */
  dataSources?: string[];
  /** Readable category name, e.g. "Official statistics". */
  categoryLabel?: string | null;
}
