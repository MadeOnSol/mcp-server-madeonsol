// Canonical source. Mirrored into the other x402 clients by
// packages/sync-solana-payment.mjs; CI rejects drift between published copies.
//
// PAY-05 — recovery of paid-but-lost x402 results (server contract:
// docs/audit/PAY05_PAID_RESULT_RECOVERY.md). Dependency-free: WebCrypto,
// fetch and TextEncoder only, so API-key consumers never load a signer.
//
// Rules this module enforces for a paid GET (a request that carries a
// PAYMENT-SIGNATURE / X-PAYMENT proof):
//   - the exact proof and the exact URL are re-sent until a final answer; a new
//     payment is NEVER created here (payment creation lives in the callers);
//   - the original submission carries no PAYMENT-RECOVERY header; a retry does,
//     signed by the payer with a fresh issuedAt;
//   - every wait is bounded (attempt count and wall time); when the bound is
//     reached the last answer is returned with a `resume()` handle instead of
//     silently dropping the proof;
//   - POST/PATCH/DELETE are sent exactly once (SDK-02);
//   - recovery never touches a payment budget: it re-sends a proof that was
//     already authorised and reserved, it never signs a new payment;
//   - the payment id and request hash are computed LOCALLY from the proof and
//     the URL (shared vectors: packages/x402-recovery-vectors.json); a value
//     echoed by the server is used only when the local one cannot be derived,
//     so a server can never make the payer sign for another payment.

export const PAYMENT_RECOVERY_HEADER = "PAYMENT-RECOVERY";
export const X402_RECOVERY_VERSION = 1;
const RHC_NETWORK = "eip155:4663";
const RHC_ASSET = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
const HEX64 = /^[0-9a-f]{64}$/;

export type PaymentRail = "solana" | "rhc";

const utf8 = new TextEncoder();

async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === "string" ? utf8.encode(data) : data;
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes as BufferSource));
  let out = "";
  for (const b of digest) out += b.toString(16).padStart(2, "0");
  return out;
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/**
 * Canonical request identity (server: x402RequestHash). sha256 of
 * JSON ["madeonsol-x402-request-v1", METHOD, pathname, sorted query pairs];
 * pairs are URLSearchParams entries sorted by key, then value (UTF-16 order).
 */
export async function x402RequestHash(method: string, url: string | URL): Promise<string> {
  const parsed = new URL(String(url));
  const pairs = [...new URLSearchParams(parsed.search).entries()]
    .sort(([ak, av], [bk, bv]) => (ak < bk ? -1 : ak > bk ? 1 : av < bv ? -1 : av > bv ? 1 : 0));
  return sha256Hex(JSON.stringify(["madeonsol-x402-request-v1", method.toUpperCase(), parsed.pathname, pairs]));
}

/** The exact 5-line UTF-8 message the payer signs (no trailing newline). */
export function recoveryMessage(paymentId: string, requestHash: string, issuedAt: number): string {
  return [
    "MadeOnSol x402 payment recovery",
    `version: ${X402_RECOVERY_VERSION}`,
    `payment_id: ${paymentId}`,
    `request_hash: ${requestHash}`,
    `issued_at: ${issuedAt}`,
  ].join("\n");
}

/** base64(JSON {version, paymentId, requestHash, issuedAt, signature}) — exactly these keys. */
export function encodeRecoveryHeader(proof: { paymentId: string; requestHash: string; issuedAt: number; signature: string }): string {
  return bytesToBase64(utf8.encode(JSON.stringify({
    version: X402_RECOVERY_VERSION, paymentId: proof.paymentId, requestHash: proof.requestHash,
    issuedAt: proof.issuedAt, signature: proof.signature,
  })));
}

/**
 * Local payment identity from the proof header the client sent.
 * Solana: sha256 of the base64-decoded payload.transaction bytes.
 * RHC: sha256(JSON ["rhc-x402-eip3009-v1", "eip155:4663", USDG, from, nonce]) (lower-case).
 */
