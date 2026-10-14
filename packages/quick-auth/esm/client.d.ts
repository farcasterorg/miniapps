import { type Client as QuickAuthServerClient } from '@farcaster/quick-auth';
import * as Address from 'ox/Address';
import * as Hex from 'ox/Hex';
import { type HubOptions } from './hub.ts';
import { type Link, type LinkMethod } from './link.ts';
export declare const DEFAULT_HUB_URL = "https://haatz.quilibrium.com";
/** Issuer of classic Quick Auth JWTs (`sdk.quickAuth`). */
export declare const DEFAULT_QUICK_AUTH_SERVER_ORIGIN = "https://auth.farcaster.xyz";
export type VerifySignature = (parameters: {
    address: Address.Address;
    message: string;
    signature: Hex.Hex;
}) => Promise<boolean>;
export type CreateClientOptions = Partial<Omit<HubOptions, 'hubUrl'>> & {
    /** Default {@link DEFAULT_HUB_URL}. */
    hubUrl?: string;
    /** App FIDs whose signers may vouch for a verified address. Default `[9152]`. */
    trustedAppFids?: readonly number[];
    /** Accepted link kinds. Default all of custody, auth address, verified. */
    methods?: readonly LinkMethod[];
    /** Longest token lifetime accepted, in seconds. Default 3600. */
    maxTokenLifetime?: number;
    /** Tolerated clock skew, in seconds. Default 300. */
    clockSkew?: number;
    /**
     * How long a resolved address↔FID link is reused, in seconds. Default
     * 60. Bounds how long a removed verification or transferred custody
     * keeps working.
     */
    linkCacheTtl?: number;
    /**
     * Checks signatures that aren't a 65-byte EOA signature over the
     * message (smart-contract wallets, EIP-1271/6492). Without it those
     * tokens are rejected. With viem:
     * `({ address, message, signature }) => publicClient.verifyMessage({ address, message, signature })`
     */
    verifySignature?: VerifySignature;
    /**
     * Also accept classic Quick Auth JWTs (from `sdk.quickAuth`), verified
     * against the Quick Auth server's JWKS exactly as `@farcaster/quick-auth`
     * does. Default true, so this client is a drop-in for that one.
     */
    acceptQuickAuthJwt?: boolean;
    /**
     * The Quick Auth server: issuer of those JWTs, and where
     * `generateNonce` and `verifySiwf` go. Default
     * {@link DEFAULT_QUICK_AUTH_SERVER_ORIGIN}.
     */
    quickAuthServerOrigin?: string;
    /** `@farcaster/quick-auth`'s name for {@link quickAuthServerOrigin}. */
    origin?: string;
};
export type VerifyTokenOptions = {
    token: string;
    /** Host the token must be for, e.g. `example.com`. */
    domain: string;
};
type Claims = {
    /** The FID. */
    sub: number;
    /** The domain the token is for. */
    aud: string;
    iat: number;
    exp: number;
};
/** `@farcaster/quick-auth`'s `JWTPayload`, plus how the FID was proven. */
export type TokenPayload = (Claims & {
    /** The hub the link was checked against. */
    iss: string;
    /** A protocol token: how the signing address is linked to the FID. */
    method: LinkMethod;
    /** The address that signed. */
    address: Address.Address;
    /** For `verified`: the app whose signer added the verification. */
    appFid?: number;
}) | (Claims & {
    /** The Quick Auth server that issued the JWT. */
    iss: string;
    /**
     * A classic Quick Auth JWT: the server vouched for the user's
     * custody or an auth address.
     */
    method: 'quickAuthServer';
    /** Only if the server put one in the JWT; auth.farcaster.xyz doesn't. */
    address?: Address.Address;
});
export type LinkedAccount = {
    fid: number;
    username?: string;
    displayName?: string;
    pfpUrl?: string;
    link: Link;
};
export type Client = {
    verifyToken: (options: VerifyTokenOptions) => Promise<TokenPayload>;
    /** Alias of `verifyToken`, for drop-in use where `@farcaster/quick-auth`'s `verifyJwt` was. */
    verifyJwt: (options: VerifyTokenOptions) => Promise<TokenPayload>;
    /**
     * FIDs `address` can sign in as, for an account picker. Discovery
     * comes from the hub's account index; each candidate is then held to
     * the same link policy as `verifyToken`. Accepted links first.
     */
    linkedAccounts: (address: Address.Address) => Promise<LinkedAccount[]>;
    /** Gets a nonce from the Quick Auth server, as `@farcaster/quick-auth` does. */
    generateNonce: QuickAuthServerClient['generateNonce'];
    /**
     * Exchanges a Sign In with Farcaster message and signature for a
     * Quick Auth JWT from the Quick Auth server, as `@farcaster/quick-auth`
     * does.
     */
    verifySiwf: QuickAuthServerClient['verifySiwf'];
};
export declare function createClient(options?: CreateClientOptions): Client;
export declare namespace createClient {
    type Options = CreateClientOptions;
    type ReturnType = Client;
}
export {};
