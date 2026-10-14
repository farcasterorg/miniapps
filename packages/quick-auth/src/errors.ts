import { Errors as QuickAuthErrors } from '@farcaster/quick-auth'

// `@farcaster/quick-auth`'s error classes, so `Errors` here is a superset
// of its `Errors`: code written against that package catches the same
// classes, and `instanceof` agrees across the two packages.

export const BaseError = QuickAuthErrors.BaseError
export type BaseError<cause extends Error | undefined = undefined> =
  QuickAuthErrors.BaseError<cause>
export const ResponseError = QuickAuthErrors.ResponseError
export type ResponseError = QuickAuthErrors.ResponseError
export const InvalidSiwfError = QuickAuthErrors.InvalidSiwfError
export type InvalidSiwfError = QuickAuthErrors.InvalidSiwfError
export const InvalidParametersError = QuickAuthErrors.InvalidParametersError
export type InvalidParametersError = QuickAuthErrors.InvalidParametersError
export type GlobalErrorType<name extends string = 'Error'> =
  QuickAuthErrors.GlobalErrorType<name>

/**
 * The token can't be accepted: malformed, expired, for another domain,
 * badly signed, or signed by an address that isn't linked to the FID.
 * Answer 401.
 *
 * A subclass of `@farcaster/quick-auth`'s `InvalidTokenError`, so a check
 * against either package's class matches.
 */
export class InvalidTokenError extends QuickAuthErrors.InvalidTokenError {}

/**
 * The hub (or the Quick Auth server's JWKS) couldn't be reached or
 * answered unexpectedly, so the token could be neither accepted nor
 * rejected. Answer 503 and let the client retry; never treat this as a
 * rejection.
 */
export class HubError extends BaseError<Error | undefined> {
  constructor(message: string, options: { cause?: unknown } = {}) {
    const { cause } = options
    super(message, {
      cause:
        cause === undefined || cause instanceof Error
          ? cause
          : new Error(String(cause)),
    })
    this.name = 'HubError'
  }
}
