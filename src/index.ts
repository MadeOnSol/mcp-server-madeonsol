#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { VERSION } from "./version.js";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const BASE_URL = process.env.MADEONSOL_API_URL || "https://madeonsol.com";
const MADEONSOL_API_KEY = process.env.MADEONSOL_API_KEY; // Native key from madeonsol.com/pricing
const PRIVATE_KEY = process.env.SVM_PRIVATE_KEY; // x402 micropayments (for AI agents)
const PORT = parseInt(process.env.PORT || "3100", 10);
const MODE = process.env.MCP_TRANSPORT || "stdio"; // "stdio" or "http"

// Auth mode: MADEONSOL_API_KEY > SVM_PRIVATE_KEY (x402)
export type AuthMode = "madeonsol" | "x402" | "none";
let authMode: AuthMode = "none";
let paidFetch: typeof fetch = fetch;

/**
 * Pure selection of the auth mode from environment. Extracted from initAuth()
 * so the routing/auth-mode logic is unit-testable without setting up signers or
 * network. Priority: MADEONSOL_API_KEY (Bearer) > SVM_PRIVATE_KEY (x402) > none.
 */
export function resolveAuthMode(
  env: { MADEONSOL_API_KEY?: string; SVM_PRIVATE_KEY?: string } = process.env,
): AuthMode {
  if (env.MADEONSOL_API_KEY) return "madeonsol";
  if (env.SVM_PRIVATE_KEY) return "x402";
  return "none";
}

/**
 * Pure path rewrite. Tools are authored against /api/x402/ paths. In x402 / none
 * mode the path is kept as-is; in madeonsol (API key) mode the prefix is
 * rewritten to /api/v1/. Extracted from query() so it is unit-testable.
 */
export function rewritePath(path: string, mode: AuthMode): string {
  return mode === "x402" || mode === "none"
    ? path
    : path.replace("/api/x402/", "/api/v1/");
}

const UA = `mcp-server-madeonsol/${VERSION}`;

function apiKeyHeaders(): Record<string, string> {
  const h: Record<string, string> = { "User-Agent": UA };
  if (authMode === "madeonsol") {
    h.Authorization = `Bearer ${MADEONSOL_API_KEY}`;
  }
  return h;
}

async function initAuth() {
  const mode = resolveAuthMode({ MADEONSOL_API_KEY, SVM_PRIVATE_KEY: PRIVATE_KEY });
  if (mode === "madeonsol") {
    authMode = "madeonsol";
    console.error("[madeonsol-mcp] Using MadeOnSol API key (Bearer auth)");
    return;
  }
  if (mode === "x402" && PRIVATE_KEY) {
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
    "  → Get a free MADEONSOL_API_KEY (200 req/day, no card; live feeds 5-min delayed — paid keys are real-time) at https://madeonsol.com/pricing\n" +
    "  → Or set SVM_PRIVATE_KEY for x402 micropayments.\n",
  );
}

