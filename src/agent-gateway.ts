/** Opt-in subscriber tools. Kept byte-identical in the two independently published packages. */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export const AGENT_TOOL_NAMES = ["discover_opportunities", "evaluate_token", "inspect_wallet", "inspect_deployer", "evaluate_signal", "changes_since"] as const;
type Config = { baseUrl: string; apiKey?: string; chain: "solana" | "robinhood-chain"; enabled?: boolean };
const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

export function registerAgentGatewayTools(server: McpServer, config: Config): void {
  if (!config.enabled) return;
  // These six subscriber actions never inherit the legacy wallet-paid fetch.
  // The separately priced composite HTTP subset is an explicit billing choice.
  if (!/^msk_[A-Za-z0-9_-]+$/.test(config.apiKey ?? "")) throw new Error("Agent Gateway tools require a paid MADEONSOL_API_KEY");
  const base = new URL(config.baseUrl);
  if (base.username || base.password || base.search || base.hash ||
      (base.protocol !== "https:" && !(base.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname)))) {
    throw new Error("Agent Gateway requires HTTPS (HTTP is allowed only for local tests)");
  }
  const chain = z.literal(config.chain).default(config.chain);
  const address = z.string().regex(config.chain === "solana" ? /^[1-9A-HJ-NP-Za-km-z]{32,44}$/ : /^0x[0-9a-fA-F]{40}$/);
  const definitions: Array<{ name: typeof AGENT_TOOL_NAMES[number]; description: string; shape: z.ZodRawShape }> = [
    { name: "discover_opportunities", description: "Find observed KOL opportunities with explicit source gaps; not an expected-profit ranking.", shape: {
      chain, lookback: z.enum(["15m", "1h", "6h", "24h"]).default("1h"), min_kols: z.number().int().min(2).max(20).default(2), limit: z.number().int().min(1).max(25).default(10),
    } },
    { name: "evaluate_token", description: "Read token risk, buyer quality and KOL evidence. Missing evidence is not a safety verdict.", shape: { chain, address } },
    { name: "inspect_wallet", description: "Read a wallet profile and observed FIFO PnL; open lots are not verified holdings.", shape: { chain, address } },
    { name: "inspect_deployer", description: "Read a tracked deployer's profile and launch trajectory with coverage limits.", shape: { chain, address } },
    { name: "evaluate_signal", description: "Read out-of-sample signal reliability. Robinhood Chain Scorecard is explicitly unavailable.", shape: {
      chain, signal_name: z.enum(["dump_cluster_count", "runner_rate", "recycled_early_buyer_count", "coordination_count", "scout_first_touch"]), history: z.boolean().default(false),
    } },
    { name: "changes_since", description: "Read seven curated signal families. Supply exactly one of since or cursor; preserve explicit gaps and the 24h account-bound cursor horizon.", shape: {
      chain, since: z.iso.datetime({ offset: true }).optional(), cursor: z.string().min(16).max(4096).optional(), limit: z.number().int().min(1).max(100).default(50),
    } },
  ];
  for (const tool of definitions) {
    server.registerTool(tool.name, { description: tool.description, inputSchema: tool.shape, annotations }, async (args) => {
      if (tool.name === "changes_since" && Boolean(args.cursor) === Boolean(args.since)) return {
        isError: true, content: [{ type: "text", text: "Supply exactly one of since or cursor." }],
      };
      try {
        const res = await fetch(new URL("/api/v1/agent-gateway/actions", base), {
          method: "POST", redirect: "error", signal: AbortSignal.timeout(25_000),
          headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json", "User-Agent": "madeonsol-agent-gateway-mcp/1" },
          body: JSON.stringify({ tool: tool.name, input: args }),
        });
        const body = await res.json();
        return { ...(res.ok ? {} : { isError: true }), content: [{ type: "text", text: JSON.stringify(body) }] };
      } catch {
        return { isError: true, content: [{ type: "text", text: "Agent Gateway request failed. Retry with the same cursor; no payment was initiated by this tool." }] };
      }
    });
  }
}
