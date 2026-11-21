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
    svg.innerHTML = `<text x="400" y="115" text-anchor="middle" fill="#a9bdb8" font-size="14">No rewards yet</text>`;
    return;
  }
  const max = Math.max(...points.map((p) => p.cumulative), 1);
  const x = (i) => (points.length === 1 ? 400 : 30 + (i * 740) / (points.length - 1));
  const y = (v) => 195 - (v / max) * 170;
  const line = points.map((p, i) => `${x(i)},${y(p.cumulative)}`).join(" ");
  svg.innerHTML = `
    <line x1="30" y1="195" x2="770" y2="195" stroke="#1e2d2a"/>
    <polygon points="${x(0)},195 ${line} ${x(points.length - 1)},195" fill="#d4a85a" opacity="0.12"/>
    <polyline points="${line}" fill="none" stroke="#d4a85a" stroke-width="2.5"/>
    ${points.map((p, i) => `<circle cx="${x(i)}" cy="${y(p.cumulative)}" r="3.5" fill="#efe4cc"><title>${p.date}: ${usd(p.cumulative)} USDC.e</title></circle>`).join("")}
    <text x="30" y="16" fill="#a9bdb8" font-size="12">${usd(max)} USDC.e</text>
    <text x="30" y="214" fill="#a9bdb8" font-size="12">${points[0].date}</text>
    <text x="770" y="214" fill="#a9bdb8" font-size="12" text-anchor="end">${points[points.length - 1].date}</text>`;
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

const loaders = { overview: loadState, markets: loadMarkets };
loadState().catch((err) => toast(err.message, true));
setInterval(() => loadState().catch(() => {}), 30_000);