async function query(path: string, params?: Record<string, string | number>) {
  // API key uses /api/v1/ endpoints; x402 uses /api/x402/
  const apiPath = rewritePath(path, authMode);
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
    "Deployer skill curve — streaks, rolling bond rate, improvement trend, and deployment cadence for a Pump.fun deployer. Works with an msk_ key (Pro/Ultra) or keyless via x402 ($0.01/call).",
    {
      wallet: z.string().describe("Deployer wallet address (base58)"),
    },
    readOnlyAnnotations,
    async ({ wallet }) => ({
      content: [{ type: "text" as const, text: await query(`/api/x402/deployer-hunter/${encodeURIComponent(wallet)}/trajectory`) }],
    })
  );

  /* ── Deployer hunter: reputation, leaderboard, outcomes ──
   * "Bonding" is the pump.fun graduation event. bonding_rate is LIFETIME,
   * recent_bond_rate is the ROLLING recent window — a deployer can hold a strong
   * lifetime rate and a collapsing recent one, which is why both are exposed.
   * runner_rate means nothing until labeled_tokens >= 3. These 7 are key-only
   * (msk_); they are not on the keyless x402 rail. */

  server.tool(
    "madeonsol_deployer_stats",
    "Ecosystem-wide Pump.fun deployer stats — tracked_count (how many deployers we grade), signals_today, bonds_detected, the chain-wide bond_rate, and a per-tier count (elite/good/rising). Use this to size expectations before reading the leaderboard: a bond_rate of ~0.02 chain-wide is what makes an elite deployer's 0.30 meaningful. Requires an msk_ key.",
    {},
    readOnlyAnnotations,
    async () => ({
      content: [{ type: "text" as const, text: await query("/api/v1/deployer-hunter/stats") }],
    })
  );

  server.tool(
    "madeonsol_deployer_leaderboard",
    "Pump.fun deployer reputation leaderboard, ranked by bonding rate, recent form, total bonded, or last deploy. Unranked deployers are excluded. IMPORTANT: compare bonding_rate (LIFETIME) against recent_bond_rate (ROLLING) — the gap between them is the signal, not either number alone; a deployer at 0.40 lifetime and 0.05 recent is cooling off. runner_rate (share of labeled tokens that ran rather than dumped) is only meaningful once labeled_tokens >= 3. Requires an msk_ key.",
    {
      tier: z.enum(["elite", "good", "rising", "neutral", "spammer", "unranked"]).optional().describe("Restrict to one reputation grade"),
      sort: z.enum(["bonding_rate", "recent", "total_bonded", "last_deploy"]).default("bonding_rate").describe("Ranking axis"),
      limit: z.number().min(1).max(100).default(20).describe("Page size (1-100, default 20)"),
      offset: z.number().min(0).default(0).describe("Pagination offset"),
    },
    readOnlyAnnotations,
    async (args) => {
      const params: Record<string, string | number> = {};
      for (const [k, v] of Object.entries(args)) if (v !== undefined) params[k] = v as string | number;
      return { content: [{ type: "text" as const, text: await query("/api/v1/deployer-hunter/leaderboard", params) }] };
    }
  );

  server.tool(
    "madeonsol_deployer_profile",
    "One Pump.fun deployer's profile — tier, lifetime bonding_rate, recent_bond_rate, total deployed/bonded, first seen, last deploy, average time-to-bond, and runner_rate. NOTE: an untracked wallet returns a profile with zeroed counters, NOT a 404, so check total_deployed before concluding anything about a wallet. Gate runner_rate on labeled_tokens >= 3. Requires an msk_ key.",
    {
      wallet: z.string().describe("Deployer wallet address (base58)"),
    },
    readOnlyAnnotations,
    async ({ wallet }) => ({
      content: [{ type: "text" as const, text: await query(`/api/v1/deployer-hunter/${encodeURIComponent(wallet)}`) }],
    })
  );

  server.tool(
    "madeonsol_deployer_tokens",
    "Every token deployed by one Pump.fun wallet, paginated — each row with deployed_at, bonded_at, time-to-bond and peak market cap. Use only_bonded to see just the graduations. Pair with madeonsol_deployer_profile to check whether a deployer's record comes from a few big winners or a consistent rate. Requires an msk_ key.",
    {
      wallet: z.string().describe("Deployer wallet address (base58)"),
      limit: z.number().min(1).max(100).default(50).describe("Page size (1-100, default 50)"),
      offset: z.number().min(0).default(0).describe("Pagination offset"),
      only_bonded: z.boolean().default(false).describe("Return only tokens that graduated"),
    },
    readOnlyAnnotations,
    async ({ wallet, ...rest }) => {
      const params: Record<string, string | number | boolean> = {};
      for (const [k, v] of Object.entries(rest)) if (v !== undefined) params[k] = v as string | number | boolean;
      return { content: [{ type: "text" as const, text: await query(`/api/v1/deployer-hunter/${encodeURIComponent(wallet)}/tokens`, params as Record<string, string | number>) }] };
    }
  );

  server.tool(
    "madeonsol_deployer_alert_stats",
    "Deployer alert volume over a lookback window, with bond-rate and market-cap-multiplier distributions (pct_2x / pct_5x / pct_10x / pct_50x, avg and best) broken out per tier. This is the tool for sizing and monitoring deployer-hunter usage, and for answering 'how often does an elite-tier alert actually 10x?' with a number instead of a guess. Requires an msk_ key.",
    {
      period: z.string().optional().describe("Lookback window, e.g. '24h', '7d', '30d'"),
    },
    readOnlyAnnotations,
    async (args) => {
      const params: Record<string, string | number> = {};
      for (const [k, v] of Object.entries(args)) if (v !== undefined) params[k] = v as string | number;
      return { content: [{ type: "text" as const, text: await query("/api/v1/deployer-hunter/alert-stats", params) }] };
    }
  );

  server.tool(
    "madeonsol_deployer_best_tokens",
    "Best-performing recent tokens launched by RANKED (non-unranked) Pump.fun deployers, by peak market cap multiple over the alert price. Each row carries the deployer wallet and tier alongside mc_at_bond, peak_market_cap and mc_multiplier. Requires an msk_ key.",
    {
      period: z.string().default("7d").describe("Lookback window, e.g. '24h', '7d', '30d' (default '7d')"),
      limit: z.number().min(1).max(100).default(5).describe("Rows to return (default 5)"),
    },
    readOnlyAnnotations,
    async (args) => {
      const params: Record<string, string | number> = {};
      for (const [k, v] of Object.entries(args)) if (v !== undefined) params[k] = v as string | number;
      return { content: [{ type: "text" as const, text: await query("/api/v1/deployer-hunter/best-tokens", params) }] };
    }
  );

  server.tool(
    "madeonsol_deployer_recent_bonds",
    "Tokens from tracked Pump.fun deployers that just graduated to Raydium, newest first, each with time_to_bond_minutes, mc_at_bond, peak market cap and the full deployer reputation block. POLL INCREMENTALLY: pass the previous response's next_since back as `since` to get only what bonded after it — do not re-fetch the whole window. Requires an msk_ key.",
    {
      limit: z.number().min(1).max(100).default(20).describe("Page size (1-100, default 20)"),
      since: z.string().optional().describe("Incremental cursor — the previous response's next_since"),
      tier: z.enum(["elite", "good", "rising", "neutral", "spammer", "unranked"]).optional().describe("Restrict to one deployer grade"),
      peak_mc_min: z.number().min(0).optional().describe("Floor on peak market cap (USD)"),
    },
    readOnlyAnnotations,
    async (args) => {
      const params: Record<string, string | number> = {};
      for (const [k, v] of Object.entries(args)) if (v !== undefined) params[k] = v as string | number;
      return { content: [{ type: "text" as const, text: await query("/api/v1/deployer-hunter/recent-bonds", params) }] };
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
    "madeonsol_sniper_recent",
    "Deshred pre-confirm pump.fun deploy feed — new launches surface ~500ms before they confirm on-chain (reconstructed from shred-level data). Each deploy now carries footprint — the slot-window snipe rollup ({ buys, buyers, sol, supply_pct|null, sniper_wallet_buys, data_available, as_of } | null; buys in slots deploy-1..deploy+3). footprint is null for deploys younger than the ~10-min settle window or outside the trade-pipeline write-gate — absent, not zero. PRO (msk_ key) sees elite/good deployers; ULTRA sees every tier; also callable keyless via x402 ($0.01/call, elite/good scope).",
    {
      deployer_tier: z.enum(["elite", "good", "moderate", "rising", "cold", "unranked"]).optional().describe("Filter by deployer reputation tier (ULTRA)"),
      min_bond_rate: z.number().min(0).max(1).optional().describe("Minimum deployer lifetime bond rate (0-1)"),
      since: z.string().optional().describe("ISO-8601 — only deploys detected after this timestamp"),
      watchlist: z.boolean().optional().describe("ULTRA (msk_ key only): narrow to your custom deployer watchlist (any tier)"),
      limit: z.number().min(1).max(200).default(50).describe("Max results"),
    },
    readOnlyAnnotations,
    async ({ deployer_tier, min_bond_rate, since, watchlist, limit }) => {
      const params: Record<string, string | number> = { limit };
      if (deployer_tier) params.deployer_tier = deployer_tier;
      if (min_bond_rate != null) params.min_bond_rate = min_bond_rate;
      if (since) params.since = since;
      if (watchlist) params.watchlist = "true";
      return { content: [{ type: "text" as const, text: await query("/api/x402/sniper/recent", params) }] };
    }
  );

  server.tool(
    "madeonsol_sniper_by_deployer",
    "Deshred pre-confirm deploys filtered to a single deployer wallet — audit a deployer's recent launches before tracking them. ULTRA only.",
    {
      wallet: z.string().describe("Deployer wallet address (base58)"),
      limit: z.number().min(1).max(200).default(50).describe("Max results"),
    },
    readOnlyAnnotations,
    async ({ wallet, limit }) => {
      if (authMode !== "madeonsol") return { content: [{ type: "text" as const, text: "Sniper feed requires MADEONSOL_API_KEY (msk_, Ultra)." }] };
      const res = await fetch(`${BASE_URL}/api/v1/sniper/by-deployer/${encodeURIComponent(wallet)}?limit=${limit}`, { headers: apiKeyHeaders() });
      if (!res.ok) { const body = await res.text().catch(() => ""); return { content: [{ type: "text" as const, text: `Error ${res.status}: ${body}` }] }; }
      return { content: [{ type: "text" as const, text: JSON.stringify(await res.json(), null, 2) }] };
    }
  );

  server.tool(
    "madeonsol_discovery",
    "List all available MadeOnSol API endpoints with prices and parameter docs. Free, no auth required. The keyless x402 catalog now covers 25 endpoints — recent additions: token candles ($0.01), almost-bonded ($0.01), top-traders ($0.02), cap-table ($0.02), sniper recent deploys ($0.01), token flow ($0.01), and deployer trajectory ($0.01).",
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
        "Aggregate stats for any Solana wallet over the last 90 days plus cross-product flags (is_kol, is_alpha_tracked with bot_confidence + win_rate + net_pnl, is_deployer with tokens_deployed + bonding_rate). flags now also carries reputation flags — is_sniper, is_bundler, is_dumper — plus a dump_cluster block ({ dump_cohorts, runner_cohorts, total_cohorts, as_of } | null). bot_confidence is a string enum 'none'|'low'|'medium'|'high' (null when not alpha-tracked; earlier versions documented it as a number and it always serialized null — fixed). Scope caveat: reputation flags are pump.fun-pipeline scoped — false = not observed, NOT verified clean; is_bundler is lifetime, is_dumper is a rolling 42d window. Use this before drilling into PnL to size up an unknown wallet quickly. PRO+.",
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
        "madeonsol_wallet_holdings",
        "Verified CURRENT on-chain holdings for any wallet — reads the wallet's actual SPL + Token-2022 token accounts and SOL balance directly from chain, enriches each with our price/MC/name/symbol, and computes transfer_delta (on-chain amount − trade-derived net position, which exposes non-swap flows: airdrops, insider funding, wallet-hopping). Distinct from madeonsol_wallet_positions (trade-derived FIFO): holdings = what the wallet actually holds right now. Returns { address, sol_balance, holdings[], summary (token_accounts, non_zero, returned, priced, total_value_usd, truncated), verified_at, trade_window_days, cache_hit, ttl_seconds }; each holding: mint, symbol, name, amount, amount_raw, decimals, token_program (spl|token2022), price_usd, value_usd, market_cap_usd, is_bonded, trade_derived_amount, transfer_delta. ULTRA only.",
        {
          address: z.string().describe("Solana wallet address (base58)"),
          limit: z.number().min(1).max(500).default(200).describe("Max holdings to return (1-500, default 200)"),
          min_value_usd: z.number().min(0).default(0).describe("Only return holdings worth at least this many USD (default 0)"),
        },
        { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
        async ({ address, limit, min_value_usd }) => {
          const url = new URL(`${BASE_URL}/api/v1/wallet/${encodeURIComponent(address)}/holdings`);
          url.searchParams.set("limit", String(limit));
          url.searchParams.set("min_value_usd", String(min_value_usd));
          const res = await fetch(url.toString(), { headers: { "Content-Type": "application/json", ...apiKeyHeaders() } });
          const text = res.ok ? JSON.stringify(await res.json(), null, 2) : `Error ${res.status}: ${await res.text().catch(() => "")}`;
          return { content: [{ type: "text" as const, text }] };
        }
      );

      server.tool(
        "madeonsol_wallet_trades",
        "Cursor-paginated raw trades for any wallet. Filter by action (buy/sell), specific token_mint, time window via since/until (Unix seconds; default last 90 days). Cursor encodes (block_time, id) for stable DESC pagination — pass next_cursor from the previous response to fetch older trades. Limit 1-500 (default 100). Each trade carries price_sol/price_usd (THIS trade's executed price = sol_amount / token_amount, the trader's all-in rate incl. swap fee and any account rent) and market_price_sol/market_price_usd (the canonical pool price near that slot, shared by every trade in it) — added 2026-08-16, this route previously returned amounts and no price. PRO+.",
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

      server.tool(
        "madeonsol_wallet_batch_classify",
        "Bulk wallet reputation flags for 1-100 wallets in ONE call (counts as one request). Per wallet: is_sniper / is_bundler / is_dumper / is_kol (+ kol_name), bot_confidence (string enum 'none'|'low'|'medium'|'high', null when the wallet isn't alpha-tracked), and dump_cluster ({ dump_cohorts, runner_cohorts, total_cohorts, as_of } | null). Same semantics as the flags block on madeonsol_wallet_stats. IMPORTANT scope caveat: all three reputation flags derive from the pump.fun trade pipeline — false means 'not observed', NOT verified clean. is_sniper is behavior-updated (~12min cron) and can clear if the wallet reforms; is_bundler is a LIFETIME flag (bought >1 token in the same block, ever); is_dumper uses a rolling 42-day window (recomputed daily, up to ~48h stale). Response: { wallets[], count, as_of }. PRO/ULTRA only.",
        {
          wallets: z.array(z.string()).min(1).max(100).describe("1-100 base58 Solana wallet addresses"),
        },
        { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
        async ({ wallets }) => ({
          content: [{ type: "text" as const, text: await walletTrackerRequest("POST", "/wallet/batch/classify", { wallets }) }],
        })
      );

      console.error("[madeonsol-mcp] Wallet tracker tools enabled");
      console.error("[madeonsol-mcp] Universal wallet tools enabled (stats / pnl / positions / holdings / trades / batch classify)");
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
      "Get your WebSocket streaming token. Stream tokens NEVER EXPIRE: every call returns the same token until your subscription lapses or you pass rotate=true, which replaces it (the previous value keeps working for 60 s). expires_at / next_refresh_at are always null (kept for wire compatibility); the response also carries rotated (boolean) and lifetime (string). The server never rotates on its own and never sends token_refresh unless you rotated; a 4001 close means 'mint again', never a timer. Authenticate the handshake with 'Authorization: Bearer <token>' (?token= still works, masked in logs). Includes ws_url for KOL/deployer streaming (Pro/Ultra) and dex_ws_url for all-DEX trade streaming (Ultra only). PRO+ channels now also include token:locks (event token:lock — every NEW Streamflow / Jupiter Lock / Bonfida lock or vesting contract) and token:fee_claims (event token:fee_claim — every pump.fun fee event: distributions to shareholders, social/X claims, config changes, creator transfers) and token:surges (events token:surge — a token < 30 min old running >= 3x / 6x / 8x its launch MC, tier early / strong / breakout, each once per mint, sustained — and token:revival — no trade candle for >= 24 h, then confirmed buys on the tape; every frame carries tape / kol / early_buyers / deployer / risk_flags[]; subscribe filters kinds[], tiers[], launchpads[], exclude_flags[], min_mc_usd / max_mc_usd, deployer_tier[]).",
      { rotate: z.boolean().optional().describe("Replace the current token with a new one (the old value keeps working for 60 s). Default false — returns the existing token.") },
      { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      async ({ rotate }) => ({
        content: [{ type: "text" as const, text: await restQuery("POST", "/stream/token", rotate ? { rotate: true } : undefined) }],
      })
    );

    server.tool(
      "madeonsol_stream_sessions_list",
      "List your live WebSocket streaming sessions. Returns sessions[] (each with id, service 'ws-streaming'|'dex-stream', tier, channels[], connected_at, remote_ip, messages_sent) and count. Use it to see which connections are holding your per-tier socket slots before evicting a ghost with madeonsol_stream_session_kill. PRO/ULTRA only.",
      {},
      { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      async () => ({
        content: [{ type: "text" as const, text: await restQuery("GET", "/stream/sessions") }],
      })
    );

    server.tool(
      "madeonsol_stream_session_kill",
      "Evict (force-disconnect) one live WebSocket streaming session by id — frees the connection slot it holds. Returns { evicted: true, id }; 404 { error, id } if no such live session, 400 if id is not a positive integer. PRO/ULTRA only.",
      { id: z.number().int().positive().describe("Session id from madeonsol_stream_sessions_list (positive integer)") },
      { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
      async ({ id }) => ({
        content: [{ type: "text" as const, text: await restQuery("DELETE", `/stream/sessions/${id}`) }],
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
        min_liq_mc_ratio: z.number().optional().describe("Minimum liquidity-to-MC ratio (0-1). Filters out tokens where liquidity is thin relative to market cap."),
        max_liq_mc_ratio: z.number().optional().describe("Maximum liquidity-to-MC ratio (0-1)."),
        deployer_tier: z.enum(["elite", "good", "moderate", "rising", "cold", "unranked"]).optional().describe("Filter by deployer reputation tier."),
        sort: z.enum(["mc_desc", "mc_asc", "last_trade_desc", "liquidity_desc", "cumulative_volume_desc", "mc_change_5m_desc", "mc_change_1h_desc", "volume_1h_desc", "trending"]).optional().describe("Sort axis (default mc_desc). Momentum sorts: mc_change_5m_desc, mc_change_1h_desc, volume_1h_desc, trending (composite recent-volume × positive-momentum rank)."),
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

    server.tool(
      "madeonsol_almost_bonded",
      "Pre-bond pump.fun tokens approaching graduation, ranked by VELOCITY (Δprogress/min) — '95% and accelerating' beats '92% stalled'. Each token is enriched with its deployer's reputation tier. progress_pct comes from on-chain real_token_reserves depletion; velocity_pct_per_min is null until a 5-minute snapshot exists; eta_minutes is a linear projection from current velocity. Returns tokens[] with mint, symbol, name, progress_pct, velocity_pct_per_min, eta_minutes, stalled, real_sol_reserves, market_cap_usd, liquidity_usd, authorities_revoked, deployer_tier, age_minutes. PRO/ULTRA only.",
      {
        min_progress: z.number().min(0).max(100).optional().describe("Lower bound on bonding progress % (default 80)"),
        max_progress: z.number().min(0).max(100).optional().describe("Upper bound on bonding progress % (default 99.99 — already-bonded excluded)"),
        min_velocity_pct_per_min: z.number().optional().describe("Minimum Δprogress/min; tokens without a 5m-ago snapshot are dropped when set"),
        max_age_minutes: z.number().min(1).optional().describe("Max minutes since deploy (post-filter)"),
        deployer_tier: z.enum(["elite", "good", "moderate", "rising", "cold", "unranked"]).optional().describe("Filter by deployer reputation tier"),
        authority_revoked: z.boolean().optional().describe("Only tokens whose mint+freeze authorities are revoked"),
        min_liq: z.number().min(0).optional().describe("Minimum liquidity in USD"),
        sort: z.enum(["velocity_desc", "progress_desc", "eta_asc"]).optional().describe("Sort axis (default velocity_desc)"),
        limit: z.number().min(1).max(100).optional().describe("Page size (1-100, default 50)"),
      },
      { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      async (args) => {
        const url = new URL(`${BASE_URL}/api/v1/tokens/almost-bonded`);
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
      "Top statistically profitable early-buyer wallets, scored from 25,000+ early-buyer records. BASIC=25 (truncated), PRO=100, ULTRA=500 + bot signals.",
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
      "0–100 buyer-quality score for a token's first-buyer cohort. 5-min cached. Full breakdown on all tiers, incl. dump_cluster_count (3+ dump-cluster wallets in the first-20 → 94% historical dump rate vs 61% base) and recycled_early_buyer_count.",
      { mint: z.string().describe("Token mint address (base58)") },
      { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      async ({ mint }) => ({
        content: [{ type: "text" as const, text: await restQuery("GET", `/tokens/${encodeURIComponent(mint)}/buyer-quality`) }],
      })
    );

    server.tool(
      "madeonsol_token_risk",
      "Transparent 0–100 token rug-risk/safety score (higher = riskier). Returns a band (safe/caution/danger), an explainable factors[] array (mint authority, freeze authority, liquidity, transfer fee, token-2022, burn, launch cohort, deployer bond rate, KOL signal, blacklist) each with status/points/detail, and the raw inputs that produced the score. inputs now includes sniper_footprint — the slot-window launch-snipe rollup ({ buys, buyers, sol, supply_pct|null, sniper_wallet_buys, data_available, as_of } | null; buys landing in slots deploy-1..deploy+3). data_available=false means the mint isn't observable in the trade pipeline — NOT zero snipes; null means no rollup yet. Also returns a top-level dev block (deployer self-activity, null when the mint has no deployer-pipeline row): wallet, launchpad, deployed_at, create-tx self-buy snapshot (buy_sol / buy_tokens / buy_supply_pct), post-create rollup (bought_tokens_after — catches the same-second-separate-tx dev buy — sold_tokens, sold_sol, first_sell_at, last_sell_at), LIVE on-chain holdings (holdings_tokens, holdings_supply_pct — pump.fun 1B denominator, null elsewhere — wallet_empty: is the dev wallet empty NOW), and transferred_out (tokens left without a sell; null = unknown, never a guess). PRO/ULTRA only — BASIC receives HTTP 403.",
      { mint: z.string().describe("Token mint address (base58)") },
      { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      async ({ mint }) => ({
        content: [{ type: "text" as const, text: await restQuery("GET", `/tokens/${encodeURIComponent(mint)}/risk`) }],
      })
    );

    server.tool(
      "madeonsol_token_bundle",
      "Bundle-cohort holdings for a token — which same-slot bundle wallets bought it and how much of supply they still hold (held_pct_of_supply). Rug/insider signal. Returns a `bundle` block (wallet_count, bundle_kind atomic_tx/same_slot/none, held_ratio, held_pct_of_supply [the headline — net held / circulating supply, null if unknown], fully_exited, buy_volume, tokens_held) plus a `wallets[]` array (rank, wallet, held_ratio, has_sold, atomic, is_kol). BASIC get the bundle block only (empty wallets[]); PRO adds top-10 flags-only wallets; ULTRA returns the full cohort with enriched identities (kol_name, win_rate, bot_confidence, tokens_held).",
      { mint: z.string().describe("Token mint address (base58)") },
      { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      async ({ mint }) => ({
        content: [{ type: "text" as const, text: await restQuery("GET", `/tokens/${encodeURIComponent(mint)}/bundle`) }],
      })
    );

    server.tool(
      "madeonsol_token_pools",
      "Per-venue liquidity map for a Solana token — every DEX pool it trades in (pump.fun/PumpSwap/Raydium/Meteora/Orca) with per-pool liquidity, live vs parked (is_active), plus a summary (total liquidity, pool/DEX counts, primary/deepest pool, top_pool_share_pct concentration). Shows WHERE liquidity sits and how fragmented it is, vs the single aggregate number from the token endpoint.",
      { mint: z.string().describe("Token mint address (base58)") },
      { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      async ({ mint }) => ({
        content: [{ type: "text" as const, text: await restQuery("GET", `/tokens/${encodeURIComponent(mint)}/pools`) }],
      })
    );

    server.tool(
      "madeonsol_token_holders",
      "Live holder census + concentration for a Solana token — WHO HOLDS NOW (madeonsol_token_cap_table is who bought first). Read live from the ledger at confirmed: every token account of the mint (mint-scoped getProgramAccounts), merged per owner, ranks 1–100 retained. concentration.holder_count is EXACT — distinct non-zero owners minus the excluded pools/curves/burns — and is null ONLY when the provider refuses the census for a mega-cap (TRUMP/JUP/BONK class): then source.method=getTokenLargestAccounts, source.census_fallback_reason is set and only the top-20 view is served; it is NEVER estimated from trades. Every disclosed owner carries labels[] from MadeOnSol wallet intelligence — deployer / kol / early_buyer / buyer / bundle / bot / dump_cluster (+ kol_name, early_buyer_rank, bot_confidence, historical_win_rate); an EMPTY labels[] means unknown to us, NOT verified clean. Liquidity pools, bonding curves, vaults and burn addresses are EXCLUDED from the circulating denominator and NAMED in excluded[] with reason = pool (dex + pool_address set) | bonding_curve (pump.fun/LaunchLab) | burn | program_account (off-curve owner we could not attribute); concentration splits them into pool_pct / burned_pct / program_pct (over TOTAL supply), while top1/top10/top20/top50/top100_share and deployer/kol/early_buyer/bundle/bot/dump_cluster_pct are over circulating (supply minus excluded). amount_raw / supply_raw / circulating_raw are raw u64 returned as decimal STRINGS — never coerce to a float. Disclosure is tier-gated: PRO ranks 1–10, ULTRA 1–50, BUSINESS 1–100 (the maths is tier-independent). Large established tokens take 5–30 s to enumerate upstream: the first call may return HTTP 503 with error_kind=holder_scan_in_progress and retry_after_seconds=20 — the scan keeps running and is cached, so retry after ~20 s and the answer is instant. 404 not_a_mint = not a mint on-chain; 503 holder_rpc_unavailable (retry 15 s) = we fail closed rather than guess. PRO+ — BASIC receives HTTP 403.",
      { mint: z.string().describe("Token mint address (base58)") },
      { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      async ({ mint }) => ({
        content: [{ type: "text" as const, text: await restQuery("GET", `/tokens/${encodeURIComponent(mint)}/holders`) }],
      })
    );

    server.tool(
      "madeonsol_token_locks",
      "Token locks & vesting on ONE Solana mint — every on-chain lock / vesting contract from Streamflow, Jupiter Lock and Bonfida token-vesting, decoded from the locker programs' account state, plus a summary. Answers 'did the team lock, how much, until when, and can they pull it'. Each contract row: lock_account, program (streamflow | jupiter_lock | bonfida_vesting), kind (lock = whole amount at one date | vesting = cliff and/or periodic release), status (active | completed | cancelled | closed — derived at request time), sender (the locker; null for Bonfida), recipient, name, the schedule (start_at / cliff_at / end_at, period_seconds, continuous = per-second stream, amount_per_period_*, cliff_amount_*, perpetual), the terms (cancelable_by_sender — the locker can cancel, so funds are locked against the RECIPIENT not the locker; cancelable_by_recipient, transferable, can_topup) and a LIVE-derived view: locked_* (still locked right now), unlocked_*, withdrawn_* (claimed), claimable_* (unlocked but not withdrawn), next_unlock {at, kind cliff|period|final|tranche, amount}. summary: lock_count (exact), complete (false when the mint has >5000 contracts — totals then cover the newest 5000, rows_considered), active_count, by_program, by_kind, distinct_lockers, locked / deposited totals, unlocking_7d_* and unlocking_30d_* forward schedule, the nearest next_unlock across all contracts, active_cancelable_by_sender. Every *_raw amount is a base-unit digit STRING — never coerce to a float; ui (locked, amount…), *_usd and *_pct_of_supply are null when decimals / price are unknown (see token.facts_resolved). status/program filter the list only — the summary always covers all rows. LP LOCKS ARE NOT INCLUDED (this is token/vesting locks; LP locks are a separate feature). Poll for updates — claims/cancels are not pushed on the WebSocket. PRO+ — BASIC receives HTTP 403.",
      {
        mint: z.string().describe("Token mint address (base58)"),
        status: z.enum(["active", "completed", "cancelled", "closed"]).optional().describe("Filter the list by derived status (summary always covers all rows)"),
        program: z.enum(["streamflow", "jupiter_lock", "bonfida_vesting"]).optional().describe("Filter by locker program"),
        limit: z.number().min(1).max(500).default(200).describe("Max contracts to return (1-500, default 200)"),
      },
      { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      async ({ mint, status, program, limit }) => {
        const qs = new URLSearchParams();
        if (status) qs.set("status", status);
        if (program) qs.set("program", program);
        if (limit != null) qs.set("limit", String(limit));
        const query = qs.toString() ? `?${qs.toString()}` : "";
        return { content: [{ type: "text" as const, text: await restQuery("GET", `/tokens/${encodeURIComponent(mint)}/locks${query}`) }] };
      }
    );

    server.tool(
      "madeonsol_token_locks_feed",
      "Cross-token feed of NEW token lock / vesting contracts — who just locked tokens, of what mint, how much, until when — newest first, across ALL mints, from Streamflow, Jupiter Lock and Bonfida vesting. Each row has the same shape as a madeonsol_token_locks contract (lock_account, program, kind, status, sender, recipient, amount_* / locked_* / claimable_*, schedule, terms, next_unlock, created_at, tx_signature) plus token {symbol, name, decimals, price_usd, market_cap_usd}. Poll with since= (cursor = pagination.next_since) for new contracts, before= (pagination.next_before) to page back, or subscribe to the WebSocket channel 'token:locks' (event type 'token:lock', PRO+ stream token) for a push the moment the contract lands on-chain. Filters: mint, sender, recipient, program (streamflow | jupiter_lock | bonfida_vesting), kind (lock | vesting), status, min_usd (deposited amount ≥, needs a known price), min_pct_of_supply — the last three post-filter with a ×4 over-fetch, so a page may come back short. Backfilled Jupiter Lock rows have no on-chain creation time (created_at_estimated=true) and are EXCLUDED by default — include_estimated='1' to include them. Base-unit amounts are digit STRINGS; ui/usd/pct null when unknown. LP locks NOT included. PRO+ — BASIC receives HTTP 403.",
      {
        since: z.string().optional().describe("ISO 8601 — only contracts created after this instant (use pagination.next_since to poll)"),
        before: z.string().optional().describe("ISO 8601 — page back: only contracts created before this instant (pagination.next_before)"),
        mint: z.string().optional().describe("Filter by token mint"),
        sender: z.string().optional().describe("Filter by locker / creator wallet"),
        recipient: z.string().optional().describe("Filter by recipient wallet"),
        program: z.enum(["streamflow", "jupiter_lock", "bonfida_vesting"]).optional().describe("Filter by locker program"),
        kind: z.enum(["lock", "vesting"]).optional().describe("lock = whole amount at one date; vesting = cliff and/or periodic release"),
        status: z.enum(["active", "completed", "cancelled", "closed"]).optional().describe("Filter by derived status"),
        min_usd: z.number().min(0).optional().describe("Deposited amount ≥ this USD value (needs a known price; post-filter)"),
        min_pct_of_supply: z.number().min(0).max(100).optional().describe("Deposited amount ≥ this % of supply (post-filter)"),
        include_estimated: z.enum(["1", "0", "true", "false"]).optional().describe("'1' to include backfilled Jupiter Lock rows with an estimated created_at (excluded by default)"),
        limit: z.number().min(1).max(100).default(50).describe("Rows per page (1-100, default 50)"),
      },
      { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      async (params) => {
        const qs = new URLSearchParams();
        for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) qs.set(k, String(v));
        const query = qs.toString() ? `?${qs.toString()}` : "";
        return { content: [{ type: "text" as const, text: await restQuery("GET", `/tokens/locks${query}`) }] };
      }
    );

    server.tool(
      "madeonsol_token_unlocks",
      "Upcoming token UNLOCK EVENTS across all active lock / vesting contracts inside a window — cliffs, periodic releases (hourly or coarser) and final unlocks — i.e. which tokens have locked supply hitting the market this week, how much, from whose lock. One entry per active contract = its NEXT unlock event in the window: unlock_at, in_seconds, event (cliff | period | final | tranche), amount_raw / amount / amount_usd / amount_pct_of_supply for that event, plus window_amount_* = that contract's TOTAL release over the whole window, mint, token {symbol, name, decimals, price_usd, market_cap_usd} and lock (a subset of the madeonsol_token_locks row: lock_account, program, kind, sender, recipient, cancelable_by_sender…). Continuous per-second streams (Streamflow payroll) contribute only their cliff / final events. within = 1h | 6h | 24h | 3d | 7d | 14d | 30d | 90d (default 7d); sort = soonest (default) | largest_usd | largest_pct; filter by mint / program / kind / min_usd (next-event amount ≥, needs a known price) / min_pct_of_supply. Response: window {within, from, to}, unlocks[], pagination {limit, count, total_in_window, has_more}. Base-unit amounts are digit STRINGS; ui/usd/pct null when decimals or price are unknown; prices implying a market cap > $100B are treated as phantom → usd null. Token/vesting locks only — LP locks not included. PRO+ — BASIC receives HTTP 403.",
      {
        within: z.enum(["1h", "6h", "24h", "3d", "7d", "14d", "30d", "90d"]).default("7d").describe("Look-ahead window (default 7d)"),
        mint: z.string().optional().describe("Filter by token mint"),
        program: z.enum(["streamflow", "jupiter_lock", "bonfida_vesting"]).optional().describe("Filter by locker program"),
        kind: z.enum(["lock", "vesting"]).optional().describe("lock | vesting"),
        min_usd: z.number().min(0).optional().describe("Next-event amount ≥ this USD value (needs a known price)"),
        min_pct_of_supply: z.number().min(0).max(100).optional().describe("Next-event amount ≥ this % of supply"),
        sort: z.enum(["soonest", "largest_usd", "largest_pct"]).default("soonest").describe("Ordering (default soonest)"),
        limit: z.number().min(1).max(200).default(50).describe("Rows per page (1-200, default 50)"),
      },
      { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      async (params) => {
        const qs = new URLSearchParams();
        for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) qs.set(k, String(v));
        const query = qs.toString() ? `?${qs.toString()}` : "";
        return { content: [{ type: "text" as const, text: await restQuery("GET", `/tokens/unlocks${query}`) }] };
      }
    );

    server.tool(
      "madeonsol_token_fee_shares",
      "pump.fun creator-fee SHARING on one coin — who receives what share of its creator fees. Decodes the on-chain SharingConfig of the pump_fees program (PDA ['sharing-config', mint]): config {sharing_config, admin, admin_revoked, status, version, is_default (true = 100% to the admin/creator — a REAL answer, not 'no data'), redirected_bps / redirected_pct (share going to non-admin addresses), social_bps / social_pct, shareholders[] {address, share_bps, share_pct, is_admin (the config admin, normally the coin creator), is_social_pda (the address is a pump_fees SocialFeePda — fees earmarked for a platform identity such as an X account), social {platform (2 = X), platform_label, user_id (the platform-native NUMERIC id, not the handle), lifetime_claimed_raw / lifetime_claimed / lifetime_claimed_usd, last_claimed_at}, received_raw / received / received_usd, payout_count, last_payout_at}, source ('stream' = our table, which only stores NON-default configs; 'chain' = live PDA read), updated_at}. config is null with config_error set only when the live read failed on every RPC endpoint. Plus quote {symbol, decimals, sol_usd}, distributions {count, total_raw / total / total_usd, last_at, recipients[] (per-recipient received totals), past_recipients[] (no longer in the split), payouts_considered, payouts_truncated}, history[] (config created / updated / reset, creator transferred — newest first) and recent_distributions[] {at, tx_signature, amount_*, shareholders[], actor}. Amounts are in quote base units (SOL lamports unless a stable-quoted coin) as digit STRINGS; ui/usd null when unknown. EVENT HISTORY (distributions, history) STARTS 2026-08-17 — the config itself is current on-chain state. Use madeonsol_token_fee_claims for the cross-token event feed. PRO+ — BASIC receives HTTP 403.",
      { mint: z.string().describe("pump.fun coin mint address (base58)") },
      { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      async ({ mint }) => ({
        content: [{ type: "text" as const, text: await restQuery("GET", `/tokens/${encodeURIComponent(mint)}/fee-shares`) }],
      })
    );

    server.tool(
      "madeonsol_token_fee_claims",
      "pump.fun FEE-EVENT feed, newest first, across all coins: every decoded pump_fees / pump event — type = distribution (creator fees paid out pro-rata to the SharingConfig shareholders, i.e. fees redirected to others, with payouts[] {address, share_bps, amount_raw, amount, amount_usd} per address) | social_claim (fees earmarked for a platform identity — social.platform 2 = X, social.user_id = the platform-native numeric id — claimed to a recipient wallet; mint is NULL) | shares_created / shares_updated / shares_reset (SharingConfig changes, with shareholders[] {address, share_bps}) | creator_transferred (creator role moved; recipient = new creator) | creator_claim (the plain creator vault claim — per CREATOR, carries NO mint; EXCLUDED unless requested via type=). Each event: id, type, at, tx_signature, slot, mint (null for social claims / creator claims), admin, actor (transaction signer), recipient, amount_raw (quote base units — SOL lamports unless a stable-quoted coin — as a digit STRING), amount, amount_usd, quote, social {platform, platform_label, user_id, pda}, shareholders, payouts, payload (full decoded Anchor event). Default 100%-to-creator configs and zero-amount distributions are NOT stored. Poll with since= (cursor = pagination.next_since), page back with before= (pagination.next_before), or subscribe to the WebSocket channel 'token:fee_claims' (event type 'token:fee_claim', PRO+ stream token) for a push the moment the tx confirms. Filters: type (comma list), mint, recipient (payout / claim recipient wallet, or new creator), actor, social_platform (raw platform id, 2 = X), social_user_id, min_sol (amount floor in SOL). HISTORY STARTS 2026-08-17. Use madeonsol_token_fee_shares for one coin's current split. PRO+ — BASIC receives HTTP 403.",
      {
        type: z.string().optional().describe("Comma list of event types: distribution, social_claim, shares_created, shares_updated, shares_reset, creator_transferred, creator_claim (default: all except creator_claim)"),
        mint: z.string().optional().describe("Filter by coin mint"),
        recipient: z.string().optional().describe("Payout / claim recipient wallet, or the new creator for creator_transferred"),
        actor: z.string().optional().describe("Transaction signer"),
        social_platform: z.number().int().optional().describe("Raw social platform id (2 = X)"),
        social_user_id: z.string().optional().describe("Platform-native numeric user id (not the handle)"),
        min_sol: z.number().min(0).optional().describe("Amount floor in SOL"),
        since: z.string().optional().describe("ISO 8601 — only events after this instant (use pagination.next_since to poll)"),
        before: z.string().optional().describe("ISO 8601 — page back: only events before this instant (pagination.next_before)"),
        limit: z.number().min(1).max(100).default(50).describe("Rows per page (1-100, default 50)"),
      },
      { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      async (params) => {
        const qs = new URLSearchParams();
        for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) qs.set(k, String(v));
        const query = qs.toString() ? `?${qs.toString()}` : "";
        return { content: [{ type: "text" as const, text: await restQuery("GET", `/tokens/fee-claims${query}`) }] };
      }
    );

    server.tool(
      "madeonsol_tokens_surges",
      "Token SURGES & REVIVALS — token momentum fires, newest first, across all mints. Two kinds share one row shape. kind=surge: a token < 30 min old whose market cap runs hard against its LAUNCH MC (pump.fun launch MC is ~28 SOL by construction, so the multiple is SOL-price-independent), in three tiers that each fire at most once per mint and are independent (a token can go straight to breakout): early (age <= 10 min, MC >= $12k, >= 3x launch) | strong (<= 30 min, >= $30k, >= 6x launch AND >= 2x the lowest sample of the last 3 min — it is climbing NOW) | breakout (<= 2 min, >= $45k, >= 8x). A tier must be SUSTAINED — hold on the current tick and on a sample >= 10 s older — and nothing fires before 20 s of age: a same-slot bundle marked straight to $475k at age 1 s is a spike, not a surge. If the engine first saw the token late (baseline_source=late, restart mid-life) the multiple is NOT applied (USD floor + velocity only). kind=revival: a token with NO 1-minute trade candle for >= 24 h that starts trading again, confirmed ONLY by the tape (>= 5 buys, >= $500 buy volume, MC >= 1.5x the pre-dormancy candle close — or >= 20 buys / >= $5k regardless), never by the price mark (a single dust buy into an empty pool marks MC up 300% and is not a revival); tier is null; one fire per dormancy episode (24 h re-fire guard). Hard GATES on both (not flags): liquidity >= $1.5k AND >= 2% of MC when known, MC <= $100B, and the MC gained must be PAID FOR — buy volume on the tape >= 3% x (MC - launch / pre-dormancy MC); a price mark in a spoof pool moves MC on ~$0 of volume. Every row: id, kind, tier, mint, symbol, name, launchpad (venue at birth), primary_dex (venue at fire time), fired_at, birth_at, birth_source (sniper = pre-confirm deshred deploy | deployer = confirmed create | first_seen = first observed trade, credible only on a launchpad curve), age_seconds, market_cap_usd, liquidity_usd, liquidity_to_mc_ratio, price_usd, baseline_mc_usd, baseline_source, mc_multiple, mc_change_3m_pct, dormant_hours / prev_mc_usd / mc_vs_prev_multiple (revival), peak_mc_usd, pct_of_peak, bonding_progress_pct, is_bonded; tape {since, available, source (candles | wallet_trades — the open minute candle lands only at rollover, so a < 90 s-old surge is measured on live wallet trades), buys, sells, trades, buy_volume_usd, sell_volume_usd, volume_usd, mev_volume_usd, unique_buyers / unique_wallets / trades_per_wallet (ONLY where the mint is in token_trades coverage — wallet_data_available=false otherwise, never an inferred zero)}; kol {buyers, buys, sells, names}; early_buyers {count, bundled (same-block), cohort_sol, sold, sniper_wallets}; deployer {wallet, tier, bonding_rate, total_bonded, total_deployed, runner_rate, labeled_tokens, recent}; mint_authority_revoked, freeze_authority_revoked, is_token_2022; risk_flags[] — THE HONEST HALF: bundled_launch (>= 3 same-block early buyers), few_buyers (< 8 unique buyers, else < 10 buys), wash_pattern (>= 4 trades/wallet across < 15 wallets), thin_liquidity (< $3k or < 3% of MC), cold_deployer, sniper_heavy (>= 3 sniper wallets in the cohort), early_buyers_exiting (>= 50% of a >= 5-wallet cohort sold), sell_pressure (sells > buys), no_tape_trades (price moved but no parsed swap on the tape — real but unmeasured), no_prior_price (revival with unknown pre-dormancy MC), mint_authority_active, transfer_fee. An EMPTY risk_flags means no flag raised, NOT verified clean — absence of data never produces a flag. Rows >= 65 min old carry outcome {mc_usd_1h_after, peak_mc_usd_1h_after, low_mc_usd_1h_after, mc_1h_multiple, peak_1h_multiple, priced_after_1h (false = no candle within the hour, the token stopped being priced — NOT zero)}; stats='1' adds stats.rows[] per (kind, tier) over `days`: fires, with_outcome, up_1h_pct, median_peak_multiple, p75_peak_multiple, median_mc_1h_multiple, doubled_1h_pct — out-of-sample by construction (the fire is recorded before the outcome exists); judge the tiers on these numbers, not on their names. Filters are DB-native (no over-fetch): kind, tier (400 with kind=revival), mint, launchpad, deployer_tier, min_mc_usd / max_mc_usd, min_buys, exclude_flags (comma list — rows carrying ANY are dropped; unknown flag -> 400 with known_flags[]), only_clean='1' (no flags at all). Cursors since= (pagination.next_since) / before= (pagination.next_before). The response echoes the live thresholds in definitions (surge / revival / shared / risk_flags / tiers — read straight from the rule engine, so they cannot drift). Pushed live on the WebSocket channel 'token:surges' (events 'token:surge' / 'token:revival', same object minus outcome; subscribe filters kinds[], tiers[], launchpads[], exclude_flags[], min_mc_usd / max_mc_usd, deployer_tier[]) and accepted by madeonsol_create_webhook as events token:surge / token:revival with the same filters. Retention 60 days. Keyed API only (no x402 route). PRO+ — BASIC receives HTTP 403.",
      {
        kind: z.enum(["surge", "revival"]).optional().describe("surge = token < 30 min old running vs its launch MC; revival = dormant >= 24 h then confirmed buys"),
        tier: z.enum(["early", "strong", "breakout"]).optional().describe("Surge tier (surge only — 400 with kind=revival)"),
        mint: z.string().optional().describe("Filter by token mint"),
        since: z.string().optional().describe("ISO 8601 — only fires after this instant (use pagination.next_since to poll)"),
        before: z.string().optional().describe("ISO 8601 — page back: only fires before this instant (pagination.next_before)"),
        min_mc_usd: z.number().min(0).optional().describe("Market cap at fire time >= this USD value"),
        max_mc_usd: z.number().min(0).optional().describe("Market cap at fire time <= this USD value"),
        min_buys: z.number().int().min(0).optional().describe("Tape buys at fire time >="),
        launchpad: z.string().optional().describe("Venue at birth: pumpfun | launchlab | bags | moonshot | meteora_dbc | boop | ..."),
        deployer_tier: z.enum(["elite", "good", "moderate", "rising", "cold", "unranked"]).optional().describe("Deployer reputation tier"),
        exclude_flags: z.string().optional().describe("Comma list of risk flags — rows carrying ANY are dropped (bundled_launch, few_buyers, wash_pattern, thin_liquidity, cold_deployer, sniper_heavy, early_buyers_exiting, sell_pressure, no_tape_trades, no_prior_price, mint_authority_active, transfer_fee)"),
        only_clean: z.enum(["1", "0", "true", "false"]).optional().describe("'1' = only rows with no risk flags at all"),
        stats: z.enum(["1", "0", "true", "false"]).optional().describe("'1' = include per-(kind, tier) hit-rates over `days`"),
        days: z.number().int().min(1).max(30).optional().describe("Stats window in days (1-30, default 7)"),
        limit: z.number().min(1).max(200).default(50).describe("Rows per page (1-200, default 50)"),
      },
      { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      async (params) => {
        const qs = new URLSearchParams();
        for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) qs.set(k, String(v));
        const query = qs.toString() ? `?${qs.toString()}` : "";
        return { content: [{ type: "text" as const, text: await restQuery("GET", `/tokens/surges${query}`) }] };
      }
    );

    server.tool(
      "madeonsol_token_depth",
      "Per-pool price-impact / slippage for a token — answers 'how much SOL moves this token's price N%' and the impact of each buy size, per pool (NOT router-optimal). Each computable pool returns spot_price_sol, fee_pct, a quotes[] entry per requested SOL size (size_sol, tokens_out, avg_price_sol, price_impact_pct), and to_move_price — the SOL required to move price 1%/5%/10%. Constant-product AMMs are served from stream reserves (source=stream, with reserves_age_ms); pump.fun/bonk bonding curves from a LIVE read of the curve's virtual reserves (source=live_rpc). Pools that can't be priced honestly — concentrated CLMM/Orca/DLMM, Meteora-DBC curves, unclassified models — come back in unsupported_pools[] with a reason (e.g. concentrated_liquidity_depth_not_supported, curve_graduated_use_amm_pool) instead of a wrong number. primary_pool = deepest computable pool; found=false means no pools tracked. PRO/ULTRA only — BASIC receives HTTP 403.",
      {
        mint: z.string().describe("Token mint address (base58)"),
        sizes: z.array(z.number().gt(0).max(10000)).min(1).max(8).optional()
          .describe("SOL buy sizes to quote (max 8, each >0 and ≤10000). Default [0.5, 1, 5, 10]"),
      },
      { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      async ({ mint, sizes }) => {
        const qs = new URLSearchParams();
        if (sizes && sizes.length > 0) qs.set("sizes", sizes.join(","));
        const query = qs.toString();
        const path = `/tokens/${encodeURIComponent(mint)}/depth${query ? `?${query}` : ""}`;
        return { content: [{ type: "text" as const, text: await restQuery("GET", path) }] };
      }
    );

    server.tool(
      "madeonsol_deployer_history",
      "A pump.fun deployer's daily reputation time-series (bonding_rate, recent_bond_rate, tier, avg_peak_mc per day). Lets an agent answer 'was this deployer elite AT THE TIME it launched token X?' — backtest deployer signals without look-ahead bias.",
      {
        wallet: z.string().describe("Deployer wallet address (base58)"),
        limit: z.number().min(1).max(365).default(90).describe("Number of daily snapshots to return (1-365, default 90)"),
      },
      { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      async ({ wallet, limit }) => {
        const qs = new URLSearchParams();
        if (limit !== undefined) qs.set("limit", String(limit));
        const query = qs.toString();
        const path = `/deployer-hunter/${encodeURIComponent(wallet)}/history${query ? `?${query}` : ""}`;
        return { content: [{ type: "text" as const, text: await restQuery("GET", path) }] };
      }
    );

    server.tool(
      "madeonsol_deployer_as_of",
      "A pump.fun deployer's reputation exactly as it stood on a given date — the latest write-on-change snapshot at or before it, so an agent backtests without look-ahead bias. snapshot.snapshot_date can predate the requested date (snapshots are write-on-change); snapshot.carried=true marks that. No snapshot at or before the date returns as_of:false, snapshot:null — nothing is ever synthesized. date must be >= 2026-04-07 and not in the future. PRO/ULTRA only — BASIC receives HTTP 403.",
      {
        wallet: z.string().describe("Deployer wallet address (base58)"),
        date: z.string().optional().describe("YYYY-MM-DD (UTC). Default: today. Must be >= 2026-04-07 and not in the future."),
      },
      { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      async ({ wallet, date }) => {
        const qs = new URLSearchParams();
        if (date !== undefined) qs.set("date", date);
        const query = qs.toString();
        const path = `/deployer-hunter/${encodeURIComponent(wallet)}/as-of${query ? `?${query}` : ""}`;
        return { content: [{ type: "text" as const, text: await restQuery("GET", path) }] };
      }
    );

    server.tool(
      "madeonsol_deployer_rewards",
      "pump.fun creator-fee rewards for a wallet, answered two ways that are never merged: collected (what actually reached the wallet — direct vault claims kept 90 days, social-handle claims, shareholder payouts on any token) and attributed (every payout on the tokens it deployed, split to_self/to_others + redirected_pct). Every money field is {sol, usdc, usd}; usd is null (never a silent 0) when a SOL amount exists and no SOL price was available. top_tokens/top_recipients (up to 10, USD-sorted) show where attributed fees went. Works for non-deployers too (is_deployer:false, attributed empty). PRO/ULTRA only — BASIC receives HTTP 403.",
      {
        wallet: z.string().describe("Wallet address (base58)"),
      },
      { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      async ({ wallet }) => {
        const path = `/deployer-hunter/${encodeURIComponent(wallet)}/rewards`;
        return { content: [{ type: "text" as const, text: await restQuery("GET", path) }] };
      }
    );

    server.tool(
      "madeonsol_token_candles",
      "Historical OHLCV price candles for a token, aggregated from the on-chain trade firehose. Each candle carries t/open/high/low/close/volume_usd/trades/market_cap_usd. Timeframes: 1m/5m/15m/1h/4h/1d. PRO=OHLCV, last 30 days only. ULTRA adds buy/sell volume + count splits, net flow, MEV volume, open/close liquidity, high/low MC, and full history. PRO/ULTRA only — BASIC receives HTTP 403.",
      {
        mint: z.string().describe("Token mint address (base58)"),
        tf: z.enum(["1m", "5m", "15m", "1h", "4h", "1d"]).optional().describe("Candle timeframe (default 1h)"),
        limit: z.number().min(1).max(1000).optional().describe("Number of candles to return, 1–1000 (default 200)"),
        from: z.string().optional().describe("Start of range, ISO8601 timestamp"),
        to: z.string().optional().describe("End of range, ISO8601 timestamp"),
      },
      { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      async ({ mint, tf, limit, from, to }) => {
        const qs = new URLSearchParams();
        if (tf !== undefined) qs.set("tf", tf);
        if (limit !== undefined) qs.set("limit", String(limit));
        if (from !== undefined) qs.set("from", from);
        if (to !== undefined) qs.set("to", to);
        const query = qs.toString();
        const path = `/tokens/${encodeURIComponent(mint)}/candles${query ? `?${query}` : ""}`;
        return { content: [{ type: "text" as const, text: await restQuery("GET", path) }] };
      }
    );

    server.tool(
      "madeonsol_token_flow",
      "Trade-flow aggregate for a token — an organic-vs-fake volume read over a 1h/24h window. Returns unique_wallets / unique_buyers / unique_sellers, buy_count / sell_count / total_trades, buy_sol / sell_sol / net_sol (sell − buy; positive = net SOL leaving the pool), and trades_per_wallet (wash-trading proxy: high = a small set of wallets churning volume). PRO/ULTRA only — BASIC receives HTTP 403.",
      {
        mint: z.string().describe("Token mint address (base58)"),
        window: z.enum(["1h", "24h"]).optional().describe("Lookback window (default 1h)"),
      },
      { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      async ({ mint, window }) => {
        const qs = new URLSearchParams();
        if (window !== undefined) qs.set("window", window);
        const query = qs.toString();
        const path = `/tokens/${encodeURIComponent(mint)}/flow${query ? `?${query}` : ""}`;
        return { content: [{ type: "text" as const, text: await restQuery("GET", path) }] };
      }
    );

    server.tool(
      "madeonsol_token_trades",
      "Mint-scoped trade tape — cursor-paginated raw trades for one token, newest first (the backfill/history complement to the live DEX firehose stream). Each trade: tx_signature, wallet_address, action (buy|sell), sol_amount, token_amount, price_sol|null, price_usd|null, market_price_sol|null, market_price_usd|null, early_buyer_rank|null, slot|null, block_time (unix sec), traded_at (ISO). TWO PRICES, and picking the wrong one gives wrong answers: price_sol is THIS trade's executed price (sol_amount / token_amount — the trader's all-in rate, including swap fee and any account rent, not the pool mid), while market_price_sol is the canonical pool price sampled near that slot and is SHARED by every trade in the slot. Use price_sol for cost basis, fills and PnL; use market_price_sol for a per-token price series independent of trade size and direction. Filters: action, wallet, since/until (unix seconds — defaults to FULL history, not 90d). Pass next_cursor from the previous response to page older trades; has_more tells you when to stop. Coverage honesty: capture starts 2026-04-12 and is pump.fun-pipeline scoped — the response carries coverage.history_start + coverage.scope so agents can reason about gaps. PRO/ULTRA only.",
      {
        mint: z.string().describe("Token mint address (base58)"),
        limit: z.number().min(1).max(500).default(100).describe("Trades per page (1-500, default 100)"),
        cursor: z.string().optional().describe("Cursor from previous response's next_cursor field"),
        action: z.enum(["buy", "sell"]).optional().describe("Filter to buys or sells only"),
        wallet: z.string().optional().describe("Filter to a single wallet address (base58)"),
        since: z.number().optional().describe("Unix epoch seconds — default full history (2026-04-12 onward)"),
        until: z.number().optional().describe("Unix epoch seconds — default now"),
      },
      { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      async ({ mint, limit, cursor, action, wallet, since, until }) => {
        const url = new URL(`${BASE_URL}/api/v1/tokens/${encodeURIComponent(mint)}/trades`);
        url.searchParams.set("limit", String(limit));
        if (cursor) url.searchParams.set("cursor", cursor);
        if (action) url.searchParams.set("action", action);
        if (wallet) url.searchParams.set("wallet", wallet);
        if (since !== undefined) url.searchParams.set("since", String(since));
        if (until !== undefined) url.searchParams.set("until", String(until));
        const res = await fetch(url.toString(), { headers: { "Content-Type": "application/json", ...apiKeyHeaders() } });
        const text = res.ok ? JSON.stringify(await res.json(), null, 2) : `Error ${res.status}: ${await res.text().catch(() => "")}`;
        return { content: [{ type: "text" as const, text }] };
      }
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

    server.tool(
      "madeonsol_tokens_batch_risk",
      "Bulk token rug-risk/safety scoring for up to 50 mints in one call — same per-mint shape as madeonsol_token_risk (0–100 score, band, explainable factors[], raw inputs) plus an as_of ISO timestamp. Untracked mints come back as { mint, error: 'not_tracked' } and do NOT fail the batch; per-mint failures come back as { mint, error: 'error' }. Response preserves de-duplicated input order and carries count (number of unique mints). Counts as ONE request against your quota. PRO/ULTRA only.",
      { mints: z.array(z.string()).min(1).max(50).describe("1–50 base58 Solana token mints") },
      { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      async ({ mints }) => ({
        content: [{ type: "text" as const, text: await restQuery("POST", "/tokens/batch/risk", { mints }) }],
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

    server.tool(
      "madeonsol_signal_performance",
      "Signal performance stats for a named signal — hit rate, sample size, median outcome, and confidence window. Use this to evaluate how well a signal (e.g. 'kol_coordination', 'first_touch') has been predicting token moves before acting on it.",
      {
        name: z.string().describe("Signal name (e.g. 'kol_coordination', 'first_touch', 'deployer_alert')"),
      },
      readOnlyAnnotations,
      async ({ name }) => ({
        content: [{ type: "text" as const, text: await restQuery("GET", `/signals/${encodeURIComponent(name)}/performance`) }],
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
          description: "Solana KOL trading intelligence and deployer analytics. Real-time data from 1,000+ KOL wallets, 15,500+ Pump.fun deployers, 25,000+ scored alpha wallets, copy-trade rules, and wallet tracker. Supports MadeOnSol API key (msk_) or x402 micropayments.",
          version: VERSION,
          tools: [
            { name: "madeonsol_kol_feed", description: "Get real-time Solana KOL trades from 1,000+ tracked wallets." },
            { name: "madeonsol_kol_coordination", description: "Get KOL convergence signals — tokens multiple KOLs are accumulating." },
            { name: "madeonsol_kol_leaderboard", description: "Get KOL performance rankings by PnL and win rate." },
            { name: "madeonsol_deployer_alerts", description: "Get elite Pump.fun deployer alerts with KOL enrichment." },
            { name: "madeonsol_kol_pairs", description: "KOL affinity matrix — which KOLs co-trade the same tokens." },
            { name: "madeonsol_kol_timing", description: "KOL entry/exit timing profile. Pro/Ultra." },
            { name: "madeonsol_deployer_trajectory", description: "Deployer skill curve — streaks, trend. Pro/Ultra." },
            { name: "madeonsol_deployer_stats", description: "Chain-wide deployer stats — tracked count, bonds detected, bond rate, tier counts." },
            { name: "madeonsol_deployer_leaderboard", description: "Deployer reputation leaderboard; compare lifetime vs recent bond rate." },
            { name: "madeonsol_deployer_profile", description: "One deployer's tier, bond rates, totals, runner_rate. Untracked returns zeros, not 404." },
            { name: "madeonsol_deployer_tokens", description: "Every token one deployer launched, with time-to-bond and peak MC." },
            { name: "madeonsol_deployer_alert_stats", description: "Alert volume + per-tier bond-rate and MC-multiplier distributions." },
            { name: "madeonsol_deployer_best_tokens", description: "Best recent tokens from ranked deployers, by peak MC multiple." },
            { name: "madeonsol_deployer_recent_bonds", description: "Fresh graduations from tracked deployers; poll with next_since." },
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
            { name: "madeonsol_stream_token", description: "Get your WebSocket streaming token (never expires; same token on every call, rotate=true to replace it). Pro/Ultra." },
            { name: "madeonsol_stream_sessions_list", description: "List your live WebSocket streaming sessions (id, service, tier, channels, connected_at, messages_sent). PRO/ULTRA." },
            { name: "madeonsol_stream_session_kill", description: "Evict a live WebSocket streaming session by id — frees its connection slot. PRO/ULTRA." },
            { name: "madeonsol_me", description: "Inspect your account — tier, quota state, remaining requests, subscription expiry, per-feature usage." },
            { name: "madeonsol_tokens_list", description: "Filtered, sortable token directory — MC band, liquidity floor, primary DEX, authority/safety flags, computed 1h volume / MEV-share / MC-change, plus momentum sorts (mc_change_5m_desc, mc_change_1h_desc, volume_1h_desc, trending). PRO+." },
            { name: "madeonsol_almost_bonded", description: "Pre-bond pump.fun tokens near graduation, ranked by velocity (Δprogress/min) — progress_pct, velocity_pct_per_min, eta_minutes, stalled, deployer_tier. PRO+." },
            { name: "madeonsol_wallet_tracker_watchlist", description: "List your tracked wallets and remaining capacity." },
            { name: "madeonsol_wallet_tracker_add", description: "Add a wallet to your watchlist." },
            { name: "madeonsol_wallet_tracker_remove", description: "Remove a wallet from your watchlist." },
            { name: "madeonsol_wallet_tracker_trades", description: "Historical swap/transfer events for watched wallets." },
            { name: "madeonsol_wallet_tracker_summary", description: "Per-wallet stats: swap counts, SOL bought/sold." },
            { name: "madeonsol_wallet_stats", description: "Aggregate stats + cross-product flags (is_kol/alpha/deployer, is_sniper/is_bundler/is_dumper + dump_cluster) for any Solana wallet. PRO+." },
            { name: "madeonsol_wallet_batch_classify", description: "Bulk reputation flags for 1-100 wallets in one call — is_sniper/is_bundler/is_dumper/is_kol, bot_confidence, dump_cluster. PRO+." },
            { name: "madeonsol_wallet_pnl", description: "Full FIFO cost-basis PnL for any wallet: realized + unrealized, profit factor, drawdown, daily curve, closed + open positions. PRO+." },
            { name: "madeonsol_wallet_positions", description: "Open positions only for any wallet — lighter slice of /pnl. Live unrealized SOL from mc-tracker. PRO+." },
            { name: "madeonsol_wallet_trades", description: "Cursor-paginated raw trades for any wallet. Filter by action / token_mint / time window. PRO+." },
            { name: "madeonsol_alpha_leaderboard", description: "Top profitable early-buyer wallets — 25,000+ scored. BASIC=25, PRO=100, ULTRA=500." },
            { name: "madeonsol_alpha_wallet", description: "Full alpha profile + bot signals for one wallet. ULTRA only." },
            { name: "madeonsol_alpha_linked", description: "Behaviorally linked wallets (co-bought 3+ tokens within 2s). ULTRA only." },
            { name: "madeonsol_token_cap_table", description: "First non-deployer early buyers for a token, enriched. PRO=10, ULTRA=20." },
            { name: "madeonsol_token_holders", description: "Live holder census + concentration — who holds NOW. Exact holder_count (null only if the provider refuses a mega-cap), labelled owners, pools/curves/burns excluded and named. PRO=10, ULTRA=50, BUSINESS=100 disclosed; 503 holder_scan_in_progress → retry in 20 s." },
            { name: "madeonsol_token_locks", description: "Token locks & vesting on a mint (Streamflow / Jupiter Lock / Bonfida) — every contract with live locked/claimable, schedule, cancelable-by-sender, plus 7d/30d unlock summary. LP locks not included. PRO+." },
            { name: "madeonsol_token_locks_feed", description: "Cross-token feed of NEW lock/vesting contracts, newest first; poll with next_since or subscribe to WS channel token:locks. PRO+." },
            { name: "madeonsol_token_unlocks", description: "Upcoming unlock EVENTS (cliff / period / final / tranche) across all active contracts inside 1h–90d — what locked supply hits the market, how much, from whose lock. PRO+." },
            { name: "madeonsol_token_fee_shares", description: "pump.fun creator-fee SharingConfig on a coin — shareholders (bps, is_admin, is_social_pda / X identity), redirected_bps, distributions rollup + config history (from 2026-08-17). PRO+." },
            { name: "madeonsol_token_fee_claims", description: "pump.fun fee-event feed — distributions to shareholders, social (X) claims, config changes, creator transfers; poll with next_since or WS channel token:fee_claims. History from 2026-08-17. PRO+." },
            { name: "madeonsol_tokens_surges", description: "Token surges & revivals — momentum fires, newest first: surge tiers early / strong / breakout (vs launch MC, sustained, once per mint) and revivals (dormant >= 24 h, confirmed by tape buys); each row with tape / kol / early_buyers / deployer / risk_flags[] and a +1 h outcome; stats=1 for per-tier hit-rates; poll with next_since or WS channel token:surges. PRO+." },
            { name: "madeonsol_token_buyer_quality", description: "0–100 buyer quality score for a token's first-buyer cohort." },
            { name: "madeonsol_token_depth", description: "Per-pool price impact / slippage — quotes per SOL buy size + SOL to move price 1%/5%/10%; unsupported pools flagged with a reason. PRO+." },
            { name: "madeonsol_token_candles", description: "Historical OHLCV price candles (1m–1d). PRO=OHLCV 30d; ULTRA=+net flow, liquidity delta, full history." },
            { name: "madeonsol_token_trades", description: "Mint-scoped trade tape — cursor-paginated raw trades for one token, full history from 2026-04-12. PRO+." },
            { name: "madeonsol_tokens_batch_buyer_quality", description: "Bulk buyer-quality scoring for up to 50 mints. Shares the LRU cache." },
            { name: "madeonsol_tokens_batch_risk", description: "Bulk rug-risk/safety scoring for up to 50 mints — same shape as madeonsol_token_risk + as_of; untracked mints don't fail the batch. PRO+." },
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
            { name: "madeonsol_signal_performance", description: "Signal performance stats for a named signal — hit rate, sample size, median outcome, confidence window." },
          ],
          homepage: "https://madeonsol.com/solana-api",
          repository: "https://github.com/madeonsol/mcp-server-madeonsol",
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
            const server = new McpServer({ name: "madeonsol", version: VERSION });
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
    const server = new McpServer({ name: "madeonsol", version: VERSION });
    registerTools(server);
    const transport = new StdioServerTransport();
    await server.connect(transport);
  }
}

// Only auto-run when executed as a program (CLI / spawned process), not when
// the module is imported by a test for its exported pure helpers.
if (process.env.MADEONSOL_MCP_NO_AUTORUN !== "1") {
  main().catch(console.error);
}
