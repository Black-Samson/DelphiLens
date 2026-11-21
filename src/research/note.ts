/**
 * The judge reads only what is in the submission and opens each link once with
 * a basic fetch, so the note carries the evidence itself: a short summary, then
 * each source's key sentence word for word, with its publisher, date and link.
 */

export const MAX_NOTE_CHARS = 1800;
const MAX_QUOTE_CHARS = 320;

export interface NoteSource {
  url: string;
  published: string | null;
  quote: string | null;
}

function host(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).replace(/\s+\S*$/, "")}…`;
}

export function composeNote(brief: string, sources: NoteSource[]): string {
  const lines = sources.map((s, i) => {
    const meta = `${host(s.url)}, published ${s.published ? s.published.slice(0, 10) : "date unknown"}`;
    const quote = s.quote ? `"${clip(s.quote, MAX_QUOTE_CHARS)}" ` : "";
    return `${i + 1}. ${quote}(${meta}) ${s.url}`;
  });
  let note = `${brief.trim()}\n\nSources:\n${lines.join("\n")}`;
  // Too long: drop the last source lines (the links still go in the links field).
  while (note.length > MAX_NOTE_CHARS && lines.length > 1) {
    lines.pop();
    note = `${brief.trim()}\n\nSources:\n${lines.join("\n")}`;
  }
  return clip(note, MAX_NOTE_CHARS);
}