export async function paymentIdFromProof(rail: PaymentRail, proofHeader: string): Promise<string | null> {
  try {
    const proof = JSON.parse(new TextDecoder().decode(base64ToBytes(proofHeader))) as Record<string, any>;
    if (rail === "solana") {
      const tx = proof?.payload?.transaction;
      return typeof tx === "string" && tx ? await sha256Hex(base64ToBytes(tx)) : null;
    }
    const auth = proof?.payload?.authorization ?? proof?.authorization;
    if (typeof auth?.from !== "string" || typeof auth?.nonce !== "string") return null;
    return await sha256Hex(JSON.stringify(["rhc-x402-eip3009-v1", RHC_NETWORK, RHC_ASSET, auth.from.toLowerCase(), auth.nonce.toLowerCase()]));
  } catch {
    return null;
  }
}

// ── Provenance ──────────────────────────────────────────────────────────────

export interface PaidResultProvenance {
  paymentId: string | null;
  requestHash: string | null;
  /** X-Paid-Result-Status: result_stored | result_not_stored | paid_result_missing. */
  status: string | null;
  /** X-Paid-Result-Source: live (this run) | stored (a replay of the stored bytes). */
  source: string | null;
  /** X-Paid-Result-Origin: original | deferred. */
  origin: string | null;
  /** True when the answer was produced AFTER the payment by a deferred run: it is not data from paidAt. */
  deferred: boolean;
  stored: boolean | null;
  paidAt: string | null;
  generatedAt: string | null;
  /** sha256 of the body bytes; a stored replay is byte-identical to the first answer. */
  sha256: string | null;
  /** Number of sends of this same proof (1 = no recovery was needed). */
  attempts: number;
}

interface ResponseMeta {
  attempts: number;
  paymentId: string | null;
  requestHash: string | null;
  resume?: () => Promise<Response>;
}
const responseMeta = new WeakMap<Response, ResponseMeta>();

/** Provenance headers of a paid answer, or null when the server sent none (pre-PAY-05). */
export function readPaidResult(res: Response): PaidResultProvenance | null {
  const h = (name: string) => res.headers.get(name);
  const meta = responseMeta.get(res);
  if (!h("X-Payment-Id") && !h("X-Paid-Result-Status")) return null;
  const paymentId = h("X-Payment-Id") ?? meta?.paymentId ?? null;
  const stored = h("X-Paid-Result-Stored");
  const origin = h("X-Paid-Result-Origin");
  return {
    paymentId, requestHash: h("X-Request-Hash") ?? meta?.requestHash ?? null,
    status: h("X-Paid-Result-Status"), source: h("X-Paid-Result-Source"), origin,
    deferred: origin === "deferred",
    stored: stored === null ? null : stored === "true",
    paidAt: h("X-Paid-At"), generatedAt: h("X-Paid-Result-Generated-At"), sha256: h("X-Paid-Result-Sha256"),
    attempts: meta?.attempts ?? 1,
  };
}

/** Additive: `{...data, _x402_payment}` for objects, `{data, _x402_payment}` otherwise. */
export function withPaidResult<T>(data: T, provenance: PaidResultProvenance | null): T | Record<string, unknown> {
  if (!provenance) return data;
  if (data && typeof data === "object" && !Array.isArray(data)) return { ...(data as Record<string, unknown>), _x402_payment: provenance };
  return { data, _x402_payment: provenance };
}

// ── Coded errors ────────────────────────────────────────────────────────────

const PENDING_CODES = new Set(["payment_uncertain", "payment_state_unavailable", "paid_result_in_progress", "paid_result_missing", "payment_transport_error"]);

