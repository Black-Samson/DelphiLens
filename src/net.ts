/**
 * Node's fetch fails with a bare "fetch failed" and hides the reason in `cause`.
 * This wraps a request so the error names the service and the real reason
 * (address not found, connection refused, timeout...).
 */
export class NetworkError extends Error {
  constructor(
    public readonly service: string,
    public readonly url: string,
    reason: string,
  ) {
    super(`Could not reach ${service} at ${url}: ${reason}`);
    this.name = "NetworkError";
  }
}

const HINTS: Record<string, string> = {
  ENOTFOUND: "address not found (check the URL for typos, and your internet connection)",
  EAI_AGAIN: "address lookup failed (check your internet connection)",
  ECONNREFUSED: "connection refused",
  ECONNRESET: "connection was reset",
  ETIMEDOUT: "connection timed out",
  UND_ERR_CONNECT_TIMEOUT: "connection timed out",
  CERT_HAS_EXPIRED: "the site's security certificate has expired",
};

export function describeNetworkError(err: unknown): string {
  const e = err as { name?: string; message?: string; cause?: { code?: string; message?: string } };
  if (e?.name === "TimeoutError" || e?.name === "AbortError") return "the request timed out";
  const code = e?.cause?.code;
  if (code && HINTS[code]) return `${HINTS[code]} [${code}]`;
  return e?.cause?.message ?? e?.message ?? String(err);
}

/** fetch() that throws a NetworkError naming the service when the connection itself fails. */
export async function fetchFrom(
  service: string,
  url: string,
  init?: RequestInit,
  fetchFn: typeof fetch = fetch,
): Promise<Response> {
  try {
    return await fetchFn(url, init);
  } catch (err) {
    const host = (() => {
      try {
        return new URL(url).origin;
      } catch {
        return url;
      }
    })();
    throw new NetworkError(service, host, describeNetworkError(err));
  }
}
