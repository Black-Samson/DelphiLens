// DelphiLens dashboard. Plain JavaScript, talks to the local API in src/server.ts.

const $ = (id) => document.getElementById(id);
const esc = (t) => String(t ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const usd = (n) => Number(n || 0).toFixed(2);
const pct = (n) => (n === null || n === undefined ? "?" : `${Math.round(n * 100)}%`);
const day = (iso) => (iso ? String(iso).slice(0, 16).replace("T", " ") : "n/a");

async function api(method, path, body) {
  const res = await fetch(path, { method, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function toast(message, isError = false) {
  const el = $("toast");
  el.textContent = message;
  el.className = isError ? "error" : "";
  el.style.display = "block";
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (el.style.display = "none"), 5000);
}

/** Disable a button while its action runs and report errors. */
async function busy(button, action) {
  button.disabled = true;
  try {
    await action();
  } catch (err) {
    toast(err.message, true);
  } finally {
    button.disabled = false;
  }
}

// ------------------------------------------------------------------ theme
// Follows the system light/dark setting until you pick one; your pick is remembered.
const systemDark = window.matchMedia("(prefers-color-scheme: dark)");

function currentTheme() {
  return document.documentElement.dataset.theme || (systemDark.matches ? "dark" : "light");
}

function showThemeButton() {
  const next = currentTheme() === "dark" ? "Light" : "Dark";
  $("theme-toggle").textContent = next;
  $("theme-toggle").setAttribute("aria-label", `Switch to ${next.toLowerCase()} mode`);
}

$("theme-toggle").addEventListener("click", () => {
  const next = currentTheme() === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try {
    window.localStorage.setItem("delphilens-theme", next);
  } catch {
    /* storage unavailable: the choice lasts for this visit only */
  }
  showThemeButton();
});
systemDark.addEventListener("change", showThemeButton);
showThemeButton();

// ------------------------------------------------------------------ tabs
document.querySelectorAll("nav.tabs button").forEach((tab) =>
  tab.addEventListener("click", () => {
    document.querySelectorAll("nav.tabs button").forEach((b) => b.classList.toggle("active", b === tab));
    document.querySelectorAll("main > section").forEach((s) => (s.hidden = s.id !== `tab-${tab.dataset.tab}`));
    loaders[tab.dataset.tab]?.();
  }),
);

// ------------------------------------------------------- sidebar + overview
function drawChart(points) {
  const svg = $("chart");
  if (!points.length) {
    svg.innerHTML = `<text x="400" y="115" text-anchor="middle">No rewards yet</text>`;
    return;
  }
  const max = Math.max(...points.map((p) => p.cumulative), 1);
  const x = (i) => (points.length === 1 ? 400 : 30 + (i * 740) / (points.length - 1));
  const y = (v) => 195 - (v / max) * 170;
  const line = points.map((p, i) => `${x(i)},${y(p.cumulative)}`).join(" ");
  svg.innerHTML = `
    <line class="axis" x1="30" y1="195" x2="770" y2="195"/>
    <polygon class="area" points="${x(0)},195 ${line} ${x(points.length - 1)},195"/>
    <polyline class="line" points="${line}"/>
    ${points.map((p, i) => `<circle cx="${x(i)}" cy="${y(p.cumulative)}" r="3.5" class="dot"><title>${p.date}: ${usd(p.cumulative)} USDC.e</title></circle>`).join("")}
    <text x="30" y="16">${usd(max)} USDC.e</text>
    <text x="30" y="214">${points[0].date}</text>
    <text x="770" y="214" text-anchor="end">${points[points.length - 1].date}</text>`;
}

async function loadState() {
  const s = await api("GET", "/api/state");
  const live = s.modes.delphi === "live";
  $("status-dot").className = `status-dot${live ? " live" : ""}`;
  $("status-text").textContent = live ? "Live on Delphi" : "Mock mode (offline)";
  $("modes").textContent = `Search: ${s.modes.search} · LLM: ${s.modes.llm}`;
  $("toggle-mock").checked = s.mockMode;
  $("toggle-auto").checked = s.autoSubmit;

  const q = s.stats.qualification;
  $("q-judged").textContent = q.judged;
  $("q-markets").textContent = q.markets;
  $("bar-judged").style.width = `${Math.min(100, q.judged * 10)}%`;
  $("bar-markets").style.width = `${Math.min(100, (q.markets / 3) * 100)}%`;
  $("q-done").hidden = !q.qualified;

  $("k-usdc").textContent = usd(s.stats.totalUsdc);
  $("k-judged").textContent = s.stats.judged;
  $("k-rate").textContent = pct(s.stats.acceptanceRate);
  $("k-markets").textContent = s.stats.activeMarkets;
  drawChart(s.earnings);
  $("recent").innerHTML =
    s.recent
      .map(
        (r) => `<tr><td><span class="pill ${esc(r.verdict)}">${esc(r.verdict || r.status)}</span></td>
          <td>${esc(r.question)}</td><td><span class="pill ${esc(r.stance)}">${esc(r.stance)}</span></td>
          <td>${usd(r.usdc)}</td><td class="muted">${esc(r.reason)}</td></tr>`,
      )
      .join("") || `<tr><td colspan="5" class="muted">No verdicts yet.</td></tr>`;
}

async function setSwitch(key, value) {
  try {
    await api("POST", "/api/settings", { [key]: value });
    toast(`${key === "mockMode" ? "Mock mode" : "Auto-submit"} ${value ? "on" : "off"}`);
  } catch (err) {
    toast(err.message, true);
  }
  loadState();
}
$("toggle-mock").addEventListener("change", (e) => setSwitch("mockMode", e.target.checked));
$("toggle-auto").addEventListener("change", (e) => setSwitch("autoSubmit", e.target.checked));

// ---------------------------------------------------------------- markets
async function loadMarkets() {
  const markets = await api("GET", "/api/markets");
  $("markets").innerHTML =
    markets
      .map(
        (m) => `<tr>
          <td>${m.url ? `<a href="${esc(m.url)}" target="_blank" rel="noopener">${esc(m.question)}</a>` : esc(m.question)}
            <div class="muted" style="font-size:12px">${esc(m.category)}</div></td>
          <td>${pct(m.yesOdds)}</td><td>${usd(m.rewardPot)}</td><td>${day(m.evidenceCutoff)}</td>
          <td><span class="pill ${esc(m.stance)}">${esc(m.stance)}</span></td><td>${m.used}/3</td>
          <td><button data-mine="${esc(m.marketId)}" ${m.used >= 3 ? "disabled" : ""}>Mine now</button></td></tr>`,
      )
      .join("") || `<tr><td colspan="7" class="muted">No markets yet. Press Refresh markets.</td></tr>`;
}

$("markets").addEventListener("click", (e) => {
  const button = e.target.closest("button[data-mine]");
  if (!button) return;
  busy(button, async () => {
    button.textContent = "Mining...";
    const out = await api("POST", `/api/markets/${encodeURIComponent(button.dataset.mine)}/mine`);
    toast(out.status === "draft_created" ? `Draft ready (${out.stance}). Review it in Review & receipts.` : `No new evidence: ${out.log.at(-1) || out.status}`);
    button.textContent = "Mine now";
    loadMarkets();
  });
});
$("refresh-markets").addEventListener("click", (e) =>
  busy(e.target, async () => {
    const r = await api("POST", "/api/markets/refresh");
    toast(`${r.new} new markets`);
    loadMarkets();
  }),
);

// ------------------------------------------------------- review & receipts
function submissionCard(s, withActions) {
  const links = s.links.map((l) => `<li><a href="${esc(l)}" target="_blank" rel="noopener">${esc(l)}</a></li>`).join("");
  const files = s.files.map((f) => `<a href="/snapshots/${encodeURIComponent(f)}">${esc(f)}</a>`).join(" · ");
  const verdict = s.verdict || s.status;
  return `<div class="card">
    <div class="label">#${s.id} · ${esc(s.question || s.market_id)}</div>
    <p style="margin:10px 0 0"><span class="pill ${esc(s.stance)}">${esc(s.stance)}</span>
      ${withActions ? "" : `<span class="pill ${esc(verdict)}">${esc(verdict)}</span> <span class="muted">${usd(s.usdc)} USDC.e${s.bounty_state ? ` · ${esc(s.bounty_state)}` : ""}${s.zero_pay_reason ? ` · ${esc(s.zero_pay_reason)}` : ""}</span>`}</p>
    <p>${esc(s.note)}</p>
    <ul class="links">${links}</ul>
    ${files ? `<p class="muted" style="font-size:12px">Snapshots: ${files}</p>` : ""}
    ${s.reason ? `<div class="panel" style="margin-top:12px"><div class="label">Judge rationale</div><p style="margin:8px 0 0">${esc(s.reason)}</p></div>` : ""}
    ${withActions ? `<div class="actions"><button data-approve="${s.id}">Approve &amp; submit</button><button class="danger" data-discard="${s.id}">Reject draft</button></div>` : ""}
  </div>`;
}

async function loadReview() {
  const all = await api("GET", "/api/submissions");
  const drafts = all.filter((s) => s.status === "draft");
  const sent = all.filter((s) => !["draft", "discarded"].includes(s.status));
  $("drafts").innerHTML = drafts.map((s) => submissionCard(s, true)).join("") || `<p class="muted">No drafts waiting.</p>`;
  $("receipts").innerHTML = sent.map((s) => submissionCard(s, false)).join("") || `<p class="muted">Nothing submitted yet.</p>`;
}

$("drafts").addEventListener("click", (e) => {
  const approve = e.target.closest("button[data-approve]");
  const discard = e.target.closest("button[data-discard]");
  const button = approve || discard;
  if (!button) return;
  busy(button, async () => {
    if (approve) {
      const r = await api("POST", `/api/submissions/${approve.dataset.approve}/approve`);
      toast(`Submitted to Delphi (${r.status}). The verdict usually arrives within minutes.`);
    } else {
      await api("POST", `/api/submissions/${discard.dataset.discard}/discard`);
      toast("Draft rejected. Its sources are free to use again.");
    }
    loadReview();
    loadState();
  });
});
$("poll").addEventListener("click", (e) =>
  busy(e.target, async () => {
    const r = await api("POST", "/api/poll");
    toast(`Checked ${r.checked} submissions`);
    loadReview();
    loadState();
  }),
);

// --------------------------------------------------- newsletter & feedback
async function loadNewsletter() {
  const digest = await api("GET", "/api/digest");
  $("digest").textContent = digest ? digest.markdown : "No digest yet. Press Generate digest.";
  const feedback = await api("GET", "/api/feedback");
  $("feedback").innerHTML =
    feedback
      .map(
        (f) => `<tr><td><span class="pill">${esc(f.kind)}</span></td><td>${esc(f.detail)}</td><td>${f.count}×</td>
          <td>${f.sent_id ? `<span class="muted">Sent</span>` : `<button class="ghost" data-send-feedback="${f.id}">Send to Delphi</button>`}</td></tr>`,
      )
      .join("") || `<tr><td colspan="4" class="muted">No issues logged.</td></tr>`;
}

$("digest-generate").addEventListener("click", (e) =>
  busy(e.target, async () => {
    const d = await api("POST", "/api/digest");
    $("digest").textContent = d.markdown;
    toast(`Saved reports/${d.file}`);
  }),
);
$("digest-send").addEventListener("click", (e) =>
  busy(e.target, async () => {
    const r = await api("POST", "/api/digest/send");
    toast(`Discord: ${r.discord} · Email: ${r.email}`, r.discord.startsWith("failed") || r.email.startsWith("failed"));
  }),
);
$("feedback-export").addEventListener("click", (e) =>
  busy(e.target, async () => {
    const r = await api("POST", "/api/feedback/export");
    toast(`Saved reports/${r.file}`);
  }),
);
$("feedback").addEventListener("click", (e) => {
  const button = e.target.closest("button[data-send-feedback]");
  if (!button) return;
  busy(button, async () => {
    const r = await api("POST", `/api/feedback/${button.dataset.sendFeedback}/send`);
    toast(`Sent to Delphi's feedback team (id ${r.id})`);
    loadNewsletter();
  });
});
$("fb-add").addEventListener("click", (e) =>
  busy(e.target, async () => {
    await api("POST", "/api/feedback", { kind: $("fb-kind").value, detail: $("fb-detail").value });
    $("fb-detail").value = "";
    loadNewsletter();
  }),
);

const loaders = { overview: loadState, markets: loadMarkets, review: loadReview, newsletter: loadNewsletter };
loadState().catch((err) => toast(err.message, true));
setInterval(() => loadState().catch(() => {}), 30_000);
