import { describeNetworkError, fetchFrom, NetworkError } from "../net";
import { mockSameFact } from "./samefact";

export interface LLMProvider {
  complete(system: string, prompt: string): Promise<string>;
}

export function splitSentences(text: string): string[] {
  return text
    .trim()
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'(])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Any OpenAI-compatible chat completions API: OpenAI, OpenRouter, Groq, Gemini's OpenAI endpoint... */
export class OpenAICompatibleLLM implements LLMProvider {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly model: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  /** Some free providers reject JSON mode; after one refusal, ask for plain text (replies are parsed leniently). */
  private jsonMode = true;

  /** Waits before retrying a busy (429/503), failing (500/502) or briefly unreachable provider. Tests set these to 0. */
  retryDelaysMs = [5_000, 15_000, 30_000];

  /** One request, retried when the connection itself blips (DNS hiccup, reset). */
  private async requestWithNetworkRetry(system: string, prompt: string): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.request(system, prompt);
      } catch (err) {
        const transient = /EAI_AGAIN|ECONNRESET|timed out|socket/i.test((err as Error).message);
        if (!transient || attempt >= 2) throw err;
        await new Promise((r) => setTimeout(r, this.retryDelaysMs[0] ?? 0));
      }
    }
  }

  async complete(system: string, prompt: string): Promise<string> {
    let res = await this.requestWithNetworkRetry(system, prompt);
    for (const delay of this.retryDelaysMs) {
      if (![429, 500, 502, 503].includes(res.status)) break;
      const after = Number(res.headers.get("retry-after"));
      await new Promise((r) => setTimeout(r, Number.isFinite(after) && after > 0 ? Math.min(after * 1000, 60_000) : delay));
      res = await this.requestWithNetworkRetry(system, prompt);
    }
    if (res.status === 400 && this.jsonMode) {
      const detail = await res.clone().text();
      if (/response_format|json/i.test(detail)) {
        this.jsonMode = false;
        res = await this.request(system, prompt);
      }
    }
    let body: { choices?: { message?: { content?: string } }[] };
    try {
      if (!res.ok) throw new Error(`LLM returned HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      body = (await res.json()) as typeof body;
    } catch (err) {
      if ((err as Error).message.startsWith("LLM returned")) throw err;
      throw new NetworkError("the AI service (LLM_BASE_URL)", this.baseUrl, describeNetworkError(err));
    }
    const content = body.choices?.[0]?.message?.content;
    if (!content) throw new Error("LLM reply had no content");
    return content;
  }

  private request(system: string, prompt: string): Promise<Response> {
    return fetchFrom("the AI service (LLM_BASE_URL)", `${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
      signal: AbortSignal.timeout(90_000),
      body: JSON.stringify({
        model: this.model,
        temperature: 0,
        ...(this.jsonMode ? { response_format: { type: "json_object" } } : {}),
        messages: [
          { role: "system", content: `${system} Reply with JSON only.` },
          { role: "user", content: prompt },
        ],
      }),
    }, this.fetchFn);
  }
}

const YES_WORDS = ["approved", "passed", "confirmed", "scheduled", "signed", "cleared", "released", "merged", "agreed"];
const NO_WORDS = ["rejected", "delayed", "postponed", "withdrawn", "failed", "blocked", "denied", "cancelled", "canceled", "suspended"];
const PRIVATE = ["subscribe to continue", "subscribers only", "sign in to read", "paywall", "confidential", "leaked", "data breach"];
const UNVERIFIED = ["anonymous source", "unconfirmed", "rumor", "rumour", "people familiar with", "could not be confirmed"];

function field(prompt: string, name: string): string {
  return prompt.match(new RegExp(`^${name}: (.*)$`, "m"))?.[1]?.trim() ?? "";
}

function bodyText(prompt: string): string {
  const parts = prompt.split("\nTEXT:\n");
  return parts.length > 1 ? parts[parts.length - 1].trim() : "";
}

function count(text: string, words: string[]): number {
  return words.reduce((n, w) => n + (text.match(new RegExp(`\\b${w}\\b`, "g"))?.length ?? 0), 0);
}

/** Keyword-based stand-in so the pipeline runs offline. A real LLM replaces its judgment. */
export class MockLLM implements LLMProvider {
  async complete(_system: string, prompt: string): Promise<string> {
    if (prompt.startsWith("TASK: VERIFY")) return JSON.stringify(this.verify(prompt));
    if (prompt.startsWith("TASK: BRIEF")) return JSON.stringify(this.brief(prompt));
    if (prompt.startsWith("TASK: SAME_FACT")) return mockSameFact(prompt);
    if (prompt.startsWith("TASK: QUERIES")) return JSON.stringify({ queries: [] });
    throw new Error("MockLLM got an unknown task");
  }

  private verify(prompt: string) {
    const text = bodyText(prompt).toLowerCase();
    const yes = count(text, YES_WORDS);
    const no = count(text, NO_WORDS);
    const stance = yes > no ? "YES" : no > yes ? "NO" : null;
    const original = bodyText(prompt);
    const quote =
      splitSentences(original).find((sentence) => count(sentence.toLowerCase(), [...YES_WORDS, ...NO_WORDS]) > 0) ?? null;
    return {
      fact: quote ? `${quote.replace(/\.$/, "")} (${field(prompt, "PUBLISHED").slice(0, 10)}).` : "",
      quote,
      publicly_accessible: !PRIVATE.some((p) => text.includes(p)),
      verifiable: Boolean(field(prompt, "PUBLISHED")) && !UNVERIFIED.some((p) => text.includes(p)),
      shifts_probability: stance !== null,
      likely_known: false,
      stance,
      confidence: stance ? Math.min(0.95, 0.5 + 0.15 * Math.abs(yes - no)) : 0.2,
      reason: "Mock keyword check; a real LLM replaces this judgment.",
    };
  }

  private brief(prompt: string) {
    // Summarize from the first source's text, skipping the SOURCE and FACT header lines.
    const firstSource = bodyText(prompt).split(/\n\nSOURCE \d+:/)[0];
    const text = firstSource.split("\n").filter((l) => !/^(SOURCE \d+|FACT):/.test(l)).join(" ");
    const sentences = splitSentences(text).slice(0, 2);
    const host = (() => {
      try {
        return new URL(field(prompt, "SOURCE_URL")).hostname.replace(/^www\./, "");
      } catch {
        return "the source";
      }
    })();
    sentences.push(`Published ${field(prompt, "PUBLISHED").slice(0, 10)} by ${host}.`);
    return { brief: sentences.join(" ") };
  }
}
