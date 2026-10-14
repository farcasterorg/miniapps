import type * as Address from 'ox/Address';
import type * as Hex from 'ox/Hex';
/**
 * Marks a protocol Quick Auth token and versions its format. A token is
 * never a valid JWT, so a server accepting both can route on this.
 */
export declare const TOKEN_PREFIX = "hqa1.";
/** Resource that names the FID being authenticated as. */
export declare const FID_RESOURCE_PREFIX = "farcaster://fid/";
/** Default token lifetime, in seconds. */
export declare const DEFAULT_EXPIRES_IN = 3600;
/**
 * The statement every token's message carries. Pinned so a token can't
 * be confused with another EIP-4361 message for the same domain — in
 * particular Farcaster's own Sign In With Farcaster messages, which use
 * the same `farcaster://fid/` resource.
 */
export declare function statement(fid: number): string;
export type CreateMessageParameters = {
    /** Host of the app the token is for, e.g. `example.com`. */
    domain: string;
    /** Defaults to `https://${domain}/`. */
    uri?: string;
    /** The address that will sign. */
    address: Address.Address;
    chainId: number;
    fid: number;
    /** Defaults to now. */
    issuedAt?: Date;
    /** Lifetime in seconds. Defaults to {@link DEFAULT_EXPIRES_IN}. */
    expiresIn?: number;
    /** Defaults to a random nonce. */
    nonce?: string;
};
/** The EIP-4361 message a wallet signs to produce a token. */
export declare function createMessage(parameters: CreateMessageParameters): string;
/** `hqa1.<base64url(message)>.<base64url(signature)>` */
export declare function encodeToken(parameters: {
    message: string;
    signature: Hex.Hex;
}): string;
export declare function isToken(token: string): boolean;
export declare function decodeToken(token: string): {
    message: string;
    signature: Hex.Hex;
};
