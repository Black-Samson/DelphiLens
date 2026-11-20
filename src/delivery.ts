import nodemailer from "nodemailer";
import type { Settings } from "./config";

const DISCORD_LIMIT = 2000;

/** Discord messages are capped at 2000 characters; long digests are trimmed with a pointer to the file. */
export function discordContent(markdown: string): string {
  if (markdown.length <= DISCORD_LIMIT) return markdown;
  const note = "\n\n_(trimmed; the full digest is in reports/)_";
  return markdown.slice(0, DISCORD_LIMIT - note.length).replace(/\n[^\n]*$/, "") + note;
}

export async function sendDiscord(webhookUrl: string, markdown: string, fetchFn: typeof fetch = fetch): Promise<void> {
  const res = await fetchFn(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "DelphiLens", content: discordContent(markdown) }),
  });
  if (!res.ok) throw new Error(`Discord webhook returned HTTP ${res.status}`);
}

export interface Mailer {
  sendMail(options: { from: string; to: string; subject: string; text: string; html: string }): Promise<unknown>;
}

export async function sendEmail(
  smtp: Settings["smtp"],
  subject: string,
  text: string,
  html: string,
  mailer?: Mailer,
): Promise<void> {
  const transport =
    mailer ??
    nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.port === 465,
      auth: smtp.user ? { user: smtp.user, pass: smtp.password } : undefined,
    });
  await transport.sendMail({ from: smtp.from, to: smtp.to, subject, text, html });
}

export interface DeliveryResult {
  discord: "sent" | "skipped" | string;
  email: "sent" | "skipped" | string;
}

/** Send to every configured channel. Failures are reported per channel, never thrown. */
export async function deliverDigest(
  settings: Settings,
  digest: { subject: string; markdown: string; html: string },
  deps: { fetch?: typeof fetch; mailer?: Mailer } = {},
): Promise<DeliveryResult> {
  const result: DeliveryResult = { discord: "skipped", email: "skipped" };
  if (settings.discordWebhookUrl) {
    try {
      await sendDiscord(settings.discordWebhookUrl, digest.markdown, deps.fetch);
      result.discord = "sent";
    } catch (err) {
      result.discord = `failed: ${(err as Error).message}`;
    }
  }
  if (settings.smtp.host && settings.smtp.to) {
    try {
      await sendEmail(settings.smtp, digest.subject, digest.markdown, digest.html, deps.mailer);
      result.email = "sent";
    } catch (err) {
      result.email = `failed: ${(err as Error).message}`;
    }
  }
  return result;
}
