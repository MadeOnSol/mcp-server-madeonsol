export declare const SOLANA_PAYMENT_NETWORK = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
export declare const SOLANA_PAYMENT_ASSET = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
interface ApprovedOffer {
    scheme: "exact";
    network: typeof SOLANA_PAYMENT_NETWORK;
    asset: string;
    payTo: string;
    amount: string;
    maxTimeoutSeconds: number;
    extra: {
        feePayer: string;
    };
}
interface ApprovedChallenge {
    x402Version: 2;
    resource: {
        url: string;
    };
    accepts: ApprovedOffer[];
}
export interface SolanaPaymentProposal {
    readonly url: string;
    readonly network: string;
    readonly asset: string;
    readonly payTo: string;
    readonly feePayer: string;
    readonly amountAtomic: string;
}
export interface SolanaPaymentPolicy {
    /** Trusted merchant wallet, obtained independently of a payment challenge. */
    payTo: string;
    /** Trusted facilitator wallet; must not be the paying agent's wallet. */
    feePayer: string;
    /** Positive atomic USDC integers (6 decimals); numbers are not accepted. */
    maxAmountAtomic: string | bigint;
    maxTotalAmountAtomic: string | bigint;
    /** Explicit trusted HTTPS RPC; there is no public RPC fallback. */
    rpcUrl: string;
    /** Whole payment attempt deadline, default 30 seconds. */
    timeoutMs?: number;
    /** Optional additional approval; only literal true permits signing. */
    beforePayment?: (proposal: SolanaPaymentProposal) => boolean | Promise<boolean>;
}
/** Lifetime authorization allowance, not settled spend. Share one long-lived instance.
 * Retained after entering payment creation, including uncertain/failed outcomes.
 */
export declare class SolanaPaymentBudget {
    #private;
    readonly policy: Readonly<SolanaPaymentPolicy>;
    constructor(policy: SolanaPaymentPolicy);
    get authorizedAmountAtomic(): string;
    select(envelope: unknown, requestUrl: string): ApprovedChallenge;
    /** Atomic synchronous reservation before any approval/signing await. */
    reserve(atomic: string): () => void;
}
export declare function solanaPaymentPolicyFromConfig(get: (key: string) => string | undefined): SolanaPaymentPolicy;
/** One challenge and at most one paid request. No automatic payment replay. */
export declare function createSolanaPaidFetch(privateKey: string, budget: SolanaPaymentBudget, baseUrl: string, transport?: typeof fetch): Promise<typeof fetch>;
export {};
