// Canonical source. Mirrored into the two Solana adapters by
// packages/sync-solana-payment.mjs; CI rejects drift between published copies.
export const SOLANA_PAYMENT_NETWORK = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
export const SOLANA_PAYMENT_ASSET = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
function fail(message) { throw new Error(`Solana payment policy: ${message}`); }
const MAX_AMOUNT = (1n << 64n) - 1n;
function amount(value) {
    if (typeof value !== "bigint" && (typeof value !== "string" || !/^[1-9][0-9]{0,19}$/.test(value))) {
        return fail("amount must be a positive atomic integer string or bigint");
    }
    const parsed = BigInt(value);
    if (parsed <= 0n || parsed > MAX_AMOUNT)
        return fail("amount exceeds uint64 range");
    return parsed;
}
function wallet(value) {
    if (typeof value !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value))
        return fail("invalid wallet address");
    const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    let decoded = 0n;
    for (const char of value)
        decoded = decoded * 58n + BigInt(alphabet.indexOf(char));
    const bytes = decoded === 0n ? 0 : Math.ceil(decoded.toString(16).length / 2);
    if (decoded === 0n || bytes + (value.match(/^1*/)?.[0].length ?? 0) !== 32)
        return fail("invalid wallet address");
    return value;
}
function httpsUrl(value) {
    if (typeof value !== "string")
        return fail("invalid HTTPS URL");
    let url;
    try {
        url = new URL(value);
    }
    catch {
        return fail("invalid HTTPS URL");
    }
    if (url.protocol !== "https:" || url.username || url.password || url.hash)
        return fail("HTTPS URL without credentials or fragment required");
    return url;
}
/** Lifetime authorization allowance, not settled spend. Share one long-lived instance.
 * Retained after entering payment creation, including uncertain/failed outcomes.
 */
