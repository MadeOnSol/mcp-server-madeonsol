#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const BASE_URL = process.env.MADEONSOL_API_URL || "https://madeonsol.com";
const MADEONSOL_API_KEY = process.env.MADEONSOL_API_KEY; // Native key from madeonsol.com/pricing
const PRIVATE_KEY = process.env.SVM_PRIVATE_KEY; // x402 micropayments (for AI agents)
const PORT = parseInt(process.env.PORT || "3100", 10);
const MODE = process.env.MCP_TRANSPORT || "stdio"; // "stdio" or "http"

// Auth mode: MADEONSOL_API_KEY > SVM_PRIVATE_KEY (x402)
type AuthMode = "madeonsol" | "x402" | "none";
let authMode: AuthMode = "none";
let paidFetch: typeof fetch = fetch;

function apiKeyHeaders(): Record<string, string> {
  if (authMode === "madeonsol") {
    return { Authorization: `Bearer ${MADEONSOL_API_KEY}` };
  }
  return {};
}

async function initAuth() {
  if (MADEONSOL_API_KEY) {
    authMode = "madeonsol";
    console.error("[madeonsol-mcp] Using MadeOnSol API key (Bearer auth)");
    return;
  }
  if (PRIVATE_KEY) {
    try {
      const { wrapFetchWithPayment } = await import("@x402/fetch");
      const { x402Client } = await import("@x402/core/client");
      const { ExactSvmScheme } = await import("@x402/svm/exact/client");
      const { createKeyPairSignerFromBytes } = await import("@solana/kit");
      const { base58 } = await import("@scure/base");

      const signer = await createKeyPairSignerFromBytes(base58.decode(PRIVATE_KEY));
      const client = new x402Client();
      client.register("solana:*", new ExactSvmScheme(signer));
      paidFetch = wrapFetchWithPayment(fetch, client);
      authMode = "x402";
      console.error(`[madeonsol-mcp] x402 payments enabled, wallet: ${signer.address}`);
      return;
    } catch (err) {
      console.error("[madeonsol-mcp] x402 setup failed:", err);
    }
  }
  console.error(
    "\n[madeonsol-mcp] No auth configured — every tool call will fail.\n" +
    "  → Get a free MADEONSOL_API_KEY (200 req/day, no card) at https://madeonsol.com/pricing\n" +
    "  → Or set SVM_PRIVATE_KEY for x402 micropayments.\n",
  );
}

async function query(path: string, params?: Record<string, string | number>) {
  // API key uses /api/v1/ endpoints; x402 uses /api/x402/
  const apiPath = authMode === "x402" || authMode === "none"
    ? path
    : path.replace("/api/x402/", "/api/v1/");
  const url = new URL(apiPath, BASE_URL);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
  }
  const headers = apiKeyHeaders();
  const res = authMode === "x402"
    ? await paidFetch(url.toString())
    : await fetch(url.toString(), { headers });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return `Error ${res.status}: ${body}`;
  }
  return JSON.stringify(await res.json(), null, 2);
}

