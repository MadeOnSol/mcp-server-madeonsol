// Keep this standalone-package helper identical in both MCP packages.
// HTTP is a private, single-operator adapter. Public/multi-user hosting is
// intentionally unsupported until credentials can be scoped per principal.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";

export const MAX_BODY_BYTES = 256 * 1024;
export const BODY_TIMEOUT_MS = 10_000;
export const MAX_ACTIVE_REQUESTS = 16;

export interface HttpConfig {
  host: "127.0.0.1" | "::1";
  port: number;
  allowedHosts: string[];
  tokenDigest: Buffer;
}

export function readHttpConfig(env: NodeJS.ProcessEnv = process.env): HttpConfig {
  const host = env.HOST || "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "::1") {
    throw new Error("HTTP MCP requires HOST=127.0.0.1 or ::1; public binding is unsupported. Use stdio for local clients.");
  }
  const portText = env.PORT || "3100";
  const port = Number(portText);
  if (!/^\d+$/.test(portText) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("HTTP MCP requires a valid PORT between 1 and 65535.");
  }
  if (env.SVM_PRIVATE_KEY || env.RHC_PAYER_KEY) {
    throw new Error("HTTP MCP cannot expose a payment signer. Remove wallet credentials or use stdio.");
  }
  if (!env.MADEONSOL_API_KEY?.startsWith("msk_")) {
    throw new Error("HTTP MCP requires the operator's MADEONSOL_API_KEY.");
  }
  const token = env.MCP_HTTP_TOKEN || "";
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(token) || token === env.MADEONSOL_API_KEY) {
    throw new Error("HTTP MCP requires a separate random MCP_HTTP_TOKEN (32–256 base64url characters).");
  }
  const authority = host === "::1" ? `[::1]:${port}` : `${host}:${port}`;
  return {
    host, port, allowedHosts: [authority, `localhost:${port}`],
    tokenDigest: createHash("sha256").update(token).digest(),
  };
}

class HttpFailure extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function fail(res: ServerResponse, status: number, message: string) {
  if (res.headersSent) { res.destroy(); return; }
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "Connection": "close",
    ...(status === 401 ? { "WWW-Authenticate": 'Bearer realm="private-mcp"' } : {}),
  });
  res.end(JSON.stringify({ error: message }));
}

function headerCount(req: IncomingMessage, name: string): number {
  let count = 0;
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    if (req.rawHeaders[i].toLowerCase() === name) count++;
  }
  return count;
}

function authorize(req: IncomingMessage, res: ServerResponse, config: HttpConfig): boolean {
  const remote = req.socket.remoteAddress;
  if ((remote !== "127.0.0.1" && remote !== "::1") ||
      headerCount(req, "host") !== 1 || !config.allowedHosts.includes(req.headers.host || "")) {
    fail(res, 403, "Forbidden host"); return false;
  }
  // Native local MCP clients do not need browser origins, CORS or proxy headers.
  if (req.headers.origin !== undefined || Object.keys(req.headers).some(
    h => h === "forwarded" || h.startsWith("x-forwarded-")
  )) {
    fail(res, 403, "Browser origins and forwarded requests are unsupported"); return false;
  }
  const auth = req.headers.authorization;
  const match = typeof auth === "string" ? /^Bearer ([A-Za-z0-9_-]{32,256})$/i.exec(auth) : null;
  if (headerCount(req, "authorization") !== 1 || !match || !timingSafeEqual(
    createHash("sha256").update(match[1]).digest(), config.tokenDigest
  )) {
    fail(res, 401, "Unauthorized"); return false;
  }
  return true;
}

/** Bounded body ingestion; callers must authenticate before invoking this. */
export function readJsonBody(req: IncomingMessage, maxBytes = MAX_BODY_BYTES, timeoutMs = BODY_TIMEOUT_MS): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const cleanup = () => {
      clearTimeout(timer);
      req.off("data", data); req.off("end", end); req.off("aborted", aborted); req.off("error", error);
    };
    const stop = (reason: HttpFailure) => { cleanup(); req.pause(); reject(reason); };
    const timer = setTimeout(() => stop(new HttpFailure(408, "Request body timed out")), timeoutMs);
    const data = (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) { stop(new HttpFailure(413, "Request body too large")); return; }
      chunks.push(chunk);
    };
    const end = () => {
      cleanup();
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { reject(new HttpFailure(400, "Invalid JSON")); }
    };
    const aborted = () => stop(new HttpFailure(400, "Request aborted"));
    const error = () => stop(new HttpFailure(400, "Request failed"));
    req.on("data", data); req.once("end", end); req.once("aborted", aborted); req.once("error", error);
  });
}

export function createPrivateHttpServer(
  config: HttpConfig,
  handle: (req: IncomingMessage, res: ServerResponse, body?: unknown) => Promise<void>,
) {
  let active = 0;
  const server = createServer({ maxHeaderSize: 8192 }, (req, res) => {
    void (async () => {
      if (!authorize(req, res, config)) return;
      const isMcp = req.url === "/mcp";
      const isInfo = req.url === "/health" || req.url === "/.well-known/mcp/server-card.json";
      if (!isMcp && !isInfo) { fail(res, 404, "Not found"); return; }
      const method = isMcp ? "POST" : "GET";
      if (req.method !== method) {
        res.setHeader("Allow", method); fail(res, 405, "Method not allowed"); return;
      }
      if (isMcp && (req.headers["content-type"]?.split(";")[0].trim().toLowerCase() !== "application/json" ||
          (req.headers["content-encoding"] !== undefined && req.headers["content-encoding"] !== "identity"))) {
        fail(res, 415, "Only uncompressed application/json is supported"); return;
      }
      if (Number(req.headers["content-length"] || 0) > MAX_BODY_BYTES) {
        fail(res, 413, "Request body too large"); return;
      }
      // No sessions are issued: a supplied session id must never become an auth bypass.
      if (req.headers["mcp-session-id"] !== undefined) {
        fail(res, 400, "HTTP MCP is stateless; session identifiers are unsupported"); return;
      }
      if (active >= MAX_ACTIVE_REQUESTS) { fail(res, 503, "Too many active requests"); return; }
      active++;
      let released = false;
      const release = () => { if (!released) { released = true; active--; } };
      res.once("close", release); res.once("finish", release);
      res.setHeader("Cache-Control", "no-store");
      const body = isMcp ? await readJsonBody(req) : undefined;
      if (!res.destroyed) await handle(req, res, body);
    })().catch(error => {
      if (!res.destroyed) fail(res, error instanceof HttpFailure ? error.status : 500,
        error instanceof HttpFailure ? error.message : "Internal server error");
    });
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 100;
  return server;
}
