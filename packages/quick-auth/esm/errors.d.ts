import { Errors as QuickAuthErrors } from '@farcaster/quick-auth';
export declare const BaseError: typeof QuickAuthErrors.BaseError;
export type BaseError<cause extends Error | undefined = undefined> = QuickAuthErrors.BaseError<cause>;
export declare const ResponseError: typeof QuickAuthErrors.ResponseError;
export type ResponseError = QuickAuthErrors.ResponseError;
export declare const InvalidSiwfError: typeof QuickAuthErrors.InvalidSiwfError;
export type InvalidSiwfError = QuickAuthErrors.InvalidSiwfError;
export declare const InvalidParametersError: typeof QuickAuthErrors.InvalidParametersError;
export type InvalidParametersError = QuickAuthErrors.InvalidParametersError;
export type GlobalErrorType<name extends string = 'Error'> = QuickAuthErrors.GlobalErrorType<name>;
/**
 * The token can't be accepted: malformed, expired, for another domain,
 * badly signed, or signed by an address that isn't linked to the FID.
 * Answer 401.
 *
 * A subclass of `@farcaster/quick-auth`'s `InvalidTokenError`, so a check
 * against either package's class matches.
 */
export declare class InvalidTokenError extends QuickAuthErrors.InvalidTokenError {
}
/**
 * The hub (or the Quick Auth server's JWKS) couldn't be reached or
 * answered unexpectedly, so the token could be neither accepted nor
 * rejected. Answer 503 and let the client retry; never treat this as a
 * rejection.
 */
export declare class HubError extends BaseError<Error | undefined> {
    constructor(message: string, options?: {
        cause?: unknown;
    });
}