export class X402PaymentError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly reason: string | null;
  readonly paymentStatus: string | null;
  readonly paymentId: string | null;
  readonly requestHash: string | null;
  readonly retryAfterSeconds: number | null;
  readonly body: unknown;
  /** Still recoverable with the SAME proof (never by a new payment). */
  readonly retryable: boolean;
  /** Only a proven `not_paid` (HTTP 402) allows a new payment for this request. */
  readonly newPaymentAllowed: boolean;
  /** Continue recovery with the same proof and URL (present when `retryable`). */
  readonly resume?: () => Promise<Response>;

  constructor(message: string, fields: {
    status: number; code?: string | null; reason?: string | null; paymentStatus?: string | null;
    paymentId?: string | null; requestHash?: string | null; retryAfterSeconds?: number | null; body?: unknown;
    resume?: () => Promise<Response>; cause?: unknown;
  }) {
    super(message, fields.cause === undefined ? undefined : { cause: fields.cause });
    this.name = "X402PaymentError";
    this.status = fields.status;
    this.code = fields.code ?? null;
    this.reason = fields.reason ?? null;
    this.paymentStatus = fields.paymentStatus ?? null;
    this.paymentId = fields.paymentId ?? null;
    this.requestHash = fields.requestHash ?? null;
    this.retryAfterSeconds = fields.retryAfterSeconds ?? null;
    this.body = fields.body;
    const pendingCode = PENDING_CODES.has(this.code ?? "") || (this.paymentStatus === "paid_result_missing" && this.status >= 500);
    this.retryable = pendingCode && this.status !== 410;
    this.newPaymentAllowed = this.status === 402 && (this.code === "not_paid" || this.paymentStatus === "not_paid");
    if (fields.resume && this.retryable) this.resume = fields.resume;
  }
}

function parseJson(text: string): Record<string, any> | null {
  try { const v = JSON.parse(text); return v && typeof v === "object" && !Array.isArray(v) ? v : null; } catch { return null; }
}

function retryAfterMs(res: Response, body: Record<string, any> | null, now: number): number | null {
  const raw = res.headers.get("Retry-After");
  if (raw !== null) {
    if (/^\s*\d+\s*$/.test(raw)) return Number(raw) * 1000;
    const at = Date.parse(raw);
    if (!Number.isNaN(at)) return Math.max(0, at - now);
  }
  const s = body?.retry_after_seconds ?? body?.paid_result?.retry_after_seconds;
  return typeof s === "number" && Number.isFinite(s) && s >= 0 ? s * 1000 : null;
}

/** Build a coded error from a non-2xx paid response; `message` keeps each SDK's historic prefix. */
export async function x402PaymentErrorFrom(res: Response, message: (bodyText: string) => string): Promise<X402PaymentError> {
  const text = await res.text().catch(() => "");
  const body = parseJson(text);
  const meta = responseMeta.get(res);
  // A failed paid run keeps the handler's own `code`; the recovery state is in paid_result.code.
  const code = body?.paid_result?.code === "paid_result_missing" ? "paid_result_missing"
    : typeof body?.code === "string" ? body.code
    : res.status === 409 && body?.reason === "replay_detected" ? "payment_recovery_signature_required" : null;
  const reason = typeof body?.reason === "string" ? body.reason
    : code === "paid_result_missing" && typeof body?.code === "string" ? body.code : null;
  const ra = retryAfterMs(res, body, Date.now());
  const paymentId = res.headers.get("X-Payment-Id") ?? (typeof body?.paymentId === "string" ? body.paymentId : null) ?? meta?.paymentId ?? null;
  return new X402PaymentError(message(text), {
    status: res.status, code, reason,
    paymentStatus: typeof body?.payment_status === "string" ? body.payment_status : null,
    paymentId, requestHash: res.headers.get("X-Request-Hash") ?? body?.recovery?.request_hash ?? meta?.requestHash ?? null,
    retryAfterSeconds: ra === null ? null : Math.ceil(ra / 1000), body: body ?? text, resume: meta?.resume,
  });
}

// ── Retry policy (pure) ─────────────────────────────────────────────────────

export type PaidResponseKind = "final" | "signature_required" | "in_progress" | "result_missing" | "uncertain" | "gateway" | "rate_limited";

