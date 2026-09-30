export declare const PAYMENT_RECOVERY_HEADER = "PAYMENT-RECOVERY";
export declare const X402_RECOVERY_VERSION = 1;
export type PaymentRail = "solana" | "rhc";
/**
 * Canonical request identity (server: x402RequestHash). sha256 of
 * JSON ["madeonsol-x402-request-v1", METHOD, pathname, sorted query pairs];
 * pairs are URLSearchParams entries sorted by key, then value (UTF-16 order).
 */
export declare function x402RequestHash(method: string, url: string | URL): Promise<string>;
/** The exact 5-line UTF-8 message the payer signs (no trailing newline). */
export declare function recoveryMessage(paymentId: string, requestHash: string, issuedAt: number): string;
/** base64(JSON {version, paymentId, requestHash, issuedAt, signature}) — exactly these keys. */
export declare function encodeRecoveryHeader(proof: {
    paymentId: string;
    requestHash: string;
    issuedAt: number;
    signature: string;
}): string;
/**
 * Local payment identity from the proof header the client sent.
 * Solana: sha256 of the base64-decoded payload.transaction bytes.
 * RHC: sha256(JSON ["rhc-x402-eip3009-v1", "eip155:4663", USDG, from, nonce]) (lower-case).
 */
export declare function paymentIdFromProof(rail: PaymentRail, proofHeader: string): Promise<string | null>;
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
/** Provenance headers of a paid answer, or null when the server sent none (pre-PAY-05). */
export declare function readPaidResult(res: Response): PaidResultProvenance | null;
/** Additive: `{...data, _x402_payment}` for objects, `{data, _x402_payment}` otherwise. */
export declare function withPaidResult<T>(data: T, provenance: PaidResultProvenance | null): T | Record<string, unknown>;
export declare class X402PaymentError extends Error {
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
        status: number;
        code?: string | null;
        reason?: string | null;
        paymentStatus?: string | null;
        paymentId?: string | null;
        requestHash?: string | null;
        retryAfterSeconds?: number | null;
        body?: unknown;
        resume?: () => Promise<Response>;
        cause?: unknown;
    });
}
/** Build a coded error from a non-2xx paid response; `message` keeps each SDK's historic prefix. */
export declare function x402PaymentErrorFrom(res: Response, message: (bodyText: string) => string): Promise<X402PaymentError>;
export type PaidResponseKind = "final" | "signature_required" | "in_progress" | "result_missing" | "uncertain" | "gateway" | "rate_limited";
/** Classify one answer to a paid GET (server contract § 2.3 + § 9.3). */
export declare function classifyPaidResponse(status: number, body: Record<string, any> | null): PaidResponseKind;
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
/**
 * Wrap a transport so a paid GET survives a lost response. Requests without a
 * payment proof, and non-GET requests, are passed through exactly once.
 */
export declare function createRecoveringFetch(transport: typeof fetch, options: RecoveringFetchOptions): typeof fetch;
