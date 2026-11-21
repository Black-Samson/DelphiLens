# Go-live checklist (November 23)

The competition opens on 23 November at 17:00 UTC, which is 18:00 in Lagos. Until then DelphiLens runs in mock mode. These are the steps to switch it to the real Delphi API.

## Before the 23rd

- [ ] Delphi account created; main wallet address noted.
- [ ] Registered on DoraHacks with that wallet and the agent name **DelphiLens**.
- [ ] `SEARCH_API_KEY` (Tavily) and `LLM_API_KEY` set in `.env`. Mock mode can already use them, so you can check research quality on the sample markets.
- [ ] `npm run check` passes.

## On the 23rd

1. **Get the API key.** Use the Delphi API key page linked from the competition site (testnet keys: https://delphi-api-access.gensyn.ai/). Put it in `.env`:

       DELPHI_API_ACCESS_KEY=...

2. **Read the agent guide.** Copy two values from it into `.env`:

       DELPHI_EVIDENCE_BASE_URL=https://<delphi app domain>/v1
       MARKETS_URL=https://.../markets.json     # and set MARKETS_SOURCE=url

   If the guide says to read markets through the SDK instead, keep `MARKETS_SOURCE=sdk`.

3. **Set the model header.** Put the model you use in `AGENT_MODEL`, for example `gpt-4o-mini`, so results show under the right harness and model.

4. **Switch off mock mode.** Set `MOCK_MODE=false`, or untick *Mock mode* in the dashboard. DelphiLens refuses to start live mode without real search and LLM keys, so it can never send mock evidence.

5. **Accept the evidence terms yourself.** Read them first:

       npm start -- terms                      # shows the version and the link
       npm start -- terms --accept <version>   # only after you have read them

6. **Check the market list.**

       npm start -- markets

   If markets are missing fields (odds, cutoff or pot show as `?` or `0`), paste one entry from `markets.json` into the chat so the field list in `src/markets/normalize.ts` can be adjusted.

7. **Make the first submission by hand.** Open the dashboard (`npm run dashboard`), press **Mine now** on a contested market, read the draft, then press **Approve & submit**. The verdict usually arrives within minutes; press **Check verdicts now**.

8. **Then let the worker run.** Start `npm run worker` in a second terminal. Keep *Auto-submit* off until you trust the drafts.

## Rules DelphiLens enforces for you

| Competition rule | Where |
| --- | --- |
| Max 3 submissions per market, max 3 files each | `src/guardrails.ts`, plus `getEntryState` before every submit |
| Evidence for both sides of a market cancels out | Stance lock in `src/guardrails.ts` |
| Repeated evidence earns nothing | Link and claim hashes locally, plus `listSubmissions` before every submit |
| Public information only | Paywall list, robots.txt check, LLM public-access check |
| 10 judged submissions across 3+ markets to qualify | Qualification tracker and market prioritizer |
| Send ID, harness and model headers | `X-Agent-Id`, `X-Agent-Harness`, `X-Agent-Model` via the SDK |
