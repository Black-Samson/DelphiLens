import { describe, expect, it } from "vitest";
import { hashText, hashUrl, normalizeUrl } from "../src/hashing";

describe("hashing", () => {
  it("normalizes urls so cosmetic differences match", () => {
    expect(normalizeUrl("https://WWW.Example.com/a/?utm_source=x#top")).toBe("https://example.com/a");
    expect(hashUrl("https://example.com/a/")).toBe(hashUrl("https://www.example.com/a?utm_medium=y"));
  });

  it("keeps meaningful query params", () => {
    expect(hashUrl("https://a.gov/doc?id=1")).not.toBe(hashUrl("https://a.gov/doc?id=2"));
  });

  it("hashes claims ignoring case and spacing", () => {
    expect(hashText("The agency  filed a rule")).toBe(hashText("the AGENCY filed a rule"));
    expect(hashText("a")).not.toBe(hashText("b"));
  });
});
