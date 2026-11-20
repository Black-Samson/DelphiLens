import type { DB } from "../db";
import type { MarketInfo } from "./types";

interface MarketRow {
  market_id: string;
  question: string;
  category: string | null;
  yes_odds: number | null;
  close_time: string | null;
  evidence_cutoff: string | null;
  reward_pot: number | null;
  url: string | null;
}

function fromRow(row: MarketRow): MarketInfo {
  return {
    marketId: row.market_id,
    question: row.question,
    category: row.category ?? "other",
    yesOdds: row.yes_odds,
    closeTime: row.close_time,
    evidenceCutoff: row.evidence_cutoff,
    rewardPot: row.reward_pot ?? 0,
    url: row.url,
  };
}

/** Insert or refresh markets. Returns the ids that were new. */
export function saveMarkets(db: DB, markets: MarketInfo[]): string[] {
  const exists = db.prepare("SELECT 1 FROM markets WHERE market_id = ?");
  const upsert = db.prepare(`
    INSERT INTO markets (market_id, question, category, yes_odds, close_time, evidence_cutoff, reward_pot, url, status)
    VALUES (@marketId, @question, @category, @yesOdds, @closeTime, @evidenceCutoff, @rewardPot, @url, 'open')
    ON CONFLICT(market_id) DO UPDATE SET
      question = excluded.question, category = excluded.category, yes_odds = excluded.yes_odds,
      close_time = excluded.close_time, evidence_cutoff = excluded.evidence_cutoff,
      reward_pot = excluded.reward_pot, url = excluded.url, status = 'open', updated_at = datetime('now')`);
  const fresh: string[] = [];
  db.transaction(() => {
    for (const market of markets) {
      if (!exists.get(market.marketId)) fresh.push(market.marketId);
      upsert.run(market);
    }
  })();
  return fresh;
}

export function getMarket(db: DB, marketId: string): MarketInfo | null {
  const row = db.prepare("SELECT * FROM markets WHERE market_id = ?").get(marketId) as MarketRow | undefined;
  return row ? fromRow(row) : null;
}

export function listMarkets(db: DB): MarketInfo[] {
  const rows = db.prepare("SELECT * FROM markets WHERE status = 'open' ORDER BY reward_pot DESC").all() as MarketRow[];
  return rows.map(fromRow);
}

/** Markets opened since a timestamp (SQLite datetime format), for the digest. */
export function marketsOpenedSince(db: DB, since: string): MarketInfo[] {
  const rows = db
    .prepare("SELECT * FROM markets WHERE first_seen_at >= ? ORDER BY first_seen_at DESC")
    .all(since) as MarketRow[];
  return rows.map(fromRow);
}
