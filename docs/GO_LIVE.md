# Going live

The competition runs from 25 November 2026, 17:00 UTC, to 11 December 2026, 17:00 UTC. The official guide is at https://competition.delphi.fyi/participate, and the version for agents is at https://competition.delphi.fyi/skill.md.

## 1. Register (once)

- Sign in to Delphi (https://app.delphi.fyi) at least once. That creates your account and wallet.
- Register on DoraHacks with **the wallet shown on your Delphi profile** and the display name **DelphiLens**: https://dorahacks.io/hackathon/delphi-agent-competition2/detail
- Access syncs once an hour, so wait up to an hour after registering.

## 2. Fill in `.env`

```bash
nano .env
```

| Setting | Value |
| --- | --- |
| `DELPHI_API_ACCESS_KEY` | A **Mainnet** key from https://api-access.delphi.fyi, signed in the same way you sign in to Delphi. Never share it. |
| `DELPHI_WALLET` | The wallet on your Delphi profile (`0x...`). Only used to send feedback. |
| `SEARCH_API_KEY` | Tavily key (https://tavily.com) |
| `LLM_API_KEY`, `LLM_MODEL` | Your AI provider key and model |
| `AGENT_MODEL` | The model name to show on results, e.g. `gpt-4o-mini` |
| `AUTO_SUBMIT` | Keep `false` until you trust the drafts |

You can leave `DELPHI_EVIDENCE_BASE_URL` and `MARKETS_URL` alone. They already default to `https://delphi.fyi/v1` and `https://competition.delphi.fyi/markets.json`.

## 3. Switch to live mode and run the checks

```bash
npm start -- mock off
npm start -- doctor
```

`doctor` runs the same checks as the official guide:

- **API key:** `GET /v1/limits`. A 401 means a wrong key or a Testnet key. A 404 means you aren't registered yet, or registered less than an hour ago.
- **Terms:** `GET /v1/terms`.
- **Markets:** the competition list.
- **Feedback wallet:** whether `DELPHI_WALLET` is set.

## 4. Accept the terms yourself

Read them first. DelphiLens never accepts them for you.

```bash
npm start -- terms                      # shows the version and the link
npm start -- terms --accept <version>   # only after you have read them
```

## 5. First submission by hand

```bash
npm run dashboard
```

1. Open http://localhost:8501.
2. In *Live markets*, press **Mine now** on a market.
3. In *Review & receipts*, read the draft: the summary, the quoted sources and the links.
4. If it's good, press **Approve & submit**. If not, press **Reject draft**.
5. A few minutes later, press **Check verdicts now** to see the verdict, rationale and reward.

## 6. Let the worker run

```bash
npm run worker      # in a second terminal
```

It checks for new markets every 5 minutes, checks Delphi's entry state before researching a market, checks the hourly limit before submitting, and polls receipts. Leave *Auto-submit* off until you're happy with the drafts.

## Rules DelphiLens enforces for you

| Competition rule | How |
| --- | --- |
| Up to 3 submissions per market | Local count plus `GET /v1/markets/{market}/entry-state` before research and before submitting |
| Up to 3 items per submission, and the note counts as one | Note plus at most 2 links; local snapshots are not uploaded |
| Hourly submission limit | `GET /v1/limits` before each batch |
| Both sides of a market cancel out | Stance lock, chosen only when one side clearly outweighs the other |
| Facts public before the market opened are presumed priced | Sources dated before the market's start (from its resolution criteria) are dropped |
| Repeats earn nothing ("it's the facts that count") | Link and claim hashes, an AI same-fact check, and `listSubmissions` before sending |
| Public information only | Paywall list, robots.txt, and an AI public-access check |
| Send `X-Agent-Id`, `X-Agent-Harness` and `X-Agent-Model` | Set on every Evidence API and feedback call |
| Retry safely after a timeout | The Idempotency-Key is saved before sending and reused |

## Feedback bounties (5 × $250)

DelphiLens logs API errors, rate limits and tool problems automatically. You can add your own notes in the dashboard. To send one to Delphi:

```bash
npm start -- feedback               # list entries
npm start -- feedback --send <id>   # send one (20 per day max)
```

Or press **Send to Delphi** next to an entry in the *Newsletter & feedback* tab. Nothing is sent without you choosing it.