/** Classify one answer to a paid GET (server contract § 2.3 + § 9.3). */
export function classifyPaidResponse(status: number, body: Record<string, any> | null): PaidResponseKind {
  if (status < 300) return "final";
  const code = typeof body?.code === "string" ? body.code : null;
  const paymentStatus = typeof body?.payment_status === "string" ? body.payment_status : null;
  if (status === 409 && (code === "payment_recovery_signature_required" || (!code && body?.reason === "replay_detected"))) return "signature_required";
  if (status === 409 && code === "paid_result_in_progress") return "in_progress";
  if (status >= 500 && paymentStatus === "paid_result_missing") return "result_missing";
  if (status === 503 && paymentStatus === "payment_uncertain") return "uncertain";
  // A proxy/gateway failure after the proof was sent: the outcome is unknown, like a lost response.
  if ((status === 502 || status === 503 || status === 504) && !paymentStatus) return "gateway";
  // The per-IP burst cap answers BEFORE any payment state is read, so a 429 says
  // nothing about the payment: an earlier send of this proof may have settled.
  // Wait (Retry-After) and resend the same proof; never treat it as final.
  if (status === 429) return "rate_limited";
  return "final"; // 2xx/4xx answers, 401 recovery_invalid, 402, 410, context mismatch, other 5xx
}

export interface RecoveryOptions {
  /** Total sends of one proof, the original included. Default 8. */
  maxAttempts?: number;
  /** Wall-time bound of the recovery phase. Default 600 000 ms (10 min). */
  maxElapsedMs?: number;
  /** Per-send timeout. Default none (the caller's signal / transport decide). */
  attemptTimeoutMs?: number;
  /** Deferred-run retries after `paid_result_missing` (contract: 1–2). Default 2. */
  maxResultMissingRetries?: number;
  /** Test hooks. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
}

export interface RecoveringFetchOptions extends RecoveryOptions {
  rail: PaymentRail;
  /** Payer signature over the UTF-8 message: Solana base58 ed25519, RHC 0x EIP-191 personal_sign. */
  sign: (message: string) => Promise<string>;
}

const defaultSleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal?.aborted) return reject(signal.reason);
  const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
  const onAbort = () => { clearTimeout(timer); reject(signal!.reason); };
  signal?.addEventListener("abort", onAbort, { once: true });
});

function headerRecord(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) return Object.fromEntries(headers.entries());
  if (Array.isArray(headers)) return Object.fromEntries(headers);
  return { ...(headers as Record<string, string>) };
}

function getHeader(headers: Record<string, string>, name: string): string | null {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === lower) return v;
  return null;
}

/**
 * Wrap a transport so a paid GET survives a lost response. Requests without a
 * payment proof, and non-GET requests, are passed through exactly once.
 */
