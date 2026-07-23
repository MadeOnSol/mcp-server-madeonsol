# mcp-server-madeonsol

[![npm version](https://img.shields.io/npm/v/mcp-server-madeonsol?style=flat-square)](https://www.npmjs.com/package/mcp-server-madeonsol)
[![npm downloads](https://img.shields.io/npm/dm/mcp-server-madeonsol?style=flat-square)](https://www.npmjs.com/package/mcp-server-madeonsol)
[![Smithery](https://img.shields.io/badge/Smithery-listed-blueviolet?style=flat-square)](https://smithery.ai/servers/madeonsol/solana-kol-intelligence)
[![Glama](https://glama.ai/mcp/servers/madeonsol/mcp-server-madeonsol/badges/score.svg)](https://glama.ai/mcp/servers/madeonsol/mcp-server-madeonsol)
[![MCP](https://img.shields.io/badge/MCP-compatible-blueviolet?style=flat-square)](https://modelcontextprotocol.io/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue?style=flat-square)](LICENSE)

> ⚡ **[Install via Smithery](#install-via-smithery-one-line)** · 🤖 **[Use in Claude Desktop](#claude-desktop)** · 🖱️ **[Use in Cursor](#cursor)** · 📚 **[API docs](https://madeonsol.com/api-docs)** · 💰 **[Free API key](https://madeonsol.com/pricing)** · 🔎 **[On Glama](https://glama.ai/mcp/servers/madeonsol/mcp-server-madeonsol)**

MCP server for [MadeOnSol](https://madeonsol.com) Solana KOL intelligence API. Use from Claude Desktop, Cursor, or any MCP-compatible client.

> Real-time Solana trading intelligence: track 1,069 KOL wallets with <3s latency, score 23,000+ Pump.fun deployers, surface deshred deploy signals **~500ms before on-chain confirmation**, detect multi-KOL coordination, surface bundle-cohort holdings (which same-slot wallets still hold a token's supply), verify any wallet's CURRENT on-chain holdings straight from its token accounts, and stream every DEX trade across 9+ programs. Free tier: 200 requests/day, every endpoint — no signup payment. Get a key at [madeonsol.com/pricing](https://madeonsol.com/pricing).

> **New in 1.20.0** — **Token depth / price impact + deployer self-activity on risk.** New tool `madeonsol_token_depth` (`GET /tokens/{mint}/depth`) — per-pool price-impact / slippage: "how much SOL moves this token's price N%", per pool (NOT router-optimal). Pass up to 8 SOL buy `sizes` (each >0 and ≤10000; default `[0.5, 1, 5, 10]`); every computable pool returns `spot_price_sol`, `fee_pct`, a `quotes[]` entry per size (`size_sol`, `tokens_out`, `avg_price_sol`, `price_impact_pct`), and `to_move_price` — the SOL required to move price **1% / 5% / 10%**. Constant-product AMMs are served from stream reserves (`source: "stream"` with `reserves_age_ms`); pump.fun/bonk bonding curves from a **live** read of the curve's virtual reserves (`source: "live_rpc"`). Pools that can't be priced honestly — concentrated CLMM/Orca/DLMM, Meteora-DBC curves, unclassified models — come back in `unsupported_pools[]` with a `reason` (e.g. `concentrated_liquidity_depth_not_supported`, `curve_graduated_use_amm_pool`) instead of a wrong number; `primary_pool` names the deepest computable pool, `found: false` means no pools tracked. PRO/ULTRA only. And `madeonsol_token_risk` now returns a top-level **`dev` block** (deployer self-activity; `null` when the mint has no deployer-pipeline row): the create-tx self-buy snapshot (`buy_sol`, `buy_tokens`, `buy_supply_pct`), the post-create rollup (`bought_tokens_after` — catches the same-second-separate-tx dev buy the create snapshot reads as 0 — `sold_tokens`, `sold_sol`, `first_sell_at`/`last_sell_at`), **live on-chain holdings** (`holdings_tokens`, `holdings_supply_pct` — pump.fun 1B denominator, null elsewhere — `wallet_empty`: is the dev wallet empty NOW), and `transferred_out` (tokens left without a sell; `null` = unknown, never a guess), plus `as_of`. `deployer:alert` webhook/WS payloads gain `dev_buy_sol` + `dev_buy_supply_pct`.
>
> **New in 1.19.0** — **Batch wallet classification + token trade tape + bigger keyless catalog.** New tool `madeonsol_wallet_batch_classify` — reputation flags for 1–100 wallets in one call (counts as one request): per wallet `is_sniper` / `is_bundler` / `is_dumper` / `is_kol` (+ `kol_name`), `bot_confidence` (string enum `none`/`low`/`medium`/`high`, `null` when not alpha-tracked), and a `dump_cluster` block (`dump_cohorts`, `runner_cohorts`, `total_cohorts`, `as_of`). Flags are pump.fun-pipeline scoped — `false` = not observed, NOT verified clean; `is_bundler` is lifetime, `is_dumper` is a rolling 42d window. New tool `madeonsol_token_trades` — mint-scoped cursor-paginated trade tape (the backfill complement to the live firehose): `tx_signature`, `wallet_address`, `action`, `sol_amount`, `token_amount`, `price_sol`/`price_usd`, `early_buyer_rank`, `slot`, `block_time`, `traded_at`; filters `action` / `wallet` / `since`–`until` (default FULL history — capture starts 2026-04-12), plus a `coverage` honesty block. Both PRO/ULTRA. `madeonsol_wallet_stats` flags gain `is_sniper`/`is_bundler`/`is_dumper` + `dump_cluster`, and `bot_confidence` is now correctly typed as a string enum (it was documented as a number and always came back `null` due to a server bug — now returns real values). `madeonsol_token_risk` inputs and `madeonsol_sniper_recent` deploys gain the slot-window `sniper_footprint`/`footprint` rollup (`buys`, `buyers`, `sol`, `supply_pct`, `sniper_wallet_buys`, `data_available`, `as_of` — `null` = not observable, not zero). The **keyless x402 catalog grows 18 → 25 endpoints**: token candles ($0.01), almost-bonded ($0.01), top-traders ($0.02), cap-table ($0.02), sniper recent ($0.01), token flow ($0.01), deployer trajectory ($0.01) — `madeonsol_sniper_recent` and `madeonsol_deployer_trajectory` now work keyless via x402 too.
>
> **New in 1.18.0** — **Verified on-chain wallet holdings.** New tool `madeonsol_wallet_holdings` — the wallet's CURRENT holdings read straight from chain: its actual SPL + Token-2022 token accounts and SOL balance, each enriched with our `price_usd` / `value_usd` / `market_cap_usd` / `name` / `symbol` / `is_bonded`, plus `transfer_delta` (on-chain amount − trade-derived net position — exposes non-swap flows like airdrops, insider funding, and wallet-hopping). Distinct from `madeonsol_wallet_positions` (trade-derived FIFO): this is what the wallet *actually* holds right now. Params: `limit` (1–500, default 200), `min_value_usd` (default 0). Returns `{ address, sol_balance, holdings[], summary, verified_at, trade_window_days, cache_hit, ttl_seconds }`. ULTRA only.
>
> **New in 1.17.0** — **Bundle-cohort holdings.** New tool `madeonsol_token_bundle` — which same-slot "bundle" wallets bought a token and how much of supply they *still* hold (the incumbents' "current held %" rug/insider signal, from confirmed on-chain data). Returns a `bundle` block (`wallet_count`, `bundle_kind` atomic_tx/same_slot/none, `held_ratio`, `held_pct_of_supply` — the headline, net held / circulating supply, null if unknown — `fully_exited`, `buy_volume`, `tokens_held`) plus a `wallets[]` array (`rank`, `wallet`, `held_ratio`, `has_sold`, `atomic`, `is_kol`). BASIC get the bundle block only (empty `wallets[]`); PRO adds top-10 flags-only wallets; ULTRA returns the full cohort with enriched identities (`kol_name`, `win_rate`, `bot_confidence`, `tokens_held`).
>
> **New in 1.16.0** — **Batch risk scoring + live stream-session control.** New tool `madeonsol_tokens_batch_risk` — bulk rug-risk/safety scoring for up to 50 mints in one call, returning the same per-mint shape as `madeonsol_token_risk` (0–100 score, `band`, explainable `factors[]`, raw `inputs`) plus an `as_of` timestamp; untracked mints come back as `{ mint, error: "not_tracked" }` without failing the batch, and the whole call counts as one request against quota. Plus two WebSocket session tools: `madeonsol_stream_sessions_list` (list your live sessions — `id`, `service`, `tier`, `channels`, `connected_at`, `remote_ip`, `messages_sent`) and `madeonsol_stream_session_kill` (force-disconnect a session by id to free its connection slot, e.g. a ghost socket). PRO/ULTRA only.
>
> **New in 1.15.0** — **Almost-bonded discovery + trending sorts.** New tool `madeonsol_almost_bonded` — pre-bond pump.fun tokens near graduation, ranked by velocity (Δprogress/min): "95% and accelerating" beats "92% stalled". Each token carries `progress_pct`, `velocity_pct_per_min`, `eta_minutes`, `stalled`, `real_sol_reserves`, `market_cap_usd`, `liquidity_usd`, `authorities_revoked`, `deployer_tier`, and `age_minutes`. Params: `min_progress`, `max_progress`, `min_velocity_pct_per_min`, `max_age_minutes`, `deployer_tier`, `authority_revoked`, `min_liq`, `sort` (velocity_desc / progress_desc / eta_asc), `limit`. PRO/ULTRA only. Plus `madeonsol_tokens_list` gains four momentum sorts — `mc_change_5m_desc`, `mc_change_1h_desc`, `volume_1h_desc`, and `trending` (composite recent-volume × positive-momentum rank).
>
> **New in 1.14.0** — **Token trade flow.** New tool `madeonsol_token_flow` — a trade-flow aggregate (organic-vs-fake volume) over a `1h`/`24h` window: `unique_wallets` / `unique_buyers` / `unique_sellers`, `buy_count` / `sell_count` / `total_trades`, `buy_sol` / `sell_sol` / `net_sol` (sell − buy; positive = net SOL leaving the pool), and `trades_per_wallet` (wash-trading proxy). PRO/ULTRA only. Deployer alerts (`madeonsol_deployer_alerts`) now carry `deployers.deployer_sol_balance` — the deployer wallet's SOL balance at alert time (null for historical rows).
>
> **New in 1.13.0** — **Token OHLCV candles.** New tool `madeonsol_token_candles` — historical price candles (1m/5m/15m/1h/4h/1d) aggregated from the on-chain trade firehose. Each candle has `t/open/high/low/close/volume_usd/trades/market_cap_usd`. PRO returns OHLCV for the last 30 days; ULTRA adds buy/sell volume + count splits, net flow, MEV volume, open/close liquidity, high/low MC, and full history. PRO/ULTRA only.
>
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

## AI agent quickstart (x402 / pay-per-call)

Building an autonomous agent? Skip the signup. Point a **funded Solana wallet** at the server and every tool call **auto-pays a micropayment** over [x402](https://x402.org) — no API key, no account, no rate-limit dance.

```json
{
  "mcpServers": {
    "madeonsol": {
      "command": "mcp-server-madeonsol",
      "env": {
        "SVM_PRIVATE_KEY": "<base58 solana private key>"
      }
    }
  }
}
```

How it works:

- The wallet behind `SVM_PRIVATE_KEY` settles each request as a **USDC micropayment on Solana** (~$0.005–$0.02 per call, settled on-chain). No subscription, no quota.
- The keyless catalog covers **25 endpoints** — the latest additions: token candles ($0.01), almost-bonded ($0.01), top-traders ($0.02), cap-table ($0.02), sniper recent deploys ($0.01), token flow ($0.01), and deployer trajectory ($0.01).
- The free **`madeonsol_discovery`** tool needs no auth and returns every endpoint with its exact per-call price — call it first to see what each tool costs.
- Install the x402 peer deps alongside the server (only required for this mode):

  ```bash
  npm install -g mcp-server-madeonsol @x402/fetch @x402/svm @x402/core @solana/kit @scure/base
  ```

> **Data only.** MadeOnSol returns trading *intelligence* — it never trades, signs swaps, or takes custody of funds. The only thing your wallet ever pays for is the per-call data fee.

Prefer a fixed monthly bill, free tier, or no wallet? Use the developer path below.

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
| `madeonsol_deployer_alerts` | Pump.fun deployer launches with KOL enrichment. Filter by tier (elite/good/moderate/rising/cold). ULTRA unlocks full pagination. Each alert's `deployers` now includes `deployer_sol_balance` — the deployer wallet's SOL balance at alert time (null for historical rows). |
| `madeonsol_deployer_trajectory` | Deployer skill curve — streaks, rolling bond rate, trend — available on all tiers |
| `madeonsol_deployer_history` | A pump.fun deployer's daily reputation time-series (`bonding_rate`, `recent_bond_rate`, `tier`, `avg_peak_mc` per day) — backtest deployer signals at launch time without look-ahead bias. `limit` 1–365 (default 90) |

### Deshred Sniper Alerts *(new in 1.10 — Pro/Ultra)*

Pre-confirm pump.fun deploy feed reconstructed from shred-level (**deshred**) data — launches surface **~500ms before they confirm on-chain**. Pro sees elite/good deployers; Ultra sees every tier.

| Tool | Description |
|---|---|
| `madeonsol_sniper_recent` | Newest-first deshred deploy feed. Pro: elite/good · Ultra: all tiers · keyless x402: $0.01 (elite/good). `watchlist: true` (Ultra) narrows to your custom deployer watchlist. **New 1.19:** each deploy carries `footprint` — the slot-window snipe rollup (`buys`, `buyers`, `sol`, `supply_pct`, `sniper_wallet_buys`, `data_available`, `as_of`) or `null` when not yet settled/observable |
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
| `madeonsol_wallet_stats` | Aggregate 90d stats + cross-product flags (is_kol, is_alpha_tracked + bot_confidence `none`/`low`/`medium`/`high`, is_deployer + tokens_deployed, **new 1.19:** is_sniper / is_bundler / is_dumper + `dump_cluster` cohorts) — quick sizing-up of an unknown wallet |
| `madeonsol_wallet_batch_classify` | **New 1.19** · Bulk reputation flags for 1–100 wallets in one call — is_sniper/is_bundler/is_dumper/is_kol + kol_name, bot_confidence, dump_cluster. Pump.fun-pipeline scoped: `false` = not observed, not verified clean |
| `madeonsol_wallet_pnl` | Full FIFO cost-basis PnL: realized + unrealized SOL, profit factor, max drawdown, avg + median hold minutes, daily UTC PnL curve, closed + open positions hydrated with live mc-tracker prices |
| `madeonsol_wallet_positions` | Open positions only — lighter slice of /pnl. Shares the same cache. |
| `madeonsol_wallet_holdings` | **New 1.18** · Verified CURRENT on-chain holdings (real SPL + Token-2022 accounts + SOL) enriched with price/MC/name, plus `transfer_delta` vs trade-derived position. ULTRA only. |
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
| `madeonsol_tokens_list` | PRO+ | Filtered, sortable token directory — MC band, liquidity floor, primary DEX, authority/safety flags, computed 1h volume / MEV-share / MC-change deltas, plus momentum sorts (`mc_change_5m_desc`, `mc_change_1h_desc`, `volume_1h_desc`, `trending`). Default `min_liq=2000` skips phantom-MC dust. |
| `madeonsol_almost_bonded` | PRO+ | Pre-bond pump.fun tokens near graduation, ranked by velocity (Δprogress/min) — `progress_pct`, `velocity_pct_per_min`, `eta_minutes`, `stalled`, `deployer_tier`, `age_minutes` |
| `madeonsol_token_cap_table` | PRO+ | First non-deployer early buyers, enriched with PnL/KOL/bot flags. PRO=10, ULTRA=20 |
| `madeonsol_token_buyer_quality` | All | 0–100 buyer-quality score + full breakdown (5-min cached) |
| `madeonsol_token_risk` | PRO+ | Transparent 0–100 rug-risk/safety score with `band`, explainable `factors[]`, and raw `inputs` (**new 1.19:** `inputs.sniper_footprint` — slot-window snipe rollup, `null` = not observable; **new 1.20:** top-level `dev` block — deployer self-buy at create, sells rollup, live on-chain holdings, `wallet_empty`, `transferred_out`) |
| `madeonsol_token_bundle` | All | Bundle-cohort holdings — which same-slot bundle wallets bought a token and how much of supply they still hold (`held_pct_of_supply` headline, plus `bundle_kind`, `held_ratio`, `fully_exited`). BASIC: bundle block only. PRO: top-10 flags. ULTRA: full cohort + identities |
| `madeonsol_token_pools` | PRO+ | Per-venue liquidity map — every DEX pool a token trades in (pump.fun/PumpSwap/Raydium/Meteora/Orca) with per-pool `liquidity_usd`, `is_active` (live vs parked), plus a `summary` (pool/DEX counts, `total_liquidity_usd`, `primary_pool`, `top_pool_share_pct` concentration) |
| `madeonsol_token_depth` | **New 1.20** · PRO+ | Per-pool price impact / slippage — `quotes[]` per SOL buy size (`tokens_out`, `avg_price_sol`, `price_impact_pct`) + `to_move_price` (SOL to move price 1%/5%/10%). `sizes` max 8, default `[0.5, 1, 5, 10]`; unsupported pools (CLMM/DLMM/DBC) flagged with a `reason` |
| `madeonsol_tokens_batch_risk` | PRO+ | Bulk rug-risk/safety scoring for up to 50 mints — same shape as `madeonsol_token_risk` + `as_of`. Untracked mints return `{ mint, error: "not_tracked" }` without failing the batch; counts as one request |
| `madeonsol_token_candles` | PRO+ | Historical OHLCV candles (1m–1d). PRO=OHLCV 30d; ULTRA=+net flow, liquidity delta, MEV volume, full history |
| `madeonsol_token_flow` | PRO+ | Trade-flow aggregate (organic-vs-fake volume) over a 1h/24h `window` — unique wallets/buyers/sellers, buy/sell counts + SOL, `net_sol`, `trades_per_wallet` wash-trading proxy |
| `madeonsol_token_trades` | **New 1.19** · PRO+ | Mint-scoped trade tape — cursor-paginated raw trades for one token (action / wallet / since–until filters, default FULL history). History starts 2026-04-12; `coverage` block marks scope |

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
| `madeonsol_stream_sessions_list` | List your live WebSocket sessions — `id`, `service`, `tier`, `channels`, `connected_at`, `remote_ip`, `messages_sent` — PRO/ULTRA |
| `madeonsol_stream_session_kill` | Evict a live WebSocket session by id to free its connection slot (e.g. a ghost socket) — PRO/ULTRA |
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
| PRO | €43/mo (€430/yr) ≈ $49 | 50 | 10,000 |
| ULTRA | €131/mo (€1310/yr) ≈ $149 | 100 + WS events | 100,000 |

Free tier returns the full REST response shape on every endpoint — real wallets, TX signatures, full precision. Paid tiers unlock webhooks, WebSockets, rule engines, and ULTRA-only data depth. Get a key at [madeonsol.com/pricing](https://madeonsol.com/pricing).

New customers get a 3-day free trial of Pro or Ultra when you pay by card — full access, nothing charged during the trial, cancel anytime. Start at https://madeonsol.com/pricing

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
