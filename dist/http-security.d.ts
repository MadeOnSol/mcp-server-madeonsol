import { type IncomingMessage, type ServerResponse } from "node:http";
export declare const MAX_BODY_BYTES: number;
export declare const BODY_TIMEOUT_MS = 10000;
export declare const MAX_ACTIVE_REQUESTS = 16;
export interface HttpConfig {
    host: "127.0.0.1" | "::1";
    port: number;
    allowedHosts: string[];
    tokenDigest: Buffer;
}
export declare function readHttpConfig(env?: NodeJS.ProcessEnv): HttpConfig;
/** Bounded body ingestion; callers must authenticate before invoking this. */
export declare function readJsonBody(req: IncomingMessage, maxBytes?: number, timeoutMs?: number): Promise<unknown>;
export declare function createPrivateHttpServer(config: HttpConfig, handle: (req: IncomingMessage, res: ServerResponse, body?: unknown) => Promise<void>): import("http").Server<typeof IncomingMessage, typeof ServerResponse>;
