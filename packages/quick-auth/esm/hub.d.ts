import type * as Address from 'ox/Address';
import type * as Hex from 'ox/Hex';
export type HubOptions = {
    /** Base URL of a hub's HTTP API, e.g. `https://haatz.quilibrium.com`. */
    hubUrl: string;
    fetch?: typeof fetch;
    requestInit?: RequestInit;
    /** Per-request timeout in milliseconds. Default 30000. */
    timeoutMs?: number;
};
/**
 * `requestFid` — the app that asked for the key — from an on-chain
 * signer event's SignedKeyRequest metadata. The KeyRegistry's validator
 * checked it was signed by that app's custody when the key was added.
 */
export declare function requestFidFromMetadata(metadataBase64: string, metadataType: number): number | undefined;
export type HubUser = {
    fid: number;
    username?: string;
    displayName?: string;
    pfpUrl?: string;
};
/**
 * The hub reads protocol Quick Auth needs. Every method returns
 * `undefined` for "not found" (hubs answer that with a 400) and throws
 * {@link HubError} for anything else that isn't a success.
 */
export type Hub = ReturnType<typeof createHub>;
export declare function createHub(options: HubOptions): {
    /** Current custody and live verification status of `address` for `fid`. */
    addressType(fid: number, address: Address.Address): Promise<{
        is_custody: boolean;
        is_verified: boolean;
    } | undefined>;
    /** Key of the signer that added the live ETH verification of `address`. */
    verificationSigner(fid: number, address: Address.Address): Promise<Hex.Hex | undefined>;
    /**
     * `requestFid` of an *active* signer, from the gasless key record or
     * the on-chain event's metadata. `undefined` if the signer isn't
     * active or can't be attributed.
     */
    signerRequestFid(fid: number, signer: Hex.Hex): Promise<number | undefined>;
    /**
     * Whether `address` is a currently registered auth address
     * (KeyRegistry keyType 2) for `fid`. Worked out from the signer event
     * history: the latest event for the key decides. Auth-address keys
     * are stored left-padded to 32 bytes.
     */
    isAuthAddress(fid: number, address: Address.Address): Promise<boolean>;
    /**
     * FIDs a hub's account index associates with `address`. Discovery
     * only — these are candidates to check, not links. Needs the
     * `/v2/farcaster/user/bulk-by-address` API (haatz, Neynar).
     */
    usersByAddress(address: Address.Address): Promise<HubUser[]>;
};
