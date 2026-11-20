import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { saveSnapshots } from "../src/research/snapshots";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "snap-"));
const result = { title: "A title", url: "https://a.gov/x", snippet: "", published: "2026-11-20T08:00:00.000Z" };

describe("snapshots", () => {
  it("writes markdown with the source and date", () => {
    const [file] = saveSnapshots(tmp(), "0xabc", [{ result, text: "Body text." }]);
    const content = fs.readFileSync(file, "utf8");
    expect(file.endsWith(".md")).toBe(true);
    expect(content).toContain("source_url: https://a.gov/x");
    expect(content).toContain("published: 2026-11-20T08:00:00.000Z");
    expect(content).toContain("# A title\n\nBody text.");
  });

  it("refuses more than 3 files", () => {
    expect(() => saveSnapshots(tmp(), "0xabc", Array(4).fill({ result, text: "x" }))).toThrow(/Max 3/);
  });
});
