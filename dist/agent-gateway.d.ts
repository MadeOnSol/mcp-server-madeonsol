/** Opt-in subscriber tools. Kept byte-identical in the two independently published packages. */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
export declare const AGENT_TOOL_NAMES: readonly ["discover_opportunities", "evaluate_token", "inspect_wallet", "inspect_deployer", "evaluate_signal", "changes_since"];
type Config = {
    baseUrl: string;
    apiKey?: string;
    chain: "solana" | "robinhood-chain";
    enabled?: boolean;
};
export declare function registerAgentGatewayTools(server: McpServer, config: Config): void;
export {};
