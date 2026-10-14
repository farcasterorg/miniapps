import type * as Address from 'ox/Address'
import * as Base64 from 'ox/Base64'
import type * as Hex from 'ox/Hex'
import * as Siwe from 'ox/Siwe'
import { InvalidTokenError } from './errors.ts'

/**
 * Marks a protocol Quick Auth token and versions its format. A token is
 * never a valid JWT, so a server accepting both can route on this.
 */
export const TOKEN_PREFIX = 'hqa1.'

/** Resource that names the FID being authenticated as. */
export const FID_RESOURCE_PREFIX = 'farcaster://fid/'

/** Default token lifetime, in seconds. */
export const DEFAULT_EXPIRES_IN = 3600

/**
 * The statement every token's message carries. Pinned so a token can't
 * be confused with another EIP-4361 message for the same domain — in
 * particular Farcaster's own Sign In With Farcaster messages, which use
 * the same `farcaster://fid/` resource.
 */
export function statement(fid: number): string {
  return `Authenticate as Farcaster FID ${fid}.`
}

export type CreateMessageParameters = {
  /** Host of the app the token is for, e.g. `example.com`. */
  domain: string
  /** Defaults to `https://${domain}/`. */
  uri?: string
  /** The address that will sign. */
  address: Address.Address
  chainId: number
  fid: number
  /** Defaults to now. */
  issuedAt?: Date
  /** Lifetime in seconds. Defaults to {@link DEFAULT_EXPIRES_IN}. */
  expiresIn?: number
  /** Defaults to a random nonce. */
  nonce?: string
}

/** The EIP-4361 message a wallet signs to produce a token. */
export function createMessage(parameters: CreateMessageParameters): string {
  const issuedAt = parameters.issuedAt ?? new Date()
  const expiresIn = parameters.expiresIn ?? DEFAULT_EXPIRES_IN
  return Siwe.createMessage({
    domain: parameters.domain,
    address: parameters.address,
    statement: statement(parameters.fid),
    uri: parameters.uri ?? `https://${parameters.domain}/`,
    version: '1',
    chainId: parameters.chainId,
    nonce: parameters.nonce ?? Siwe.generateNonce(),
    issuedAt,
    expirationTime: new Date(issuedAt.getTime() + expiresIn * 1000),
    resources: [`${FID_RESOURCE_PREFIX}${parameters.fid}`],
  })
}

/** `hqa1.<base64url(message)>.<base64url(signature)>` */
export function encodeToken(parameters: {
  message: string
  signature: Hex.Hex
}): string {
  const message = Base64.fromString(parameters.message, {
    url: true,
    pad: false,
  })
  const signature = Base64.fromHex(parameters.signature, {
    url: true,
    pad: false,
  })
  return `${TOKEN_PREFIX}${message}.${signature}`
}

export function isToken(token: string): boolean {
  return token.startsWith(TOKEN_PREFIX)
}

export function decodeToken(token: string): {
  message: string
  signature: Hex.Hex
} {
  if (!isToken(token)) {
    throw new InvalidTokenError('not a protocol Quick Auth token')
  }
  const parts = token.slice(TOKEN_PREFIX.length).split('.')
  const [message, signature] = parts
  if (parts.length !== 2 || !message || !signature) {
    throw new InvalidTokenError('malformed token')
  }
  try {
    return {
      message: Base64.toString(message),
      signature: Base64.toHex(signature),
    }
  } catch {
    throw new InvalidTokenError('malformed token')
  }
}