export function createRecoveringFetch(transport: typeof fetch, options: RecoveringFetchOptions): typeof fetch {
  const maxAttempts = Math.max(1, options.maxAttempts ?? 8);
  const maxElapsedMs = options.maxElapsedMs ?? 600_000;
  const maxMissing = options.maxResultMissingRetries ?? 2;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? (() => Date.now());

  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const isRequest = typeof Request !== "undefined" && input instanceof Request;
    const url = isRequest ? (input as Request).url : String(input);
    const method = (init?.method ?? (isRequest ? (input as Request).method : "GET")).toUpperCase();
    const headers = headerRecord(init?.headers ?? (isRequest ? (input as Request).headers : undefined));
    const proof = getHeader(headers, "PAYMENT-SIGNATURE") ?? getHeader(headers, "X-PAYMENT");
    if (!proof || method !== "GET") return transport(input, init);
    const signal = init?.signal ?? (isRequest ? (input as Request).signal : undefined) ?? undefined;
    const redirect = init?.redirect ?? (isRequest ? (input as Request).redirect : undefined);
    for (const k of Object.keys(headers)) if (k.toLowerCase() === "payment-recovery") delete headers[k];

    const localPaymentId = await paymentIdFromProof(options.rail, proof);
    const localRequestHash = await x402RequestHash("GET", url);

    const run = async (startWithHeader: boolean, totalSends: { n: number }): Promise<Response> => {
      const started = now();
      let attempts = 0, missingRetries = 0, gatewayRetries = 0, signatureRetried = false;
      let sendHeader = startWithHeader;
      let ids = { paymentId: localPaymentId, requestHash: localRequestHash };
      // Local identity wins; a server echo only fills a value we could not derive.
      const remember = (res: Response, body: Record<string, any> | null) => {
        const pid = res.headers.get("X-Payment-Id") ?? body?.recovery?.payment_id ?? body?.paymentId;
        const rh = res.headers.get("X-Request-Hash") ?? body?.recovery?.request_hash;
        if (!localPaymentId && typeof pid === "string" && HEX64.test(pid)) ids = { ...ids, paymentId: pid };
        if (!localRequestHash && typeof rh === "string" && HEX64.test(rh)) ids = { ...ids, requestHash: rh };
      };
      const finish = (res: Response, pending: boolean) => {
        responseMeta.set(res, {
          attempts: totalSends.n, paymentId: ids.paymentId, requestHash: ids.requestHash,
          resume: pending ? () => run(true, totalSends) : undefined,
        });
        return res;
      };
      while (true) {
        attempts++; totalSends.n++;
        const sendHeaders = { ...headers };
        if (sendHeader && ids.paymentId && ids.requestHash) {
          const issuedAt = Math.floor(now() / 1000);
          const signature = await options.sign(recoveryMessage(ids.paymentId, ids.requestHash, issuedAt));
          sendHeaders[PAYMENT_RECOVERY_HEADER] = encodeRecoveryHeader({ paymentId: ids.paymentId, requestHash: ids.requestHash, issuedAt, signature });
        }
        const sentHeader = PAYMENT_RECOVERY_HEADER in sendHeaders;
        const controller = new AbortController();
        const onAbort = () => controller.abort(signal!.reason);
        if (signal?.aborted) onAbort(); else signal?.addEventListener("abort", onAbort, { once: true });
        const timer = options.attemptTimeoutMs
          ? setTimeout(() => controller.abort(new Error("x402 paid request attempt timed out")), options.attemptTimeoutMs) : undefined;
        let res: Response;
        try {
          res = await transport(url, { method: "GET", headers: sendHeaders, signal: controller.signal, ...(redirect ? { redirect } : {}) });
        } catch (err) {
          if (signal?.aborted) throw err; // the caller gave up: never retry behind its back
          const wait = Math.min(30_000, 1000 * 2 ** gatewayRetries++);
          if (attempts >= maxAttempts || now() - started + wait > maxElapsedMs) {
            throw new X402PaymentError(`x402 paid request outcome unknown after ${totalSends.n} send(s): ${(err as Error)?.message ?? err}`, {
              status: 0, code: "payment_transport_error", paymentStatus: "payment_uncertain",
              paymentId: ids.paymentId, requestHash: ids.requestHash, cause: err, resume: () => run(true, totalSends),
            });
          }
          await sleep(wait, signal);
          sendHeader = true;
          continue;
        } finally {
          if (timer) clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
        }
        let body: Record<string, any> | null = null;
        if (res.status >= 300) body = parseJson(await res.clone().text().catch(() => ""));
        remember(res, body);
        const kind = classifyPaidResponse(res.status, body);
        if (kind === "final") return finish(res, false);
        let wait: number;
        const hinted = retryAfterMs(res, body, now());
        if (kind === "signature_required") {
          // Only when the server did not see a header from us (an old server ignores it).
          if (sentHeader || signatureRetried) return finish(res, false);
          signatureRetried = true; wait = 0;
        } else if (kind === "result_missing") {
          if (missingRetries >= maxMissing) return finish(res, true);
          missingRetries++; wait = hinted ?? 30_000;
        } else if (kind === "gateway") {
          wait = hinted ?? Math.min(30_000, 1000 * 2 ** gatewayRetries++);
        } else if (kind === "rate_limited") {
          wait = hinted ?? 60_000;
        } else {
          wait = hinted ?? 5_000; // in_progress, uncertain
        }
        if (attempts >= maxAttempts || now() - started + wait > maxElapsedMs) return finish(res, true);
        void res.body?.cancel().catch(() => {});
        if (wait > 0) await sleep(wait, signal);
        sendHeader = true;
      }
    };
    return run(false, { n: 0 });
  }) as typeof fetch;
}
