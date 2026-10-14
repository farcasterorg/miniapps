import type * as Address from 'ox/Address';
import type { Hub } from './hub.ts';
/**
 * How the signing address relates to the FID:
 *
 * - `custody` — the FID's current custody address.
 * - `authAddress` — an auth address (KeyRegistry keyType 2) the custody
 *   registered for signing in.
 * - `verified` — a verified address, accepted only if the verification
 *   was added by a signer that a trusted app (or the user themselves)
 *   requested. Any active signer can add a verification, so without
 *   that rule any app holding a signer could verify its own wallet on a
 *   user's FID and sign in as them.
 */
export type LinkMethod = 'custody' | 'authAddress' | 'verified';
export declare const ALL_LINK_METHODS: readonly LinkMethod[];
/** The Farcaster app. */
export declare const DEFAULT_TRUSTED_APP_FIDS: readonly number[];
export type LinkPolicy = {
    /** App FIDs whose signers may vouch for a verified address. */
    trustedAppFids: readonly number[];
    /** Which kinds of link are accepted. */
    methods: readonly LinkMethod[];
};
export type Link = {
    linked: true;
    method: LinkMethod;
    appFid?: number;
} | {
    linked: false;
    reason: 'unlinked' | 'untrusted_verifier';
    /** For `untrusted_verifier`: the app that added the verification, if known. */
    appFid?: number;
};
export declare function resolveLink(hub: Hub, fid: number, address: Address.Address, policy: LinkPolicy): Promise<Link>;
export declare function describeRejection(link: Extract<Link, {
    linked: false;
}>, fid: number, address: Address.Address): string;
