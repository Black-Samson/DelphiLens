import fs from "node:fs";
import path from "node:path";
import { hashUrl } from "../hashing";
import { MAX_FILES_PER_SUBMISSION } from "../guardrails";
import type { SearchResult } from "./search";

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
}

/** Save one source as a clean markdown snapshot with its URL and date in the header. */
export function saveSnapshot(dir: string, marketId: string, result: SearchResult, text: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const host = (() => {
    try {
      return new URL(result.url).hostname.replace(/^www\./, "");
    } catch {
      return "source";
    }
  })();
  const file = path.join(dir, `${slug(marketId).slice(0, 14)}__${slug(host)}__${hashUrl(result.url).slice(0, 8)}.md`);
  const body = [
    "---",
    `market: ${marketId}`,
    `source_url: ${result.url}`,
    `published: ${result.published ?? ""}`,
    `captured: ${new Date().toISOString()}`,
    "---",
    "",
    `# ${result.title}`,
    "",
    text.trim(),
    "",
  ].join("\n");
  fs.writeFileSync(file, body, "utf8");
  return file;
}

export function saveSnapshots(dir: string, marketId: string, items: { result: SearchResult; text: string }[]): string[] {
  if (items.length > MAX_FILES_PER_SUBMISSION) throw new Error(`Max ${MAX_FILES_PER_SUBMISSION} snapshots per submission`);
  return items.map(({ result, text }) => saveSnapshot(dir, marketId, result, text));
}
