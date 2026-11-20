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

  async complete(system: string, prompt: string): Promise<string> {
    const res = await this.fetchFn(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        model: this.model,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: prompt },
        ],
      }),
    });
    if (!res.ok) throw new Error(`LLM returned HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const content = body.choices?.[0]?.message?.content;
    if (!content) throw new Error("LLM reply had no content");
    return content;
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
  return prompt.split("TEXT:\n")[1]?.trim() ?? "";
}

function count(text: string, words: string[]): number {
  return words.reduce((n, w) => n + (text.match(new RegExp(`\\b${w}\\b`, "g"))?.length ?? 0), 0);
}

/** Keyword-based stand-in so the pipeline runs offline. A real LLM replaces its judgment. */
export class MockLLM implements LLMProvider {
  async complete(_system: string, prompt: string): Promise<string> {
    if (prompt.startsWith("TASK: VERIFY")) return JSON.stringify(this.verify(prompt));
    if (prompt.startsWith("TASK: BRIEF")) return JSON.stringify(this.brief(prompt));
    throw new Error("MockLLM got an unknown task");
  }

  private verify(prompt: string) {
    const text = bodyText(prompt).toLowerCase();
    const yes = count(text, YES_WORDS);
    const no = count(text, NO_WORDS);
    const stance = yes > no ? "YES" : no > yes ? "NO" : null;
    return {
      publicly_accessible: !PRIVATE.some((p) => text.includes(p)),
      verifiable: Boolean(field(prompt, "PUBLISHED")) && !UNVERIFIED.some((p) => text.includes(p)),
      shifts_probability: stance !== null,
      stance,
      confidence: stance ? Math.min(0.95, 0.5 + 0.15 * Math.abs(yes - no)) : 0.2,
      reason: "Mock keyword check; a real LLM replaces this judgment.",
    };
  }

  private brief(prompt: string) {
    const sentences = splitSentences(bodyText(prompt)).slice(0, 2);
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
