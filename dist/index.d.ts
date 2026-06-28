#!/usr/bin/env node
export type AuthMode = "madeonsol" | "x402" | "none";
/**
 * Pure selection of the auth mode from environment. Extracted from initAuth()
 * so the routing/auth-mode logic is unit-testable without setting up signers or
 * network. Priority: MADEONSOL_API_KEY (Bearer) > SVM_PRIVATE_KEY (x402) > none.
 */
export declare function resolveAuthMode(env?: {
    MADEONSOL_API_KEY?: string;
    SVM_PRIVATE_KEY?: string;
}): AuthMode;
/**
 * Pure path rewrite. Tools are authored against /api/x402/ paths. In x402 / none
 * mode the path is kept as-is; in madeonsol (API key) mode the prefix is
 * rewritten to /api/v1/. Extracted from query() so it is unit-testable.
 */
export declare function rewritePath(path: string, mode: AuthMode): string;
