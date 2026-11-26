import { describe, expect, it } from "vitest";
import { composeNote, MAX_NOTE_CHARS } from "../src/research/note";

const brief = "The Federal Reserve confirmed a December rate cut on 22 November. Futures had not priced it in.";

describe("note composer", () => {
  it("puts the summary first, then each source's quote, publisher, date and link", () => {
    const note = composeNote(brief, [
      { url: "https://www.federalreserve.gov/n/1", published: "2026-11-22T09:00:00Z", quote: "The Board confirmed the cut." },
      { url: "https://www.reuters.com/a", published: null, quote: null },
    ]);
    expect(note).toBe(
      `${brief}\n\nSources:\n` +
        `1. "The Board confirmed the cut." (federalreserve.gov, published 2026-11-22) https://www.federalreserve.gov/n/1\n` +
        `2. (reuters.com, published date unknown) https://www.reuters.com/a`,
    );
  });

  it("stays under the length limit by shortening quotes and dropping extra sources", () => {
    const long = "word ".repeat(400);
    const sources = [1, 2, 3].map((n) => ({ url: `https://a.gov/${n}`, published: "2026-11-22", quote: long }));
    const note = composeNote(brief, sources);
    expect(note.length).toBeLessThanOrEqual(MAX_NOTE_CHARS);
    expect(note.startsWith(brief)).toBe(true);
    expect(note).toContain("https://a.gov/1");
  });

  it("labels live data with the time it was read", () => {
    const note = composeNote(brief, [
      { url: "https://en.wikipedia.org/w/api.php?action=query&meta=siteinfo", published: "2026-11-25T23:50:10.000Z", quote: null, live: true },
    ]);
    expect(note).toContain("(en.wikipedia.org, live data read 2026-11-25 23:50 UTC)");
  });
});
