import { describe, expect, it, vi } from "vitest";
import { loadSettings } from "../src/config";
import { deliverDigest, discordContent } from "../src/delivery";

const digest = { subject: "DelphiLens digest", markdown: "# Digest\n\nAll good.", html: "<p>All good.</p>" };

describe("digest delivery", () => {
  it("skips channels that are not configured", async () => {
    expect(await deliverDigest(loadSettings({}), digest)).toEqual({ discord: "skipped", email: "skipped" });
  });

  it("posts to Discord and emails when configured", async () => {
    const fetchFn = vi.fn(async () => new Response(null, { status: 204 }));
    const mailer = { sendMail: vi.fn(async () => ({})) };
    const settings = loadSettings({
      DISCORD_WEBHOOK_URL: "https://discord.example/webhook",
      SMTP_HOST: "smtp.example.com",
      SMTP_USER: "me@example.com",
      DIGEST_EMAIL_TO: "you@example.com",
    });
    const result = await deliverDigest(settings, digest, { fetch: fetchFn as unknown as typeof fetch, mailer });
    expect(result).toEqual({ discord: "sent", email: "sent" });
    const body = JSON.parse(((fetchFn.mock.calls[0] as unknown[])[1] as RequestInit).body as string);
    expect(body).toEqual({ username: "DelphiLens", content: digest.markdown });
    expect(mailer.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({ from: "me@example.com", to: "you@example.com", subject: "DelphiLens digest" }),
    );
  });

  it("reports a failing channel without throwing", async () => {
    const fetchFn = async () => new Response("bad", { status: 400 });
    const settings = loadSettings({ DISCORD_WEBHOOK_URL: "https://d" });
    const result = await deliverDigest(settings, digest, { fetch: fetchFn as unknown as typeof fetch });
    expect(result.discord).toMatch(/failed: .*400/);
  });

  it("keeps Discord messages under 2000 characters", () => {
    const long = Array.from({ length: 300 }, (_, i) => `- line ${i}`).join("\n");
    const content = discordContent(long);
    expect(content.length).toBeLessThanOrEqual(2000);
    expect(content).toContain("trimmed");
  });
});