export class SolanaPaymentBudget {
    policy;
    #authorized = 0n;
    #max;
    #total;
    constructor(policy) {
        if (!policy)
            fail("paymentPolicy is required for keyless payments");
        const payTo = wallet(policy.payTo), feePayer = wallet(policy.feePayer);
        this.#max = amount(policy.maxAmountAtomic);
        this.#total = amount(policy.maxTotalAmountAtomic);
        const rpcUrl = httpsUrl(policy.rpcUrl).href;
        const timeoutMs = policy.timeoutMs ?? 30_000;
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647)
            fail("invalid timeoutMs");
        if (policy.beforePayment !== undefined && typeof policy.beforePayment !== "function")
            fail("invalid beforePayment hook");
        this.policy = Object.freeze({ payTo, feePayer, rpcUrl, timeoutMs,
            maxAmountAtomic: this.#max.toString(), maxTotalAmountAtomic: this.#total.toString(), beforePayment: policy.beforePayment });
    }
    get authorizedAmountAtomic() { return this.#authorized.toString(); }
    select(envelope, requestUrl) {
        const challenge = envelope;
        if (!challenge || challenge.x402Version !== 2 || !Array.isArray(challenge.accepts) ||
            challenge.accepts.length < 1 || challenge.accepts.length > 32)
            fail("unsupported payment challenge");
        const request = httpsUrl(requestUrl);
        if (challenge.resource !== undefined) {
            const resource = httpsUrl(challenge.resource?.url);
            // The current server advertises its path without the request query.
            if (resource.origin !== request.origin || resource.pathname !== request.pathname ||
                (resource.search && resource.search !== request.search))
                fail("resource mismatch");
        }
        for (const offer of challenge.accepts) {
            if (!offer || offer.scheme !== "exact" || offer.network !== SOLANA_PAYMENT_NETWORK ||
                offer.asset !== SOLANA_PAYMENT_ASSET || offer.payTo !== this.policy.payTo ||
                offer.extra?.feePayer !== this.policy.feePayer)
                continue;
            if (typeof offer.amount !== "string")
                continue;
            let cost;
            try {
                cost = amount(offer.amount);
            }
            catch {
                continue;
            }
            if (cost > this.#max || !Number.isSafeInteger(offer.maxTimeoutSeconds) || offer.maxTimeoutSeconds <= 0)
                continue;
            // Rebuild instead of forwarding arbitrary remote fields/extensions to a signer.
            const accepted = Object.freeze({ scheme: "exact", network: SOLANA_PAYMENT_NETWORK,
                asset: SOLANA_PAYMENT_ASSET, payTo: this.policy.payTo, amount: cost.toString(),
                maxTimeoutSeconds: offer.maxTimeoutSeconds, extra: Object.freeze({ feePayer: this.policy.feePayer }) });
            return { x402Version: 2, resource: { url: request.href }, accepts: [accepted] };
        }
        return fail("no permitted exact mainnet USDC offer");
    }
    /** Atomic synchronous reservation before any approval/signing await. */
    reserve(atomic) {
        const cost = amount(atomic);
        if (cost > this.#max || this.#authorized + cost > this.#total)
            fail("authorization budget exceeded");
        this.#authorized += cost;
        let released = false;
        return () => { if (!released) {
            this.#authorized -= cost;
            released = true;
        } };
    }
}
export function solanaPaymentPolicyFromConfig(get) {
    const required = (name) => get(name) || fail(`${name} is required in keyless mode`);
    return {
        payTo: required("X402_PAY_TO"), feePayer: required("X402_FEE_PAYER"),
        maxAmountAtomic: required("X402_MAX_AMOUNT_ATOMIC"), maxTotalAmountAtomic: required("X402_MAX_TOTAL_AMOUNT_ATOMIC"),
        rpcUrl: required("SVM_RPC_URL"),
    };
}
async function challengeBody(response) {
    const header = response.headers.get("PAYMENT-REQUIRED");
    if (header) {
        if (header.length > 65_536)
            fail("payment header too large");
        // The protocol library decodes the header. Do not buffer an unrelated body.
        void response.body?.cancel().catch(() => { });
        return undefined;
    }
    if (!response.body)
        return undefined;
    const reader = response.body.getReader();
    let size = 0;
    const chunks = [];
    try {
        while (true) {
            const { value, done } = await reader.read();
            if (done)
                break;
            size += value.byteLength;
            if (size > 65_536)
                fail("payment challenge too large");
            chunks.push(value);
        }
    }
    finally {
        void reader.cancel().catch(() => { });
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
    }
    try {
        return JSON.parse(new TextDecoder().decode(bytes));
    }
    catch {
        return fail("invalid payment challenge JSON");
    }
}
/** One challenge and at most one paid request. No automatic payment replay. */
export async function createSolanaPaidFetch(privateKey, budget, baseUrl, transport = fetch) {
    const origin = httpsUrl(baseUrl).origin;
    const { x402Client, x402HTTPClient } = await import("@x402/core/client");
    const { ExactSvmScheme } = await import("@x402/svm/exact/client");
    const { createKeyPairSignerFromBytes } = await import("@solana/kit");
    const { base58 } = await import("@scure/base");
    const signer = await createKeyPairSignerFromBytes(base58.decode(privateKey));
    if (signer.address === budget.policy.feePayer)
        fail("the agent wallet cannot pay facilitator gas");
    return async (input, init) => {
        const original = new Request(input, init);
        if (httpsUrl(original.url).origin !== origin)
            fail("request origin mismatch");
        if (original.headers.has("PAYMENT-SIGNATURE") || original.headers.has("X-PAYMENT"))
            fail("payment already attempted");
        const controller = new AbortController();
        const deadline = Date.now() + budget.policy.timeoutMs;
        const check = () => {
            if (Date.now() >= deadline && !controller.signal.aborted)
                controller.abort(new Error("Solana payment timeout"));
            controller.signal.throwIfAborted();
        };
        const abort = () => controller.abort(original.signal.reason);
        original.signal.addEventListener("abort", abort, { once: true });
        if (original.signal.aborted)
            abort();
        const timer = setTimeout(() => controller.abort(new Error("Solana payment timeout")), budget.policy.timeoutMs);
        let onAbort = () => { };
        const cancelled = new Promise((_, reject) => {
            onAbort = () => reject(controller.signal.reason);
            controller.signal.addEventListener("abort", onAbort, { once: true });
        });
        const bounded = async (work) => {
            const result = await Promise.race([work, cancelled]);
            check();
            return result;
        };
        let release;
        let creating = false;
        try {
            check();
            const request = new Request(original, { redirect: "error", signal: controller.signal });
            const retry = request.clone();
            const response = await bounded(transport(request));
            if (response.status !== 402)
                return response;
            const client = new x402Client();
            const http = new x402HTTPClient(client);
            const body = await bounded(challengeBody(response));
            // v2 normally uses PAYMENT-REQUIRED; accept the same validated envelope
            // in JSON too. The upstream HTTP decoder's body fallback is v1-only.
            let envelope;
            try {
                envelope = response.headers.has("PAYMENT-REQUIRED")
                    ? http.getPaymentRequiredResponse(name => response.headers.get(name))
                    : body;
            }
            catch {
                return fail("invalid payment challenge header");
            }
            const required = budget.select(envelope, request.url);
            const offer = required.accepts[0];
            release = budget.reserve(offer.amount);
            if (budget.policy.beforePayment) {
                const approved = await bounded(Promise.resolve(budget.policy.beforePayment(Object.freeze({ url: request.url,
                    network: offer.network, asset: offer.asset, payTo: offer.payTo,
                    feePayer: budget.policy.feePayer, amountAtomic: offer.amount }))));
                if (approved !== true)
                    fail("payment declined");
            }
            check();
            // RPC work can finish after our deadline. Guard the actual signer too so
            // an abandoned payment creation cannot sign later in the background.
            const guardedSigner = { ...signer, signTransactions: async (...args) => {
                    check();
                    return signer.signTransactions(...args);
                } };
            client.register(SOLANA_PAYMENT_NETWORK, new ExactSvmScheme(guardedSigner, { rpcUrl: budget.policy.rpcUrl }));
            creating = true;
            const payload = await bounded(client.createPaymentPayload(required));
            check();
            for (const [name, value] of Object.entries(http.encodePaymentSignatureHeader(payload)))
                retry.headers.set(name, value);
            return await bounded(transport(retry));
        }
        finally {
            if (!creating)
                release?.();
            clearTimeout(timer);
            original.signal.removeEventListener("abort", abort);
            controller.signal.removeEventListener("abort", onAbort);
        }
    };
}
