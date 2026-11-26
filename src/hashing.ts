import { createHash } from "node:crypto";

/** Canonical form of a URL: lowercase host, no tracking params, no fragment, no trailing slash. */
export function normalizeUrl(raw: string): string {
  try {
    const url = new URL(raw.trim());
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|ref$|ref_src)/i.test(key)) url.searchParams.delete(key);
      // Paging parameters on API lists don't change which source it is.
      if (url.hostname === "api.github.com" && /^(per_page|page)$/.test(key)) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    const pathname = url.pathname.replace(/\/+$/, "") || "";
    const query = url.searchParams.toString();
    return `${url.protocol}//${url.host}${pathname}${query ? `?${query}` : ""}`;
  } catch {
    return raw.trim().toLowerCase();
  }
}

/** Case- and whitespace-insensitive hash of a claim. */
export function hashText(text: string): string {
  const cleaned = text.toLowerCase().replace(/\s+/g, " ").trim();
  return createHash("sha256").update(cleaned).digest("hex");
}

export function hashUrl(url: string): string {
  return hashText(normalizeUrl(url));
}