function registerTools(server: McpServer) {
  const readOnlyAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

  server.tool(
    "madeonsol_kol_feed",
    "Get real-time Solana KOL trades from 1,000+ tracked wallets. Each trade includes the token's market cap (USD) at the moment of trade — sourced from our in-memory price tracker, accurate to the millisecond, faster than Dexscreener spot. PRO+ adds size/age/strategy/winrate filters.",
    {
      limit: z.number().min(1).max(100).default(10).describe("Number of trades to return (1-100)"),
      before: z.string().optional().describe("Cursor — ISO 8601 timestamp; returns trades strictly older than this. Pass next_before from the previous response for polling."),
      action: z.enum(["buy", "sell"]).optional().describe("Filter by trade type: buy or sell"),
      kol: z.string().optional().describe("Filter by specific KOL wallet address (base58)"),
      min_sol: z.number().optional().describe("PRO+: minimum SOL size per trade"),
      token_age_max_min: z.number().optional().describe("PRO+: max token age in minutes at time of trade"),
      exclude_sells: z.boolean().optional().describe("PRO+: drop sell-side trades"),
      min_kol_winrate: z.number().optional().describe("PRO+: minimum 7d winrate of the KOL (0-100)"),
      strategy: z.enum(["scalper", "day_trader", "swing_trader", "hodler", "mixed"]).optional().describe("PRO+: filter by auto-tagged strategy"),
    },
    readOnlyAnnotations,
    async ({ limit, before, action, kol, min_sol, token_age_max_min, exclude_sells, min_kol_winrate, strategy }) => {
      const params: Record<string, string | number> = { limit };
      if (before) params.before = before;
      if (action) params.action = action;
      if (kol) params.kol = kol;
      if (min_sol !== undefined) params.min_sol = min_sol;
      if (token_age_max_min !== undefined) params.token_age_max_min = token_age_max_min;
      if (exclude_sells) params.exclude_sells = "true";
      if (min_kol_winrate !== undefined) params.min_kol_winrate = min_kol_winrate;
      if (strategy) params.strategy = strategy;
      return { content: [{ type: "text" as const, text: await query("/api/x402/kol/feed", params) }] };
    }
  );

  server.tool(
    "madeonsol_kol_coordination",
    "KOL convergence signals (v1.2) — tokens being accumulated by multiple KOLs. Response includes peak_kols/peak_buys (busiest window slice), exited_count (net-flow-negative wallets), 0-100 coordination_score, and (v1.2 / 2026-05-06) market_cap_usd_at_first_buy + market_cap_usd + last_price_usd so you can see whether the cluster formed at micro-cap or after the chart was already running. Blacklist filters WIF/BONK/stables by default.",
    {
      period: z.enum(["1h", "6h", "24h", "7d"]).default("24h").describe("Time period for coordination analysis"),
      min_kols: z.number().min(2).max(50).default(3).describe("Minimum number of KOLs converging on the same token"),
      limit: z.number().min(1).max(50).default(20).describe("Number of coordination signals to return"),
      min_avg_winrate: z.number().optional().describe("PRO+: require cluster avg winrate_7d >= N (0-100)"),
      unique_strategies: z.number().optional().describe("PRO+: require >= N distinct strategies in cluster"),
      include_majors: z.boolean().optional().describe("v1.1: include major memecoins (WIF/BONK/POPCAT). Default false."),
      window_minutes: z.number().min(1).max(60).optional().describe("v1.1: peak-density window (1-60). Default 15."),
      min_score: z.number().min(0).max(100).optional().describe("v1.1: minimum composite coordination_score (0-100)."),
    },
    readOnlyAnnotations,
    async ({ period, min_kols, limit, min_avg_winrate, unique_strategies, include_majors, window_minutes, min_score }) => {
      const params: Record<string, string | number> = { period, min_kols, limit };
      if (min_avg_winrate !== undefined) params.min_avg_winrate = min_avg_winrate;
      if (unique_strategies !== undefined) params.unique_strategies = unique_strategies;
      if (include_majors !== undefined) params.include_majors = include_majors ? "true" : "false";
      if (window_minutes !== undefined) params.window_minutes = window_minutes;
      if (min_score !== undefined) params.min_score = min_score;
      return { content: [{ type: "text" as const, text: await query("/api/x402/kol/coordination", params) }] };
    }
  );

  server.tool(
    "madeonsol_kol_leaderboard",
    "Get KOL performance rankings by PnL and win rate. PRO+ can sort by alternative axes (winrate/roi/profit_factor/early_entry).",
    {
      period: z.enum(["today", "7d", "30d", "90d", "180d"]).default("7d").describe("Time period (trade retention is 180d)"),
      limit: z.number().min(1).max(50).default(20).describe("Number of KOLs to return in ranking"),
      sort: z.enum(["pnl", "winrate", "profit_factor", "roi", "early_entry"]).optional().describe("PRO+: sort axis (default 'pnl')"),
      strategy: z.enum(["sniper", "flipper", "swinger", "holder", "mixed"]).optional().describe("PRO+: filter by strategy tag"),
      min_winrate: z.number().optional().describe("PRO+: minimum winrate cutoff (0-100)"),
    },
    readOnlyAnnotations,
    async ({ period, limit, sort, strategy, min_winrate }) => {
      const params: Record<string, string | number> = { period, limit };
      if (sort) params.sort = sort;
      if (strategy) params.strategy = strategy;
      if (min_winrate !== undefined) params.min_winrate = min_winrate;
      return { content: [{ type: "text" as const, text: await query("/api/x402/kol/leaderboard", params) }] };
    }
  );

  server.tool(
    "madeonsol_deployer_alerts",
    "Get real-time alerts from Pump.fun deployers with KOL buy enrichment. Filters: deployer tier, alert_type, priority, and min_kol_buys to gate out noise. Cursor-paginated via 'before' (preferred over 'offset' at scale).",
    {
      limit: z.number().min(1).max(100).default(10).describe("Number of deployer alerts to return (1-100)"),
      offset: z.number().min(0).default(0).describe("Legacy offset pagination (prefer 'before' for polling)"),
      before: z.string().optional().describe("Cursor — ISO 8601 timestamp; returns alerts strictly older than this. Pass next_before from the previous response."),
      since: z.string().optional().describe("Only alerts after this ISO 8601 timestamp."),
      tier: z.enum(["elite", "good", "moderate", "rising", "cold"]).optional().describe("Filter by deployer tier. PRO/ULTRA only — BASIC callers receive HTTP 403."),
      alert_type: z.string().optional().describe("Filter by alert_type (e.g. 'new_deploy', 'bonded')."),
      priority: z.enum(["high", "medium", "low"]).optional().describe("Filter by alert priority."),
      min_kol_buys: z.number().min(1).max(100).optional().describe("Only alerts where at least N KOLs bought the token (1-100)."),
    },
    readOnlyAnnotations,
    async ({ limit, offset, before, since, tier, alert_type, priority, min_kol_buys }) => {
      const params: Record<string, string | number> = { limit, offset };
      if (before) params.before = before;
      if (since) params.since = since;
      if (tier) params.tier = tier;
      if (alert_type) params.alert_type = alert_type;
      if (priority) params.priority = priority;
      if (min_kol_buys !== undefined) params.min_kol_buys = min_kol_buys;
      return { content: [{ type: "text" as const, text: await query("/api/x402/deployer-hunter/alerts", params) }] };
    }
  );

  server.tool(
    "madeonsol_kol_pairs",
    "KOL affinity matrix — discover which KOLs frequently co-trade the same tokens within a time window.",
    {
      period: z.enum(["7d", "30d"]).default("7d").describe("Time period: 7d or 30d"),
      min_shared: z.number().min(1).max(20).default(3).describe("Minimum number of shared tokens to qualify as a pair"),
      limit: z.number().min(1).max(50).default(20).describe("Number of KOL pairs to return"),
    },
    readOnlyAnnotations,
    async ({ period, min_shared, limit }) => ({
      content: [{ type: "text" as const, text: await query("/api/x402/kol/pairs", { period, min_shared, limit }) }],
    })
  );

  server.tool(
    "madeonsol_kol_timing",
    "KOL entry/exit timing profile — hold duration, exit speed, and activity patterns for a specific KOL.",
    {
      wallet: z.string().describe("KOL wallet address (base58)"),
      period: z.enum(["7d", "30d"]).default("30d").describe("Time period: 7d or 30d"),
    },
    readOnlyAnnotations,
    async ({ wallet, period }) => {
      if (authMode === "madeonsol") {
        const headers: Record<string, string> = { ...apiKeyHeaders() };
        const res = await fetch(`${BASE_URL}/api/v1/kol/${wallet}/timing?period=${period}`, { headers });
        if (!res.ok) { const body = await res.text().catch(() => ""); return { content: [{ type: "text" as const, text: `Error ${res.status}: ${body}` }] }; }
        return { content: [{ type: "text" as const, text: JSON.stringify(await res.json(), null, 2) }] };
      }
      return { content: [{ type: "text" as const, text: "KOL timing requires MADEONSOL_API_KEY (msk_) — get one free at madeonsol.com/pricing." }] };
    }
  );

  server.tool(
    "madeonsol_deployer_trajectory",
    "Deployer skill curve — streaks, rolling bond rate, improvement trend, and deployment cadence for a Pump.fun deployer.",
    {
      wallet: z.string().describe("Deployer wallet address (base58)"),
    },
    readOnlyAnnotations,
    async ({ wallet }) => {
      if (authMode === "madeonsol") {
        const headers: Record<string, string> = { ...apiKeyHeaders() };
        const res = await fetch(`${BASE_URL}/api/v1/deployer-hunter/${wallet}/trajectory`, { headers });
        if (!res.ok) { const body = await res.text().catch(() => ""); return { content: [{ type: "text" as const, text: `Error ${res.status}: ${body}` }] }; }
        return { content: [{ type: "text" as const, text: JSON.stringify(await res.json(), null, 2) }] };
      }
      return { content: [{ type: "text" as const, text: "Deployer trajectory requires MADEONSOL_API_KEY (msk_, Pro/Ultra) — get one at madeonsol.com/pricing." }] };
    }
  );

  server.tool(
    "madeonsol_kol_hot_tokens",
    "KOL momentum tokens — tokens with accelerating KOL buy interest, early signals before coordination triggers. PRO+ adds buyer-quality filters.",
    {
      period: z.enum(["1h", "6h"]).default("6h").describe("Time period: 1h or 6h"),
      min_kols: z.number().min(1).max(20).default(1).describe("Minimum KOL buyers to include a token"),
      limit: z.number().min(1).max(50).default(20).describe("Number of hot tokens to return"),
      min_avg_winrate: z.number().optional().describe("PRO+: require avg winrate_7d of buyers >= N (0-100)"),
      unique_strategies: z.number().optional().describe("PRO+: require >= N distinct strategies among buyers"),
    },
    readOnlyAnnotations,
    async ({ period, min_kols, limit, min_avg_winrate, unique_strategies }) => {
      const params: Record<string, string | number> = { period, min_kols, limit };
      if (min_avg_winrate !== undefined) params.min_avg_winrate = min_avg_winrate;
      if (unique_strategies !== undefined) params.unique_strategies = unique_strategies;
      return { content: [{ type: "text" as const, text: await query("/api/x402/kol/tokens/hot", params) }] };
    }
  );

  server.tool(
    "madeonsol_kol_token_entry_order",
    "Ranked KOL first-buyers for a specific token, ordered by entry timestamp. PRO+ adds percentile_pnl_7d per entry.",
    {
      mint: z.string().describe("Token mint address (base58)"),
      limit: z.number().min(1).max(200).default(50).describe("Max ranked entries to return"),
    },
    readOnlyAnnotations,
    async ({ mint, limit }) => ({
      content: [{ type: "text" as const, text: await query(`/api/x402/kol/tokens/${encodeURIComponent(mint)}/entry-order`, { limit }) }],
    })
  );

  server.tool(
    "madeonsol_kol_compare_wallets",
    "Side-by-side comparison of 2-5 KOL wallets — strategy, winrates, ROI, percentile. PRO+ adds 30d overlap tokens (bought by 2+ of the wallets).",
    {
      wallets: z.array(z.string()).min(2).max(5).describe("2-5 wallet addresses. BASIC=2, PRO=4, ULTRA=5."),
    },
    readOnlyAnnotations,
    async ({ wallets }) => ({
      content: [{ type: "text" as const, text: await query("/api/x402/kol/compare", { wallets: wallets.join(",") }) }],
    })
  );

  server.tool(
    "madeonsol_kol_alerts_recent",
    "Live KOL alert feed — consensus clusters, fresh-token KOL buys, and heating-up wallets in one unified stream.",
    {
      window: z.enum(["5m", "15m", "1h", "6h", "24h"]).default("15m").describe("Lookback window"),
      types: z.array(z.enum(["consensus_cluster", "fresh_token_kol_buy", "heating_up"])).optional().describe("Filter to specific alert types"),
      min_severity: z.enum(["low", "medium", "high"]).optional().describe("Minimum severity to include"),
      limit: z.number().min(1).max(200).default(50).describe("Max alerts to return"),
    },
    readOnlyAnnotations,
    async ({ window, types, min_severity, limit }) => {
      const params: Record<string, string | number> = { window, limit };
      if (types && types.length > 0) params.types = types.join(",");
      if (min_severity) params.min_severity = min_severity;
      return { content: [{ type: "text" as const, text: await query("/api/x402/kol/alerts/recent", params) }] };
    }
  );

  server.tool(
    "madeonsol_kol_pnl",
    "Deep per-wallet PnL breakdown — realized PnL, win rate, profit factor, max drawdown, daily equity curve, closed/open positions. BASIC: summary only. PRO: + curve + closed. ULTRA: + open positions.",
    {
      wallet: z.string().describe("KOL wallet address (base58)"),
      period: z.enum(["7d", "30d", "90d", "180d"]).default("30d").describe("Time period for PnL calculation"),
    },
    readOnlyAnnotations,
    async ({ wallet, period }) => {
      if (authMode === "madeonsol") {
        const headers: Record<string, string> = { ...apiKeyHeaders() };
        const res = await fetch(`${BASE_URL}/api/v1/kol/${wallet}/pnl?period=${period}`, { headers });
        if (!res.ok) { const body = await res.text().catch(() => ""); return { content: [{ type: "text" as const, text: `Error ${res.status}: ${body}` }] }; }
        return { content: [{ type: "text" as const, text: JSON.stringify(await res.json(), null, 2) }] };
      }
      return { content: [{ type: "text" as const, text: "KOL PnL requires MADEONSOL_API_KEY (msk_) — get one free at madeonsol.com/pricing." }] };
    }
  );

  server.tool(
    "madeonsol_kol_trending_tokens",
    "Tokens ranked by KOL buy volume — pure capital-flow signal. Sub-hour periods (5m/15m/30m) require PRO/ULTRA.",
    {
      period: z.enum(["5m", "15m", "30m", "1h", "2h", "4h", "12h"]).default("1h").describe("Time window"),
      min_kols: z.number().min(1).max(20).default(1).describe("Minimum KOL buyers"),
      limit: z.number().min(1).max(50).default(20).describe("Number of trending tokens to return"),
    },
    readOnlyAnnotations,
    async ({ period, min_kols, limit }) => ({
      content: [{ type: "text" as const, text: await query("/api/x402/kol/tokens/trending", { period, min_kols, limit }) }],
    })
  );

  server.tool(
    "madeonsol_discovery",
    "List all available MadeOnSol API endpoints with prices and parameter docs. Free, no auth required.",
    {},
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async () => {
      const res = await fetch(new URL("/api/x402", BASE_URL).toString());
      const data = await res.json();
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ── Wallet Tracker tools (REST auth only — all mutating operations) ──
  {
    const hasRestAuth = authMode === "madeonsol";
    async function walletTrackerRequest(method: string, path: string, body?: unknown): Promise<string> {
      const headers: Record<string, string> = { "Content-Type": "application/json", ...apiKeyHeaders() };
      const res = await fetch(`${BASE_URL}/api/v1${path}`, {
        method,
        headers,
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        return `Error ${res.status}: ${text}`;
      }
      return JSON.stringify(await res.json(), null, 2);
    }

    if (hasRestAuth) {
      server.tool(
        "madeonsol_wallet_tracker_watchlist",
        "List your tracked wallets with labels and remaining watchlist capacity. BASIC=10, PRO=50, ULTRA=100.",
        {},
        { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
        async () => ({
          content: [{ type: "text" as const, text: await walletTrackerRequest("GET", "/wallet-tracker/watchlist") }],
        })
      );

      server.tool(
        "madeonsol_wallet_tracker_add",
        "Add a Solana wallet to your watchlist. Returns 409 if already tracked or limit reached.",
        {
          wallet_address: z.string().describe("Solana wallet address (base58) to track"),
          label: z.string().optional().describe("Optional human-readable label for this wallet"),
        },
        { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
        async ({ wallet_address, label }) => {
          const body: Record<string, unknown> = { wallet_address };
          if (label) body.label = label;
          return { content: [{ type: "text" as const, text: await walletTrackerRequest("POST", "/wallet-tracker/watchlist", body) }] };
        }
      );

      server.tool(
        "madeonsol_wallet_tracker_remove",
        "Remove a wallet from your watchlist.",
        {
          wallet_address: z.string().describe("Solana wallet address to remove from watchlist"),
        },
        { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
        async ({ wallet_address }) => ({
          content: [{ type: "text" as const, text: await walletTrackerRequest("DELETE", `/wallet-tracker/watchlist/${encodeURIComponent(wallet_address)}`) }],
        })
      );

      server.tool(
        "madeonsol_wallet_tracker_trades",
        "Historical swap and transfer events for all your watched wallets. BASIC: truncated wallets, no tx_signature.",
        {
          wallet: z.string().optional().describe("Filter to a specific wallet address"),
          action: z.enum(["buy", "sell", "transfer_in", "transfer_out"]).optional().describe("Filter by action type"),
          event_type: z.enum(["swap", "transfer"]).optional().describe("Filter by event type: swap (token trade) or transfer (SOL moved)"),
          limit: z.number().min(1).max(200).default(50).describe("Max results (1–200)"),
          before: z.number().optional().describe("Pagination cursor: block_time of the last event from previous page"),
        },
        { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
        async ({ wallet, action, event_type, limit, before }) => {
          const params: Record<string, string | number> = { limit };
          if (wallet) params.wallet = wallet;
          if (action) params.action = action;
          if (event_type) params.event_type = event_type;
          if (before !== undefined) params.before = before;
          const url = new URL(`${BASE_URL}/api/v1/wallet-tracker/trades`);
          for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
          const res = await fetch(url.toString(), { headers: { "Content-Type": "application/json", ...apiKeyHeaders() } });
          const text = res.ok ? JSON.stringify(await res.json(), null, 2) : `Error ${res.status}: ${await res.text().catch(() => "")}`;
          return { content: [{ type: "text" as const, text }] };
        }
      );

      server.tool(
        "madeonsol_wallet_tracker_summary",
        "Per-wallet stats: swap counts, SOL bought/sold, and last activity time across your watchlist.",
        {
          period: z.enum(["24h", "7d", "30d"]).default("7d").describe("Time window for stats"),
          wallet: z.string().optional().describe("Filter to a specific wallet address"),
        },
        { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
        async ({ period, wallet }) => {
          const url = new URL(`${BASE_URL}/api/v1/wallet-tracker/summary`);
          url.searchParams.set("period", period);
          if (wallet) url.searchParams.set("wallet", wallet);
          const res = await fetch(url.toString(), { headers: { "Content-Type": "application/json", ...apiKeyHeaders() } });
          const text = res.ok ? JSON.stringify(await res.json(), null, 2) : `Error ${res.status}: ${await res.text().catch(() => "")}`;
          return { content: [{ type: "text" as const, text }] };
        }
      );

      // ── Universal wallet endpoints (PRO+, any wallet — not just curated KOLs) ──

      server.tool(
        "madeonsol_wallet_stats",
        "Aggregate stats for any Solana wallet over the last 90 days plus cross-product flags (is_kol, is_alpha_tracked with bot_confidence + win_rate + net_pnl, is_deployer with tokens_deployed + bonding_rate). Use this before drilling into PnL to size up an unknown wallet quickly. PRO+.",
        {
          address: z.string().describe("Solana wallet address (base58)"),
        },
        { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
        async ({ address }) => {
          const res = await fetch(`${BASE_URL}/api/v1/wallet/${encodeURIComponent(address)}`, {
            headers: { "Content-Type": "application/json", ...apiKeyHeaders() },
          });
          const text = res.ok ? JSON.stringify(await res.json(), null, 2) : `Error ${res.status}: ${await res.text().catch(() => "")}`;
          return { content: [{ type: "text" as const, text }] };
        }
      );

      server.tool(
        "madeonsol_wallet_pnl",
        "Full FIFO cost-basis PnL for any wallet: realized + unrealized SOL, profit factor, max drawdown, avg + median hold minutes, daily UTC PnL curve, closed positions sorted by pnl desc (with ROI %, hold time, win/loss), and open positions hydrated with live current prices from the market-cap tracker. Cached with dynamic TTL (5min active / 1h recent / 24h dormant). Cache hits don't count against your daily quota. Cost basis only observable inside the 90-day data window — overflow sells are silently discarded rather than fabricated. PRO+.",
        {
          address: z.string().describe("Solana wallet address (base58)"),
        },
        { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
        async ({ address }) => {
          const res = await fetch(`${BASE_URL}/api/v1/wallet/${encodeURIComponent(address)}/pnl`, {
            headers: { "Content-Type": "application/json", ...apiKeyHeaders() },
          });
          const text = res.ok ? JSON.stringify(await res.json(), null, 2) : `Error ${res.status}: ${await res.text().catch(() => "")}`;
          return { content: [{ type: "text" as const, text }] };
        }
      );

      server.tool(
        "madeonsol_wallet_positions",
        "Open positions only for any wallet — lighter slice of madeonsol_wallet_pnl for use cases that don't need the full PnL summary or curve. Each position: token_mint, token_amount, cost_basis_sol, avg_entry_price_sol, current_price_sol (live from mc-tracker; null if delisted), current_value_sol, unrealized_sol, unrealized_pct, first_buy_at. Shares the /pnl cache. PRO+.",
        {
          address: z.string().describe("Solana wallet address (base58)"),
        },
        { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
        async ({ address }) => {
          const res = await fetch(`${BASE_URL}/api/v1/wallet/${encodeURIComponent(address)}/positions`, {
            headers: { "Content-Type": "application/json", ...apiKeyHeaders() },
          });
          const text = res.ok ? JSON.stringify(await res.json(), null, 2) : `Error ${res.status}: ${await res.text().catch(() => "")}`;
          return { content: [{ type: "text" as const, text }] };
        }
      );

      server.tool(
        "madeonsol_wallet_trades",
        "Cursor-paginated raw trades for any wallet. Filter by action (buy/sell), specific token_mint, time window via since/until (Unix seconds; default last 90 days). Cursor encodes (block_time, id) for stable DESC pagination — pass next_cursor from the previous response to fetch older trades. Limit 1-500 (default 100). PRO+.",
        {
          address: z.string().describe("Solana wallet address (base58)"),
          limit: z.number().min(1).max(500).default(100).describe("Trades per page (1-500)"),
          cursor: z.string().optional().describe("Cursor from previous response's next_cursor field"),
          action: z.enum(["buy", "sell"]).optional().describe("Filter to buys or sells only"),
          token_mint: z.string().optional().describe("Filter to a single token mint"),
          since: z.number().optional().describe("Unix epoch seconds — default now-90d"),
          until: z.number().optional().describe("Unix epoch seconds — default now"),
        },
        { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
        async ({ address, limit, cursor, action, token_mint, since, until }) => {
          const url = new URL(`${BASE_URL}/api/v1/wallet/${encodeURIComponent(address)}/trades`);
          url.searchParams.set("limit", String(limit));
          if (cursor)     url.searchParams.set("cursor", cursor);
          if (action)     url.searchParams.set("action", action);
          if (token_mint) url.searchParams.set("token_mint", token_mint);
          if (since !== undefined) url.searchParams.set("since", String(since));
          if (until !== undefined) url.searchParams.set("until", String(until));
          const res = await fetch(url.toString(), { headers: { "Content-Type": "application/json", ...apiKeyHeaders() } });
          const text = res.ok ? JSON.stringify(await res.json(), null, 2) : `Error ${res.status}: ${await res.text().catch(() => "")}`;
          return { content: [{ type: "text" as const, text }] };
        }
      );

      console.error("[madeonsol-mcp] Wallet tracker tools enabled");
      console.error("[madeonsol-mcp] Universal wallet tools enabled (stats / pnl / positions / trades)");
    } else {
      console.error("[madeonsol-mcp] Wallet tracker tools disabled (requires MADEONSOL_API_KEY)");
    }
  }

  // ── Webhook & Streaming tools (require MadeOnSol API key — Pro/Ultra tier) ──

  const hasRestAuth = authMode === "madeonsol";
  if (hasRestAuth) {
    async function restQuery(method: string, path: string, body?: unknown): Promise<string> {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        ...apiKeyHeaders(),
      };
      const res = await fetch(`${BASE_URL}/api/v1${path}`, {
        method,
        headers,
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        return `Error ${res.status}: ${text}`;
      }
      return JSON.stringify(await res.json(), null, 2);
    }

    const webhookAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };

    server.tool(
      "madeonsol_create_webhook",
      "Register a webhook URL to receive real-time push notifications for KOL trades and deployer alerts. Requires Pro/Ultra subscription.",
      {
        url: z.string().url().describe("HTTPS webhook URL to receive events"),
        events: z.array(z.enum(["kol:trade", "kol:coordination", "deployer:alert", "deployer:bond"])).min(1).describe("Event types to subscribe to"),
        min_sol: z.number().optional().describe("Optional: minimum SOL amount filter (for kol:trade)"),
        action: z.enum(["buy", "sell"]).optional().describe("Optional: filter by buy or sell only"),
        deployer_tier: z.array(z.string()).optional().describe("Optional: filter by deployer tiers, e.g. ['elite', 'good']"),
      },
      webhookAnnotations,
      async ({ url, events, min_sol, action, deployer_tier }) => {
        const filters: Record<string, unknown> = {};
        if (min_sol) filters.min_sol = min_sol;
        if (action) filters.action = action;
        if (deployer_tier) filters.deployer_tier = deployer_tier;
        return { content: [{ type: "text" as const, text: await restQuery("POST", "/webhooks", { url, events, filters }) }] };
      }
    );

    server.tool(
      "madeonsol_list_webhooks",
      "List all your registered webhooks with delivery status and failure counts.",
      {},
      { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      async () => ({
        content: [{ type: "text" as const, text: await restQuery("GET", "/webhooks") }],
      })
    );

    server.tool(
      "madeonsol_delete_webhook",
      "Delete a webhook by ID. Permanently removes the webhook and its delivery history.",
      {
        id: z.number().describe("Webhook ID to delete"),
      },
      { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
      async ({ id }) => ({
        content: [{ type: "text" as const, text: await restQuery("DELETE", `/webhooks/${id}`) }],
      })
    );

    server.tool(
      "madeonsol_test_webhook",
      "Send a sample event payload to a webhook URL to verify it works. Returns status code and response time.",
      {
        webhook_id: z.number().describe("ID of the webhook to test"),
      },
      { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      async ({ webhook_id }) => ({
        content: [{ type: "text" as const, text: await restQuery("POST", "/webhooks/test", { webhook_id }) }],
      })
    );

    server.tool(
      "madeonsol_stream_token",
      "Generate a 24h WebSocket streaming token. Includes ws_url for KOL/deployer streaming (Pro/Ultra) and dex_ws_url for all-DEX trade streaming (Ultra only).",
      {},
      { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      async () => ({
        content: [{ type: "text" as const, text: await restQuery("POST", "/stream/token") }],
      })
    );

    // ── Account / quota introspection ──

    server.tool(
      "madeonsol_me",
      "Inspect your MadeOnSol API account — current tier, daily/burst quota state, remaining requests, subscription expiry, and per-feature usage (webhooks, copy-trade wallets, coordination rules, etc.). Use to self-throttle without parsing rate-limit headers.",
      {},
      { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      async () => ({
        content: [{ type: "text" as const, text: await restQuery("GET", "/me") }],
      })
    );

    // ── Token directory (PRO+) ──

    server.tool(
      "madeonsol_tokens_list",
      "Filtered, sortable token directory. Browse all tracked Solana tokens by market-cap band, liquidity floor, recent-activity window, primary DEX, authority/safety flags, and computed 1h volume / MEV-share / MC-change deltas. Default min_liq=2000 skips phantom-MC dust (low-liquidity pools producing absurd VWAP×supply products) — pass min_liq=0 to opt out. Computed filters (min_volume_1h_usd, max_mev_share_pct, mc_change_1h_min_pct, mc_change_1h_max_pct) over-fetch and post-filter — pagination.post_filtered=true on the response means page size may be < limit. PRO+ only.",
      {
        min_mc: z.number().optional().describe("Minimum market cap in USD"),
        max_mc: z.number().optional().describe("Maximum market cap in USD"),
        min_liq: z.number().optional().describe("Minimum quote-side liquidity in USD (default 2000 — pass 0 to opt out of phantom-MC filter)"),
        active_h: z.number().optional().describe("Only tokens with a trade in the last N hours"),
        primary_dex: z.enum(["pumpfun", "pumpswap", "raydium", "meteora", "orca", "raydium_clmm"]).optional().describe("Filter by primary DEX"),
        authority_revoked: z.boolean().optional().describe("Only tokens whose mint+freeze authority is revoked"),
        exclude_token2022: z.boolean().optional().describe("Exclude Token-2022 mints (transfer-fee / hook risk)"),
        min_lp_burnt_pct: z.number().optional().describe("Minimum % of LP supply burned (0-100)"),
        min_volume_1h_usd: z.number().optional().describe("Minimum trailing 1h volume in USD (post-filter — may shrink page size)"),
        max_mev_share_pct: z.number().optional().describe("Maximum MEV-share % of 1h volume (post-filter)"),
        mc_change_1h_min_pct: z.number().optional().describe("Minimum 1h MC change % (post-filter; negative allowed)"),
        mc_change_1h_max_pct: z.number().optional().describe("Maximum 1h MC change % (post-filter)"),
        sort: z.enum(["mc_desc", "mc_asc", "last_trade_desc", "liquidity_desc", "cumulative_volume_desc"]).optional().describe("Sort axis (default mc_desc)"),
        limit: z.number().min(1).max(100).optional().describe("Page size (max 100)"),
        offset: z.number().min(0).optional().describe("Pagination offset"),
      },
      { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      async (args) => {
        const url = new URL(`${BASE_URL}/api/v1/tokens`);
        for (const [k, v] of Object.entries(args)) {
          if (v !== undefined) url.searchParams.set(k, typeof v === "boolean" ? (v ? "true" : "false") : String(v));
        }
        const res = await fetch(url.toString(), { headers: { "Content-Type": "application/json", ...apiKeyHeaders() } });
        const text = res.ok ? JSON.stringify(await res.json(), null, 2) : `Error ${res.status}: ${await res.text().catch(() => "")}`;
        return { content: [{ type: "text" as const, text }] };
      }
    );

    // ── Alpha wallet intelligence ──

    server.tool(
      "madeonsol_alpha_leaderboard",
      "Top statistically profitable early-buyer wallets, scored from 47,000+ early-buyer records. BASIC=25 (truncated), PRO=100, ULTRA=500 + bot signals.",
      {
        period: z.enum(["7d", "30d", "all"]).default("30d").describe("Time window"),
        min_tokens: z.number().min(1).max(20).default(5).describe("Minimum tokens traded by wallet (1-20)"),
        sort: z.enum(["win_rate", "pnl", "roi"]).default("win_rate").describe("Sort axis"),
        exclude_bots: z.boolean().default(true).describe("Exclude wallets flagged as bots"),
      },
      { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      async ({ period, min_tokens, sort, exclude_bots }) => {
        const params: Record<string, string | number> = { period, min_tokens, sort, exclude_bots: exclude_bots ? "true" : "false" };
        const url = new URL(`${BASE_URL}/api/v1/alpha/leaderboard`);
        for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
        const res = await fetch(url.toString(), { headers: { "Content-Type": "application/json", ...apiKeyHeaders() } });
        const text = res.ok ? JSON.stringify(await res.json(), null, 2) : `Error ${res.status}: ${await res.text().catch(() => "")}`;
        return { content: [{ type: "text" as const, text }] };
      }
    );

    server.tool(
      "madeonsol_alpha_wallet",
      "Full alpha profile for one wallet — per-token breakdown + bot_signals array. ULTRA only.",
      { wallet: z.string().describe("Wallet address (base58)") },
      { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      async ({ wallet }) => ({
        content: [{ type: "text" as const, text: await restQuery("GET", `/alpha/${encodeURIComponent(wallet)}`) }],
      })
    );

    server.tool(
      "madeonsol_alpha_linked",
      "Wallets behaviorally linked to a target wallet (co-bought 3+ tokens within 2 seconds). ULTRA only.",
      { wallet: z.string().describe("Wallet address (base58)") },
      { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      async ({ wallet }) => ({
        content: [{ type: "text" as const, text: await restQuery("GET", `/alpha/${encodeURIComponent(wallet)}/linked`) }],
      })
    );

    // ── Token quality ──

    server.tool(
      "madeonsol_token_cap_table",
      "First non-deployer early buyers for a token, enriched with PnL, KOL identity, and bot flags. PRO=top 10 (truncated wallets), ULTRA=top 20 (full). BASIC: 403.",
      { mint: z.string().describe("Token mint address (base58)") },
      { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      async ({ mint }) => ({
        content: [{ type: "text" as const, text: await restQuery("GET", `/tokens/${encodeURIComponent(mint)}/cap-table`) }],
      })
    );

    server.tool(
      "madeonsol_token_buyer_quality",
      "0–100 buyer-quality score for a token's first-buyer cohort. 5-min cached. BASIC: score+signal only. PRO/ULTRA: full breakdown.",
      { mint: z.string().describe("Token mint address (base58)") },
      { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      async ({ mint }) => ({
        content: [{ type: "text" as const, text: await restQuery("GET", `/tokens/${encodeURIComponent(mint)}/buyer-quality`) }],
      })
    );

    server.tool(
      "madeonsol_tokens_batch_buyer_quality",
      "Bulk buyer-quality scoring for up to 50 mints in one call. Shares the 5-min LRU cache with the single-mint endpoint — already-warm mints return at ~zero cost. Response includes cache_hits counter.",
      { mints: z.array(z.string()).min(1).max(50).describe("1–50 base58 Solana token mints") },
      { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      async ({ mints }) => ({
        content: [{ type: "text" as const, text: await restQuery("POST", "/tokens/batch/buyer-quality", { mints }) }],
      })
    );

    // ── Token intelligence (/token/{mint} + batch) ──

    server.tool(
      "madeonsol_token_get",
      "Comprehensive per-mint snapshot: price (VWAP), market cap, 24h volume, deployer reputation, KOL smart-money activity, first_seen_at + age_seconds, and blacklist status — all in one call. ULTRA adds individual KOL wallet addresses in top_buyers[].",
      { mint: z.string().describe("Token mint address (base58)") },
      { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      async ({ mint }) => ({
        content: [{ type: "text" as const, text: await restQuery("GET", `/token/${encodeURIComponent(mint)}`) }],
      })
    );

    server.tool(
      "madeonsol_token_batch",
      "Bulk lookup of up to 50 mints in one request. Returns the same per-mint shape as madeonsol_token_get. DB queries batched with IN(...); dex-stream + RPC fan-outs run in parallel. ~10-20× cheaper than N sequential calls — ideal for sniper pipelines scoring many tokens at once.",
      { mints: z.array(z.string()).min(1).max(50).describe("1–50 base58 Solana token mints") },
      { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      async ({ mints }) => ({
        content: [{ type: "text" as const, text: await restQuery("POST", "/token/batch", { mints }) }],
      })
    );

    // ── Copy-Trade rules (PRO/ULTRA) ──

    server.tool(
      "madeonsol_copytrade_list",
      "List your copy-trade rules. PRO=3 rules, ULTRA=20 rules.",
      {},
      { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      async () => ({
        content: [{ type: "text" as const, text: await restQuery("GET", "/copytrade/subscriptions") }],
      })
    );

    server.tool(
      "madeonsol_copytrade_create",
      "Create a copy-trade rule. Returns webhook_secret ONCE on creation when delivery_mode includes 'webhook' — store it to verify HMAC signatures. PRO=5 source_wallets/rule, ULTRA=50.",
      {
        source_wallets: z.array(z.string()).min(1).max(50).describe("Wallets to mirror (base58)"),
        sizing_amount: z.number().describe("Amount used by the chosen sizing_mode"),
        name: z.string().optional().describe("Optional human label"),
        min_trade_sol: z.number().optional().describe("Minimum source-wallet trade size to fire a signal"),
        only_action: z.enum(["buy", "sell", "both"]).optional().describe("Filter to one side (default 'both')"),
        sizing_mode: z.enum(["fixed", "proportional", "percent_source"]).optional().describe("How sizing_amount is interpreted"),
        delivery_mode: z.enum(["webhook", "websocket", "both"]).optional().describe("Where to deliver fired signals"),
        webhook_url: z.string().url().optional().describe("Required when delivery_mode includes 'webhook'"),
      },
      { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      async (args) => {
        const body: Record<string, unknown> = { source_wallets: args.source_wallets, sizing_amount: args.sizing_amount };
        for (const k of ["name", "min_trade_sol", "only_action", "sizing_mode", "delivery_mode", "webhook_url"] as const) {
          if (args[k] !== undefined) body[k] = args[k];
        }
        return { content: [{ type: "text" as const, text: await restQuery("POST", "/copytrade/subscriptions", body) }] };
      }
    );

    server.tool(
      "madeonsol_copytrade_get",
      "Get one copy-trade rule by id.",
      { id: z.number().describe("Subscription id") },
      { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      async ({ id }) => ({
        content: [{ type: "text" as const, text: await restQuery("GET", `/copytrade/subscriptions/${id}`) }],
      })
    );

    server.tool(
      "madeonsol_copytrade_update",
      "Update fields on a copy-trade rule, including is_active toggle.",
      {
        id: z.number().describe("Subscription id"),
        name: z.string().nullable().optional(),
        source_wallets: z.array(z.string()).optional(),
        min_trade_sol: z.number().optional(),
        only_action: z.enum(["buy", "sell", "both"]).optional(),
        sizing_mode: z.enum(["fixed", "proportional", "percent_source"]).optional(),
        sizing_amount: z.number().optional(),
        delivery_mode: z.enum(["webhook", "websocket", "both"]).optional(),
        webhook_url: z.string().url().nullable().optional(),
        is_active: z.boolean().optional(),
      },
      { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      async ({ id, ...patch }) => {
        const body: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(patch)) {
          if (v !== undefined) body[k] = v;
        }
        return { content: [{ type: "text" as const, text: await restQuery("PATCH", `/copytrade/subscriptions/${id}`, body) }] };
      }
    );

    server.tool(
      "madeonsol_copytrade_delete",
      "Delete a copy-trade rule permanently.",
      { id: z.number().describe("Subscription id") },
      { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
      async ({ id }) => ({
        content: [{ type: "text" as const, text: await restQuery("DELETE", `/copytrade/subscriptions/${id}`) }],
      })
    );

    server.tool(
      "madeonsol_copytrade_signals",
      "Recent fired copy-trade signals (up to 7 days). Filter by subscription_id, since (ISO8601), and limit (1–500).",
      {
        subscription_id: z.number().optional().describe("Filter to one rule"),
        since: z.string().optional().describe("ISO8601 timestamp — only signals fired at-or-after this time"),
        limit: z.number().min(1).max(500).default(50).describe("Max signals to return (1–500)"),
      },
      { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      async ({ subscription_id, since, limit }) => {
        const url = new URL(`${BASE_URL}/api/v1/copytrade/signals`);
        url.searchParams.set("limit", String(limit));
        if (subscription_id !== undefined) url.searchParams.set("subscription_id", String(subscription_id));
        if (since) url.searchParams.set("since", since);
        const res = await fetch(url.toString(), { headers: { "Content-Type": "application/json", ...apiKeyHeaders() } });
        const text = res.ok ? JSON.stringify(await res.json(), null, 2) : `Error ${res.status}: ${await res.text().catch(() => "")}`;
        return { content: [{ type: "text" as const, text }] };
      }
    );

    // ── Coordination alerts (PRO/ULTRA, v1.1) ──

    server.tool(
      "madeonsol_coordination_alerts_list",
      "List your coordination alert rules. PRO=5 rules, ULTRA=20.",
      {},
      { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      async () => ({
        content: [{ type: "text" as const, text: await restQuery("GET", "/kol/coordination/alerts") }],
      })
    );

    server.tool(
      "madeonsol_coordination_alerts_create",
      "Create a coordination alert rule. Fires within ~1s when a KOL cluster meets thresholds (peak-density scored). Delivered via WebSocket (kol:coordination channel) and/or HMAC-signed webhook. Returns webhook_secret ONCE when delivery_mode includes 'webhook' — store it.",
      {
        name: z.string().optional().describe("Optional label"),
        min_kols: z.number().min(2).max(50).optional().describe("Minimum distinct KOLs in the window (default 3)"),
        window_minutes: z.number().min(1).max(60).optional().describe("Peak-density window size in minutes (default 15)"),
        min_score: z.number().min(0).max(100).optional().describe("Minimum composite score 0-100 (default 60)"),
        include_majors: z.boolean().optional().describe("Include WIF/BONK/POPCAT etc. Default false."),
        cooldown_min: z.number().min(1).optional().describe("Silence per (rule, token) in minutes (default 60)"),
        score_jump_break: z.number().min(1).max(100).optional().describe("Re-fire early when score jumps by N points vs last fire (default 10)"),
        delivery_mode: z.enum(["websocket", "webhook", "both"]).optional().describe("Where to deliver fires"),
        webhook_url: z.string().url().optional().describe("Required when delivery_mode includes 'webhook'"),
      },
      { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      async (args) => {
        const body: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(args)) if (v !== undefined) body[k] = v;
        return { content: [{ type: "text" as const, text: await restQuery("POST", "/kol/coordination/alerts", body) }] };
      }
    );

    server.tool(
      "madeonsol_coordination_alerts_get",
      "Get one coordination alert rule by id.",
      { id: z.string().describe("Rule UUID") },
      { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      async ({ id }) => ({
        content: [{ type: "text" as const, text: await restQuery("GET", `/kol/coordination/alerts/${encodeURIComponent(id)}`) }],
      })
    );

    server.tool(
      "madeonsol_coordination_alerts_update",
      "Update fields on a coordination alert rule, including is_active toggle.",
      {
        id: z.string().describe("Rule UUID"),
        name: z.string().nullable().optional(),
        min_kols: z.number().min(2).max(50).optional(),
        window_minutes: z.number().min(1).max(60).optional(),
        min_score: z.number().min(0).max(100).optional(),
        include_majors: z.boolean().optional(),
        cooldown_min: z.number().min(1).optional(),
        score_jump_break: z.number().min(1).max(100).optional(),
        delivery_mode: z.enum(["websocket", "webhook", "both"]).optional(),
        webhook_url: z.string().url().nullable().optional(),
        is_active: z.boolean().optional(),
      },
      { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      async ({ id, ...patch }) => {
        const body: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(patch)) if (v !== undefined) body[k] = v;
        return { content: [{ type: "text" as const, text: await restQuery("PATCH", `/kol/coordination/alerts/${encodeURIComponent(id)}`, body) }] };
      }
    );

    server.tool(
      "madeonsol_coordination_alerts_delete",
      "Delete a coordination alert rule permanently.",
      { id: z.string().describe("Rule UUID") },
      { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
      async ({ id }) => ({
        content: [{ type: "text" as const, text: await restQuery("DELETE", `/kol/coordination/alerts/${encodeURIComponent(id)}`) }],
      })
    );

    // ── First-touch signal (read tool + ULTRA webhook subscriptions CRUD) ──

    server.tool(
      "madeonsol_kol_first_touches",
      "Recent first-KOL-touch events — every time a tracked KOL was the first to buy a token mint. Filterable by scout tier (S/A/B/C from mv_kol_scout_score), KOL winrate, token age, etc. Backtest: top scouts attract ≥3 follow-on KOLs within 4h ~50% of the time vs ~14% baseline. Median lead time before second KOL is 12s — for trading this signal, use the WebSocket channel rather than polling.",
      {
        limit: z.number().min(1).max(100).optional().describe("Number of events to return (1-100, default 50)"),
        since: z.string().optional().describe("ISO timestamp — events strictly newer than this. Polling cursor."),
        before: z.string().optional().describe("ISO timestamp — events strictly older than this. Pagination cursor."),
        kol: z.string().optional().describe("Filter to a single KOL wallet address (base58)"),
        min_kol_winrate_7d: z.number().min(0).max(100).optional().describe("Minimum 7d winrate of the first-touch KOL (0-100)"),
        min_scout_tier: z.enum(["S", "A", "B", "C"]).optional().describe("Restrict to first-touch KOLs of this scout tier or better. Requires n_first_touches_30d >= 30."),
        min_n_touches: z.number().min(1).optional().describe("Lower the minimum sample size for scout scoring (default 30)"),
        strategy: z.enum(["scalper", "day_trader", "swing_trader", "hodler", "mixed"]).optional().describe("Filter by first-touch KOL's auto-tagged strategy"),
        token_age_max_min: z.number().min(1).optional().describe("Only events on tokens younger than N minutes (uses token_first_seen)"),
        min_first_buy_sol: z.number().min(0).optional().describe("Minimum size of the first KOL buy in SOL"),
        mint_suffix: z.string().optional().describe("Suffix-filter the token mint (e.g. 'pump', 'bonk')"),
        preset: z.enum(["scout", "fresh_launch"]).optional().describe("Shortcut filter: 'scout' = min_scout_tier=B + min_n_touches=30 + token_age_max_min=60. 'fresh_launch' = token_age_max_min=15."),
        include: z.string().optional().describe("Comma-separated includes — currently 'followers_4h' (computed for events >=4h old)"),
      },
      { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      async (args) => {
        const params: Record<string, string | number> = {};
        for (const [k, v] of Object.entries(args)) if (v !== undefined) params[k] = v as string | number;
        return { content: [{ type: "text" as const, text: await restQuery("GET", `/kol/first-touches?${new URLSearchParams(params as Record<string, string>).toString()}`) }] };
      }
    );

    server.tool(
      "madeonsol_first_touch_subscriptions_list",
      "List your first-touch webhook subscriptions. ULTRA only.",
      {},
      { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      async () => ({
        content: [{ type: "text" as const, text: await restQuery("GET", "/kol/first-touches/subscriptions") }],
      })
    );

    server.tool(
      "madeonsol_first_touch_subscriptions_create",
      "Create a first-touch webhook subscription. ULTRA only — up to 10 active. Filters: kol (wallet), mint_suffix, min_first_buy_sol, min_scout_tier (S/A/B/C), min_n_touches. Returns webhook_secret ONCE — store it.",
      {
        name: z.string().optional().describe("Optional label"),
        filters: z.object({
          kol: z.string().optional(),
          mint_suffix: z.string().optional(),
          min_first_buy_sol: z.number().min(0).optional(),
          min_scout_tier: z.enum(["S", "A", "B", "C"]).optional(),
          min_n_touches: z.number().min(1).optional(),
        }).optional(),
        delivery_mode: z.enum(["websocket", "webhook", "both"]).optional().describe("Default 'webhook'"),
        webhook_url: z.string().url().optional().describe("Required when delivery_mode includes 'webhook'"),
      },
      { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      async (args) => {
        const body: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(args)) if (v !== undefined) body[k] = v;
        return { content: [{ type: "text" as const, text: await restQuery("POST", "/kol/first-touches/subscriptions", body) }] };
      }
    );

    server.tool(
      "madeonsol_first_touch_subscriptions_get",
      "Get one first-touch subscription by id. ULTRA only.",
      { id: z.string().describe("Subscription UUID") },
      { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      async ({ id }) => ({
        content: [{ type: "text" as const, text: await restQuery("GET", `/kol/first-touches/subscriptions/${encodeURIComponent(id)}`) }],
      })
    );

    server.tool(
      "madeonsol_first_touch_subscriptions_update",
      "Update fields on a first-touch subscription, including is_active toggle. ULTRA only.",
      {
        id: z.string().describe("Subscription UUID"),
        name: z.string().nullable().optional(),
        filters: z.object({
          kol: z.string().optional(),
          mint_suffix: z.string().optional(),
          min_first_buy_sol: z.number().min(0).optional(),
          min_scout_tier: z.enum(["S", "A", "B", "C"]).optional(),
          min_n_touches: z.number().min(1).optional(),
        }).optional(),
        delivery_mode: z.enum(["websocket", "webhook", "both"]).optional(),
        webhook_url: z.string().url().nullable().optional(),
        is_active: z.boolean().optional(),
      },
      { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      async ({ id, ...patch }) => {
        const body: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(patch)) if (v !== undefined) body[k] = v;
        return { content: [{ type: "text" as const, text: await restQuery("PATCH", `/kol/first-touches/subscriptions/${encodeURIComponent(id)}`, body) }] };
      }
    );

    server.tool(
      "madeonsol_first_touch_subscriptions_delete",
      "Delete a first-touch subscription permanently. ULTRA only.",
      { id: z.string().describe("Subscription UUID") },
      { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
      async ({ id }) => ({
        content: [{ type: "text" as const, text: await restQuery("DELETE", `/kol/first-touches/subscriptions/${encodeURIComponent(id)}`) }],
      })
    );

    // ── Price alerts (PRO/ULTRA, v1.9) ──

    server.tool(
      "madeonsol_price_alerts_list",
      "List your price alerts. PRO=5 alerts, ULTRA=25. Each alert monitors a token's MC for dip/recovery events.",
      {},
      { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      async () => ({
        content: [{ type: "text" as const, text: await restQuery("GET", "/price-alerts") }],
      })
    );

    server.tool(
      "madeonsol_price_alerts_create",
      "Create a price alert. Captures baseline MC from current token_prices. Fires when MC drops below baseline × (1 − drop_pct/100). Optional recovery_pct fires again on recovery. Returns webhook_secret ONCE — store it.",
      {
        token_mint: z.string().describe("Solana mint address (base58)"),
        drop_pct: z.number().min(0.01).max(99.99).describe("Drop % threshold (0.01–99.99). Alert fires when MC drops below baseline × (1 − drop_pct/100)."),
        recovery_pct: z.number().min(0.01).max(1000).optional().describe("Recovery % (0.01–1000). After dip fires, re-fires when MC rises above dip_low × (1 + recovery_pct/100)."),
        name: z.string().optional().describe("Optional label"),
        delivery_mode: z.enum(["webhook", "websocket", "both"]).optional().describe("Default 'webhook'"),
        webhook_url: z.string().url().optional().describe("Required when delivery_mode includes 'webhook'"),
      },
      { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      async (args) => {
        const body: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(args)) if (v !== undefined) body[k] = v;
        return { content: [{ type: "text" as const, text: await restQuery("POST", "/price-alerts", body) }] };
      }
    );

    server.tool(
      "madeonsol_price_alerts_get",
      "Get one price alert by id.",
      { id: z.number().describe("Alert id") },
      { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      async ({ id }) => ({
        content: [{ type: "text" as const, text: await restQuery("GET", `/price-alerts/${id}`) }],
      })
    );

    server.tool(
      "madeonsol_price_alerts_update",
      "Update alert name, delivery mode, webhook URL, or is_active. Thresholds (drop_pct, recovery_pct) are immutable.",
      {
        id: z.number().describe("Alert id"),
        name: z.string().nullable().optional(),
        delivery_mode: z.enum(["webhook", "websocket", "both"]).optional(),
        webhook_url: z.string().url().nullable().optional(),
        is_active: z.boolean().optional(),
      },
      { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      async ({ id, ...patch }) => {
        const body: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(patch)) if (v !== undefined) body[k] = v;
        return { content: [{ type: "text" as const, text: await restQuery("PATCH", `/price-alerts/${id}`, body) }] };
      }
    );

    server.tool(
      "madeonsol_price_alerts_delete",
      "Delete a price alert and its event history.",
      { id: z.number().describe("Alert id") },
      { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
      async ({ id }) => ({
        content: [{ type: "text" as const, text: await restQuery("DELETE", `/price-alerts/${id}`) }],
      })
    );

    server.tool(
      "madeonsol_price_alerts_events",
      "Fired price alert event history (30-day retention). Each event records the dip or recovery moment with actual MC values.",
      {
        alert_id: z.number().optional().describe("Filter to a specific alert"),
        event_type: z.enum(["dip", "recovery"]).optional().describe("Filter by event type"),
        since: z.string().optional().describe("ISO 8601 — events after this timestamp"),
        limit: z.number().min(1).max(200).optional().describe("Max events to return"),
      },
      { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      async (args) => {
        const url = new URL(`${BASE_URL}/api/v1/price-alerts/events`);
        for (const [k, v] of Object.entries(args)) {
          if (v !== undefined) url.searchParams.set(k, String(v));
        }
        const res = await fetch(url.toString(), { headers: { "Content-Type": "application/json", ...apiKeyHeaders() } });
        const text = res.ok ? JSON.stringify(await res.json(), null, 2) : `Error ${res.status}: ${await res.text().catch(() => "")}`;
        return { content: [{ type: "text" as const, text }] };
      }
    );

    // ── v1.9 new read endpoints ──

    server.tool(
      "madeonsol_scout_leaderboard",
      "Scout leaderboard — top KOLs ranked by scout score, first-touch frequency, and swarm attraction rate (% of first-touched tokens that attract 3+ follow-on KOLs within 4h). ULTRA only.",
      {
        limit: z.number().min(1).max(100).optional().describe("Max entries to return"),
        scout_tier: z.enum(["S", "A", "B", "C"]).optional().describe("Filter to a specific scout tier"),
        sort: z.enum(["swarm_3plus_pct", "n_first_touches_30d", "swarm_5plus_pct", "scout_score"]).optional().describe("Sort axis"),
      },
      readOnlyAnnotations,
      async (args) => {
        const url = new URL(`${BASE_URL}/api/v1/kol/scouts/leaderboard`);
        for (const [k, v] of Object.entries(args)) {
          if (v !== undefined) url.searchParams.set(k, String(v));
        }
        const res = await fetch(url.toString(), { headers: { "Content-Type": "application/json", ...apiKeyHeaders() } });
        const text = res.ok ? JSON.stringify(await res.json(), null, 2) : `Error ${res.status}: ${await res.text().catch(() => "")}`;
        return { content: [{ type: "text" as const, text }] };
      }
    );

    server.tool(
      "madeonsol_coordination_history",
      "Coordination history — past coordination alert fires with token, coordination score, KOL count, and timing. ULTRA only.",
      {
        limit: z.number().min(1).max(100).optional().describe("Max entries to return"),
        since: z.string().optional().describe("ISO 8601 — events after this timestamp"),
        min_score: z.number().min(0).max(100).optional().describe("Minimum coordination score"),
      },
      readOnlyAnnotations,
      async (args) => {
        const url = new URL(`${BASE_URL}/api/v1/kol/coordination/history`);
        for (const [k, v] of Object.entries(args)) {
          if (v !== undefined) url.searchParams.set(k, String(v));
        }
        const res = await fetch(url.toString(), { headers: { "Content-Type": "application/json", ...apiKeyHeaders() } });
        const text = res.ok ? JSON.stringify(await res.json(), null, 2) : `Error ${res.status}: ${await res.text().catch(() => "")}`;
        return { content: [{ type: "text" as const, text }] };
      }
    );

    server.tool(
      "madeonsol_kol_consensus",
      "KOL consensus on a specific token: total buyers/sellers, exit rate, net SOL flow, median entry MC. ULTRA adds individual buyer + exited wallet arrays.",
      {
        mint: z.string().describe("Token mint address (base58)"),
      },
      readOnlyAnnotations,
      async ({ mint }) => ({
        content: [{ type: "text" as const, text: await restQuery("GET", `/tokens/${encodeURIComponent(mint)}/kol-consensus`) }],
      })
    );

    server.tool(
      "madeonsol_peak_history",
      "Peak MC history for a token: all-time high MC, decline from peak %, MC at bond, MC at 1h/6h/24h/7d after bond, time-to-bond, and deploy/bond timestamps.",
      {
        mint: z.string().describe("Token mint address (base58)"),
      },
      readOnlyAnnotations,
      async ({ mint }) => ({
        content: [{ type: "text" as const, text: await restQuery("GET", `/tokens/${encodeURIComponent(mint)}/peak-history`) }],
      })
    );

    console.error("[madeonsol-mcp] Webhook & streaming tools enabled");
  } else {
    console.error("[madeonsol-mcp] Webhook/streaming tools disabled (requires MADEONSOL_API_KEY)");
  }

  // Prompts — pre-built analysis templates
  server.prompt(
    "solana_kol_analysis",
    "Analyze current Solana KOL trading activity — what are smart money wallets buying and selling?",
    { period: z.string().default("24h").describe("Time period: 1h, 6h, 24h, or 7d") },
    ({ period }) => ({
      messages: [{
        role: "user" as const,
        content: { type: "text" as const, text: `Analyze Solana KOL activity for the last ${period}. First get the KOL feed for recent trades, then check the coordination signals to see what tokens multiple KOLs are converging on, and finally show the leaderboard to see who's performing best. Summarize the key trends.` },
      }],
    })
  );

  server.prompt(
    "deployer_scout",
    "Scout for new high-potential token launches from elite Pump.fun deployers",
    {},
    () => ({
      messages: [{
        role: "user" as const,
        content: { type: "text" as const, text: "Check the latest deployer alerts for new token launches from elite Pump.fun deployers. For each alert, note the deployer tier, bonding rate, and whether any KOLs have already bought in. Highlight the most promising launches." },
      }],
    })
  );

  // Resources — static info about the API
  server.resource(
    "api-overview",
    "madeonsol://api-overview",
    { description: "MadeOnSol x402 API overview — endpoints, pricing, and how it works", mimeType: "application/json" },
    async () => {
      const res = await fetch(new URL("/api/x402", BASE_URL).toString());
      const data = await res.json();
      return { contents: [{ uri: "madeonsol://api-overview", text: JSON.stringify(data, null, 2), mimeType: "application/json" }] };
    }
  );
}

async function main() {
  await initAuth();

  if (MODE === "http") {
    // HTTP transport for hosted environments (Smithery, etc.)
    const httpServer = createServer();
    const transports = new Map<string, StreamableHTTPServerTransport>();

    httpServer.on("request", async (req, res) => {
      // Health check
      if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", server: "madeonsol-mcp" }));
        return;
      }

      // Smithery server card for discovery
      if (req.method === "GET" && req.url === "/.well-known/mcp/server-card.json") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          name: "madeonsol",
          description: "Solana KOL trading intelligence and deployer analytics. Real-time data from 1,000+ KOL wallets, 6,700+ Pump.fun deployers, 47,000+ scored alpha wallets, copy-trade rules, and wallet tracker. Supports MadeOnSol API key (msk_) or x402 micropayments.",
          version: "1.9.0",
          tools: [
            { name: "madeonsol_kol_feed", description: "Get real-time Solana KOL trades from 1,000+ tracked wallets." },
            { name: "madeonsol_kol_coordination", description: "Get KOL convergence signals — tokens multiple KOLs are accumulating." },
            { name: "madeonsol_kol_leaderboard", description: "Get KOL performance rankings by PnL and win rate." },
            { name: "madeonsol_deployer_alerts", description: "Get elite Pump.fun deployer alerts with KOL enrichment." },
            { name: "madeonsol_kol_pairs", description: "KOL affinity matrix — which KOLs co-trade the same tokens." },
            { name: "madeonsol_kol_timing", description: "KOL entry/exit timing profile. Pro/Ultra." },
            { name: "madeonsol_deployer_trajectory", description: "Deployer skill curve — streaks, trend. Pro/Ultra." },
            { name: "madeonsol_kol_hot_tokens", description: "KOL momentum tokens — accelerating buy interest." },
            { name: "madeonsol_kol_pnl", description: "Deep per-wallet PnL: equity curve, risk metrics, positions." },
            { name: "madeonsol_kol_trending_tokens", description: "Tokens ranked by KOL buy volume (5m–12h windows)." },
            { name: "madeonsol_kol_token_entry_order", description: "Ranked KOL first-buyers for a specific token." },
            { name: "madeonsol_kol_compare_wallets", description: "Side-by-side comparison of 2-5 KOL wallets (overlap in PRO+)." },
            { name: "madeonsol_kol_alerts_recent", description: "Unified live KOL alert feed: clusters, fresh buys, heating-up." },
            { name: "madeonsol_discovery", description: "List all available endpoints with prices. Free." },
            { name: "madeonsol_create_webhook", description: "Register a webhook for real-time push notifications. Pro/Ultra." },
            { name: "madeonsol_list_webhooks", description: "List your registered webhooks. Pro/Ultra." },
            { name: "madeonsol_delete_webhook", description: "Delete a webhook by ID. Pro/Ultra." },
            { name: "madeonsol_test_webhook", description: "Send a test payload to verify a webhook. Pro/Ultra." },
            { name: "madeonsol_stream_token", description: "Get a 24h WebSocket streaming token. Pro/Ultra." },
            { name: "madeonsol_me", description: "Inspect your account — tier, quota state, remaining requests, subscription expiry, per-feature usage." },
            { name: "madeonsol_tokens_list", description: "Filtered, sortable token directory — MC band, liquidity floor, primary DEX, authority/safety flags, computed 1h volume / MEV-share / MC-change. PRO+." },
            { name: "madeonsol_wallet_tracker_watchlist", description: "List your tracked wallets and remaining capacity." },
            { name: "madeonsol_wallet_tracker_add", description: "Add a wallet to your watchlist." },
            { name: "madeonsol_wallet_tracker_remove", description: "Remove a wallet from your watchlist." },
            { name: "madeonsol_wallet_tracker_trades", description: "Historical swap/transfer events for watched wallets." },
            { name: "madeonsol_wallet_tracker_summary", description: "Per-wallet stats: swap counts, SOL bought/sold." },
            { name: "madeonsol_wallet_stats", description: "Aggregate stats + cross-product flags (is_kol/alpha/deployer) for any Solana wallet. PRO+." },
            { name: "madeonsol_wallet_pnl", description: "Full FIFO cost-basis PnL for any wallet: realized + unrealized, profit factor, drawdown, daily curve, closed + open positions. PRO+." },
            { name: "madeonsol_wallet_positions", description: "Open positions only for any wallet — lighter slice of /pnl. Live unrealized SOL from mc-tracker. PRO+." },
            { name: "madeonsol_wallet_trades", description: "Cursor-paginated raw trades for any wallet. Filter by action / token_mint / time window. PRO+." },
            { name: "madeonsol_alpha_leaderboard", description: "Top profitable early-buyer wallets — 47,000+ scored. BASIC=25, PRO=100, ULTRA=500." },
            { name: "madeonsol_alpha_wallet", description: "Full alpha profile + bot signals for one wallet. ULTRA only." },
            { name: "madeonsol_alpha_linked", description: "Behaviorally linked wallets (co-bought 3+ tokens within 2s). ULTRA only." },
            { name: "madeonsol_token_cap_table", description: "First non-deployer early buyers for a token, enriched. PRO=10, ULTRA=20." },
            { name: "madeonsol_token_buyer_quality", description: "0–100 buyer quality score for a token's first-buyer cohort." },
            { name: "madeonsol_tokens_batch_buyer_quality", description: "Bulk buyer-quality scoring for up to 50 mints. Shares the LRU cache." },
            { name: "madeonsol_token_get", description: "Comprehensive per-mint snapshot: price, MC, volume, deployer, KOL, age, blacklist." },
            { name: "madeonsol_token_batch", description: "Bulk token snapshot for up to 50 mints — ~10-20× cheaper than N sequential calls." },
            { name: "madeonsol_copytrade_list", description: "List your copy-trade rules. PRO/ULTRA." },
            { name: "madeonsol_copytrade_create", description: "Create a copy-trade rule with webhook + WS delivery. PRO/ULTRA." },
            { name: "madeonsol_copytrade_get", description: "Get one copy-trade rule. PRO/ULTRA." },
            { name: "madeonsol_copytrade_update", description: "Update a copy-trade rule. PRO/ULTRA." },
            { name: "madeonsol_copytrade_delete", description: "Delete a copy-trade rule. PRO/ULTRA." },
            { name: "madeonsol_copytrade_signals", description: "Recent fired copy-trade signals (up to 7 days). PRO/ULTRA." },
            { name: "madeonsol_kol_first_touches", description: "Recent first-KOL-touch events on tokens — backtested scout signal. Filterable by scout tier S/A/B/C, KOL winrate, token age, mint suffix." },
            { name: "madeonsol_first_touch_subscriptions_list", description: "List your first-touch webhook subscriptions. ULTRA only." },
            { name: "madeonsol_first_touch_subscriptions_create", description: "Create a first-touch webhook subscription with HMAC signing. ULTRA only." },
            { name: "madeonsol_first_touch_subscriptions_get", description: "Get one first-touch subscription. ULTRA only." },
            { name: "madeonsol_first_touch_subscriptions_update", description: "Update a first-touch subscription. ULTRA only." },
            { name: "madeonsol_first_touch_subscriptions_delete", description: "Delete a first-touch subscription. ULTRA only." },
            { name: "madeonsol_coordination_alerts_list", description: "List your KOL coordination alert rules. PRO/ULTRA." },
            { name: "madeonsol_coordination_alerts_create", description: "Create a coordination alert rule (push via WS + webhook, <1s latency). PRO/ULTRA." },
            { name: "madeonsol_coordination_alerts_get", description: "Get one coordination alert rule. PRO/ULTRA." },
            { name: "madeonsol_coordination_alerts_update", description: "Update fields on a coordination alert rule. PRO/ULTRA." },
            { name: "madeonsol_coordination_alerts_delete", description: "Delete a coordination alert rule. PRO/ULTRA." },
            { name: "madeonsol_price_alerts_list", description: "List your price alerts. PRO/ULTRA." },
            { name: "madeonsol_price_alerts_create", description: "Create a price alert with dip/recovery thresholds. PRO/ULTRA." },
            { name: "madeonsol_price_alerts_get", description: "Get one price alert by id. PRO/ULTRA." },
            { name: "madeonsol_price_alerts_update", description: "Update a price alert. PRO/ULTRA." },
            { name: "madeonsol_price_alerts_delete", description: "Delete a price alert. PRO/ULTRA." },
            { name: "madeonsol_price_alerts_events", description: "Fired price alert event history (30d retention). PRO/ULTRA." },
            { name: "madeonsol_scout_leaderboard", description: "Scout leaderboard — top KOLs by scout score and swarm attraction. ULTRA." },
            { name: "madeonsol_coordination_history", description: "Past coordination alert fires with score and timing. ULTRA." },
            { name: "madeonsol_kol_consensus", description: "KOL consensus on a token: buyers/sellers, exit rate, net flow. ULTRA gets wallet arrays." },
            { name: "madeonsol_peak_history", description: "Peak MC history: ATH, decline %, MC at bond, MC at 1h/6h/24h/7d after bond." },
          ],
          homepage: "https://madeonsol.com/solana-api",
          repository: "https://github.com/LamboPoewert/mcp-server-madeonsol",
        }));
        return;
      }

      // MCP endpoint
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      {
        if (req.method === "POST") {
          let transport = sessionId ? transports.get(sessionId) : undefined;

          if (!transport) {
            transport = new StreamableHTTPServerTransport({
              sessionIdGenerator: undefined,
            });
            const server = new McpServer({ name: "madeonsol", version: "1.9.0" });
            registerTools(server);
            await server.connect(transport);
          }

          await transport.handleRequest(req, res);
          return;
        }

        if (req.method === "GET" && sessionId) {
          const transport = transports.get(sessionId);
          if (transport) {
            await transport.handleRequest(req, res);
            return;
          }
        }

        if (req.method === "DELETE" && sessionId) {
          const transport = transports.get(sessionId);
          if (transport) {
            await transport.handleRequest(req, res);
            transports.delete(sessionId);
            return;
          }
        }
      }

      res.writeHead(404);
      res.end("Not found");
    });

    // Bind to 127.0.0.1 only — defense in depth. UFW already blocks the port
    // externally, but binding to all interfaces would expose the server to any
    // misconfigured firewall rule. Override with HOST=0.0.0.0 if you ever need
    // to expose it directly (e.g. for hosted environments behind a separate
    // reverse proxy).
    const HOST = process.env.HOST || "127.0.0.1";
    httpServer.listen(PORT, HOST, () => {
      console.error(`[madeonsol-mcp] HTTP server listening on ${HOST}:${PORT}`);
    });
  } else {
    // Stdio transport for local use (Claude Desktop, Cursor, Claude Code)
    const server = new McpServer({ name: "madeonsol", version: "1.9.0" });
    registerTools(server);
    const transport = new StdioServerTransport();
    await server.connect(transport);
  }
}

main().catch(console.error);
