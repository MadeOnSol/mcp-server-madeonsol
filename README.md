# mcp-server-madeonsol

[![npm version](https://img.shields.io/npm/v/mcp-server-madeonsol?style=flat-square)](https://www.npmjs.com/package/mcp-server-madeonsol)
[![npm downloads](https://img.shields.io/npm/dm/mcp-server-madeonsol?style=flat-square)](https://www.npmjs.com/package/mcp-server-madeonsol)
[![Smithery](https://img.shields.io/badge/Smithery-listed-blueviolet?style=flat-square)](https://smithery.ai/servers/madeonsol/solana-kol-intelligence)
[![Glama](https://glama.ai/mcp/servers/LamboPoewert/mcp-server-madeonsol/badges/score.svg)](https://glama.ai/mcp/servers/LamboPoewert/mcp-server-madeonsol)
[![MCP](https://img.shields.io/badge/MCP-compatible-blueviolet?style=flat-square)](https://modelcontextprotocol.io/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue?style=flat-square)](LICENSE)

> ⚡ **[Install via Smithery](#install-via-smithery-one-line)** · 🤖 **[Use in Claude Desktop](#claude-desktop)** · 🖱️ **[Use in Cursor](#cursor)** · 📚 **[API docs](https://madeonsol.com/api-docs)** · 💰 **[Free API key](https://madeonsol.com/pricing)** · 🔎 **[On Glama](https://glama.ai/mcp/servers/LamboPoewert/mcp-server-madeonsol)**

MCP server for [MadeOnSol](https://madeonsol.com) Solana KOL intelligence API. Use from Claude Desktop, Cursor, or any MCP-compatible client.

> Real-time Solana trading intelligence: track 1,069 KOL wallets with <3s latency, score 23,000+ Pump.fun deployers, surface deshred deploy signals **~500ms before on-chain confirmation**, detect multi-KOL coordination, and stream every DEX trade across 9+ programs. Free tier: 200 requests/day at [madeonsol.com/pricing](https://madeonsol.com/pricing) — no credit card required.

> **New in 1.12.0** — **Token risk score.** New tool `madeonsol_token_risk` — a transparent 0–100 rug-risk/safety score (higher = riskier) with a `band` (safe/caution/danger), an explainable `factors[]` array, and the raw `inputs` (mint/freeze authority, liquidity, liq-to-MC ratio, transfer fee, launch cohort, deployer bond rate, KOL signal, blacklist). PRO/ULTRA only.
>
> **New in 1.11.0** — `madeonsol_tokens_list` gains three new filter params: `min_liq_mc_ratio`, `max_liq_mc_ratio`, and `deployer_tier`. Response items now include `liquidity_to_mc_ratio` and `deployer_tier`. New tool: `madeonsol_signal_performance` — evaluate signal efficacy (hit rate, sample size, median outcome) before acting on any signal. KOL leaderboard entries now include `median_hold_minutes_30d` and `percentile_early_entry_30d`.
>
> **New in 1.10.4** — Deployer alerts/profiles now expose `runner_rate` + `labeled_tokens` (fraction of a deployer's labeled tokens that ran vs dumped, gate on `labeled_tokens` ≥3) plus `avg_time_to_bond_minutes`.

> **New in 1.10.3** — **Dump-cluster detection.** `madeonsol_token_buyer_quality` breakdown now includes `dump_cluster_count` (3+ dump-cluster wallets in the first-20 → 94% historical dump rate vs 61% base) and `recycled_early_buyer_count`. Full breakdown is returned on all tiers. Also: the API now pushes every pump.fun graduation in real time (`token:graduations` WS channel).

> **New in 1.10** — **Deshred Sniper Alerts.** `madeonsol_sniper_recent` surfaces pump.fun deploys from shred-level data ~500ms before on-chain confirmation. PRO: elite/good deployers. ULTRA: all tiers + custom watchlist. Use `sniper:deploys` WebSocket or `sniper:deploy` webhook for live push.
>
> **New in 1.9** — **Price alerts, scout leaderboard, coordination history.** `madeonsol_price_alerts_*` CRUD (PRO=5, ULTRA=25). `madeonsol_scout_leaderboard` ranks top scouts by first-touch follow-on rate. `madeonsol_coordination_history` and `madeonsol_peak_history` expose the historical record. `madeonsol_wallet_stats` now returns `derived`: win_rate, roi, verdict, biggest_miss.
>
> **New in 1.8** — **Universal Wallet API.** `madeonsol_wallet_stats`, `madeonsol_wallet_pnl`, `madeonsol_wallet_positions`, `madeonsol_wallet_trades` — FIFO cost-basis PnL and cursor-paginated raw trades for any Solana wallet. PRO+. Cache hits don't count against quota.
>
> **New in 1.7.0** *(2026-05-12)* — Two new tools: **`madeonsol_me`** (account/quota introspection — read tier, remaining requests, and per-feature usage without parsing rate-limit headers) and **`madeonsol_tokens_list`** (PRO+ filtered, sortable token directory — MC band, liquidity floor, primary DEX, authority/safety flags, plus computed 1h volume / MEV-share / MC-change deltas). Token responses now expose **velocity / MEV-share** fields. Token directory defaults to **`min_liq=2000`** to skip phantom-MC dust — pass `min_liq=0` to opt out. `/token/{mint}` now returns **structured 400 errors** (`code` / `reason` / `example` / `docs`) instead of plain strings. Deprecated `avg_entry_mc_usd` field fully removed from KOL/alpha leaderboards.

## Install via Smithery (one line)

[Smithery](https://smithery.ai/servers/madeonsol/solana-kol-intelligence) is the easiest path — it writes the config for you and handles the install:

```bash
npx -y smithery mcp add madeonsol/solana-kol-intelligence
```

Smithery prompts for your `MADEONSOL_API_KEY` ([free at madeonsol.com/pricing](https://madeonsol.com/pricing)) and wires up Claude Desktop or your chosen MCP client. Restart the client and ask: *"What are KOLs buying right now?"*

You can also browse tools from the CLI:

```bash
npx -y smithery tool get madeonsol/solana-kol-intelligence madeonsol_kol_feed
```

## Quick start — manual config (10 seconds)

```bash
npm install -g mcp-server-madeonsol
```

Add to `claude_desktop_config.json` or Cursor MCP settings (free tier at https://madeonsol.com/pricing):

```json
{ "mcpServers": { "madeonsol": { "command": "mcp-server-madeonsol", "env": { "MADEONSOL_API_KEY": "msk_..." } } } }
```

Restart Claude Desktop and ask: *"What are KOLs buying right now?"*

## Authentication

Two options (in priority order):

| Method | Env var | Best for |
|---|---|---|
| **MadeOnSol API key** (recommended) | `MADEONSOL_API_KEY` | Developers — [get a free key](https://madeonsol.com/pricing) |
| x402 micropayments | `SVM_PRIVATE_KEY` | AI agents with Solana wallets |

> **v1.0 breaking change:** RapidAPI auth (`RAPIDAPI_KEY`) has been removed. The MadeOnSol RapidAPI marketplace was retired on 2026-04-19. Get a free `msk_` key at [madeonsol.com/pricing](https://madeonsol.com/pricing).

## Install

```bash
npm install -g mcp-server-madeonsol
```

> x402 peer deps (`@x402/fetch @x402/svm @x402/core @solana/kit @scure/base`) are only needed when using `SVM_PRIVATE_KEY`.

## Configure

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "madeonsol": {
      "command": "mcp-server-madeonsol",
      "env": {
        "MADEONSOL_API_KEY": "msk_your_api_key_here"
      }
    }
  }
}
```

### Cursor

Add to MCP settings with the same command and env vars.

## Tools

### KOL Intelligence

| Tool | Description |
|---|---|
| `madeonsol_kol_feed` | Real-time KOL trade feed (1,000+ wallets) |
| `madeonsol_kol_coordination` | Multi-KOL convergence signals (v1.1) — peak-density window, exit detection, 0-100 score |
| `madeonsol_kol_first_touches` | First-KOL-touch events — backtested scout signal. Filter by scout tier, winrate, token age, mint suffix |
| `madeonsol_kol_leaderboard` | KOL PnL and win rate rankings (180 days of history; periods: today, 7d, 30d, 90d, 180d) |
| `madeonsol_kol_pairs` | KOL affinity matrix — which KOLs co-trade the same tokens |
| `madeonsol_kol_hot_tokens` | KOL momentum tokens — accelerating buy interest |
| `madeonsol_kol_trending_tokens` | Tokens ranked by KOL buy volume (5m–12h windows). ULTRA adds full KOL wallet addresses. |
| `madeonsol_kol_pnl` | Deep per-wallet PnL: equity curve, risk metrics, closed positions. ULTRA adds open positions (tokens bought but not yet sold). |
| `madeonsol_kol_timing` | KOL entry/exit timing profile — available on all tiers |

### Deployer Hunter

| Tool | Description |
|---|---|
| `madeonsol_deployer_alerts` | Pump.fun deployer launches with KOL enrichment. Filter by tier (elite/good/moderate/rising/cold). ULTRA unlocks full pagination. |
| `madeonsol_deployer_trajectory` | Deployer skill curve — streaks, rolling bond rate, trend — available on all tiers |

### Deshred Sniper Alerts *(new in 1.10 — Pro/Ultra)*

Pre-confirm pump.fun deploy feed reconstructed from shred-level (**deshred**) data — launches surface **~500ms before they confirm on-chain**. Pro sees elite/good deployers; Ultra sees every tier.

| Tool | Description |
|---|---|
| `madeonsol_sniper_recent` | Newest-first deshred deploy feed. Pro: elite/good · Ultra: all tiers. `watchlist: true` (Ultra) narrows to your custom deployer watchlist |
| `madeonsol_sniper_by_deployer` | Deshred deploys for a single deployer wallet (Ultra) |

### Wallet Tracker

| Tool | Description |
|---|---|
| `madeonsol_wallet_tracker_watchlist` | List your tracked wallets and remaining capacity (Free: 10, Pro: 50, Ultra: 100) |
| `madeonsol_wallet_tracker_add` | Add a wallet to your watchlist |
| `madeonsol_wallet_tracker_remove` | Remove a wallet from your watchlist |
| `madeonsol_wallet_tracker_trades` | Historical swap/transfer events for watched wallets (120-day retention) |
| `madeonsol_wallet_tracker_summary` | Per-wallet stats: swap counts, SOL bought/sold, last event |

### Universal Wallet *(new in 1.8 — any wallet, not just curated KOLs, PRO+)*

| Tool | Description |
|---|---|
| `madeonsol_wallet_stats` | Aggregate 90d stats + cross-product flags (is_kol, is_alpha_tracked + bot_confidence + win_rate + net_pnl, is_deployer + tokens_deployed) — quick sizing-up of an unknown wallet |
| `madeonsol_wallet_pnl` | Full FIFO cost-basis PnL: realized + unrealized SOL, profit factor, max drawdown, avg + median hold minutes, daily UTC PnL curve, closed + open positions hydrated with live mc-tracker prices |
| `madeonsol_wallet_positions` | Open positions only — lighter slice of /pnl. Shares the same cache. |
| `madeonsol_wallet_trades` | Cursor-paginated raw trades with action / token / since-until filters |

Cached server-side with dynamic TTL (5min / 1h / 24h based on last activity). Cost basis observable only inside the 90-day window.

### Alpha Wallet Intelligence

Scored from 1M+ early-buyer records (wallets seen in the first 20 buyers of Pump.fun tokens).

| Tool | Tier | Description |
|---|---|---|
| `madeonsol_alpha_leaderboard` | All | Top profitable early-buyer wallets. Up to 100 on Free/Pro; ULTRA unlocks 500 + bot signals |
| `madeonsol_alpha_wallet` | ULTRA | Full per-token breakdown + bot_signals array |
| `madeonsol_alpha_linked` | ULTRA | Wallets behaviorally linked (co-bought 3+ tokens within 2s) |

### Token Quality

| Tool | Tier | Description |
|---|---|---|
| `madeonsol_tokens_list` | PRO+ | Filtered, sortable token directory — MC band, liquidity floor, primary DEX, authority/safety flags, computed 1h volume / MEV-share / MC-change deltas. Default `min_liq=2000` skips phantom-MC dust. |
| `madeonsol_token_cap_table` | PRO+ | First non-deployer early buyers, enriched with PnL/KOL/bot flags. PRO=10, ULTRA=20 |
| `madeonsol_token_buyer_quality` | All | 0–100 buyer-quality score + full breakdown (5-min cached) |
| `madeonsol_token_risk` | PRO+ | Transparent 0–100 rug-risk/safety score with `band`, explainable `factors[]`, and raw `inputs` |

### Copy-Trade Rules (PRO/ULTRA)

Server-side rules that fire signals when a watched source wallet trades. Delivered via webhook (HMAC-signed) and/or WebSocket.

| Tool | Description |
|---|---|
| `madeonsol_copytrade_list` | List your rules |
| `madeonsol_copytrade_create` | Create a rule. Returns `webhook_secret` once — store it |
| `madeonsol_copytrade_get` | Get one rule |
| `madeonsol_copytrade_update` | Update fields or toggle `is_active` |
| `madeonsol_copytrade_delete` | Delete permanently |
| `madeonsol_copytrade_signals` | Recent fired signals (up to 7 days) |

### KOL Coordination Alerts (PRO/ULTRA — v1.1 push signals)

Real-time push alerts when a KOL cluster co-buys the same token. Fires within ~1s (pg_notify push). Delivered via WebSocket (`kol:coordination` channel, user-scoped) and/or HMAC-signed webhook.

| Tool | Description |
|---|---|
| `madeonsol_coordination_alerts_list` | List your rules (PRO=5, ULTRA=20) |
| `madeonsol_coordination_alerts_create` | Create a rule. Returns `webhook_secret` once — store it |
| `madeonsol_coordination_alerts_get` | Get one rule |
| `madeonsol_coordination_alerts_update` | Update fields or toggle `is_active` |
| `madeonsol_coordination_alerts_delete` | Delete permanently |

### KOL Scout Signal — first KOL touches *(new in 1.3)*

Every "first KOL buy on a token mint" event. Filterable by **scout tier** (S/A/B/C from `mv_kol_scout_score`), KOL winrate, token age, mint suffix.

**Backtest:** S-tier scouts attract ≥3 follow-on KOLs within 4h ~50% of the time vs ~14% baseline (38d / 491k buys / 72,549 events). Public leaderboard at [madeonsol.com/kol/scouts](https://madeonsol.com/kol/scouts).

| Tool | Description |
|---|---|
| `madeonsol_kol_first_touches` | Recent first-KOL-touch events. Filters: `min_scout_tier`, `min_kol_winrate_7d`, `token_age_max_min`, `mint_suffix`, `preset`, etc. |
| `madeonsol_first_touch_subscriptions_list` | List your first-touch webhook subscriptions — ULTRA |
| `madeonsol_first_touch_subscriptions_create` | Create a webhook rule (HMAC-signed). Returns `webhook_secret` once — store it. Up to 10/user — ULTRA |
| `madeonsol_first_touch_subscriptions_get` | Get one subscription — ULTRA |
| `madeonsol_first_touch_subscriptions_update` | Update fields or toggle `is_active` — ULTRA |
| `madeonsol_first_touch_subscriptions_delete` | Delete permanently — ULTRA |

> **Don't poll — push.** Median lead time before the second KOL is 12 seconds. WebSocket channel: `kol:first_touches` (PRO+).

### Price Alerts *(new in 1.9)*

CRUD for token dip/recovery price alerts. Fires when a token's market cap crosses your threshold. PRO=5 rules, ULTRA=25.

| Tool | Description |
|---|---|
| `madeonsol_price_alerts_list` | List your price alert rules |
| `madeonsol_price_alerts_create` | Create a dip/recovery alert. Returns `webhook_secret` once — store it |
| `madeonsol_price_alerts_get` | Get one alert rule by ID |
| `madeonsol_price_alerts_update` | Update fields or toggle `is_active` |
| `madeonsol_price_alerts_delete` | Delete permanently |

### Scout Leaderboard & KOL Consensus *(new in 1.9)*

| Tool | Tier | Description |
|---|---|---|
| `madeonsol_scout_leaderboard` | PRO+ | Top scout-tier KOLs ranked by first-touch follow-on rate, win rate, and ROI |
| `madeonsol_kol_consensus` | PRO+ | Tokens with the strongest KOL agreement signal — weighted by scout score and recent PnL |
| `madeonsol_peak_history` | PRO+ | Historical peak-density windows for a token — every coordination spike with KOL breakdown |
| `madeonsol_coordination_history` | PRO+ | Global coordination event log with token, KOL count, score, and outcome |

### Wallet Derived Stats *(new in 1.9)*

`madeonsol_wallet_stats` now returns a `stats` object with derived fields: `win_rate` (0-1), `roi`, `verdict` ("strong" | "profitable" | "neutral" | "losing"), and `biggest_miss` (token with the highest post-exit gain the wallet missed).

### Streaming & Webhooks

| Tool | Description |
|---|---|
| `madeonsol_stream_token` | Get a 24h WebSocket token for KOL/deployer streaming and DEX trade stream — PRO/ULTRA |
| `madeonsol_create_webhook` | Register a webhook for real-time push notifications — PRO/ULTRA |
| `madeonsol_list_webhooks` | List your registered webhooks — PRO/ULTRA |
| `madeonsol_delete_webhook` | Delete a webhook by ID — PRO/ULTRA |
| `madeonsol_test_webhook` | Send a test payload to verify a webhook — PRO/ULTRA |

### General

| Tool | Description |
|---|---|
| `madeonsol_discovery` | List all endpoints and prices (free, no auth) |
| `madeonsol_me` | Inspect your account — tier, daily/burst quota state, remaining requests, subscription expiry, per-feature usage (webhooks, copy-trade wallets, coordination rules, etc.). Self-throttle without parsing rate-limit headers. |

## Tiers

| Tier | Price | Wallets tracked | Requests/day |
|------|-------|-----------------|--------------|
| BASIC (free) | $0 | 10 | 200 |
| PRO | $49/mo ($490/yr) | 50 | 10,000 |
| ULTRA | $149/mo ($1,490/yr) | 100 + WS events | 100,000 |

Free tier returns the full REST response shape on every endpoint — real wallets, TX signatures, full precision. Paid tiers unlock webhooks, WebSockets, rule engines, and ULTRA-only data depth. Get a key at [madeonsol.com/pricing](https://madeonsol.com/pricing).

## Also Available

| Platform | Package |
|---|---|
| TypeScript SDK | [`madeonsol`](https://www.npmjs.com/package/madeonsol) on npm |
| Rust SDK | [`madeonsol`](https://crates.io/crates/madeonsol) on crates.io |
| Python (LangChain, CrewAI) | [`madeonsol-x402`](https://pypi.org/project/madeonsol-x402/) on PyPI |
| ElizaOS | [`@madeonsol/plugin-madeonsol`](https://www.npmjs.com/package/@madeonsol/plugin-madeonsol) |
| Solana Agent Kit | [`solana-agent-kit-plugin-madeonsol`](https://www.npmjs.com/package/solana-agent-kit-plugin-madeonsol) |

## License

MIT
