import {
  createClient as createQuickAuthServerClient,
  Errors as QuickAuthErrors,
  type Client as QuickAuthServerClient,
} from '@farcaster/quick-auth'
import * as Address from 'ox/Address'
import * as Hex from 'ox/Hex'
import * as PersonalMessage from 'ox/PersonalMessage'
import * as Secp256k1 from 'ox/Secp256k1'
import * as Signature from 'ox/Signature'
import * as Siwe from 'ox/Siwe'
import { HubError, InvalidTokenError } from './errors.ts'
import { createHub, type HubOptions } from './hub.ts'
import {
  ALL_LINK_METHODS,
  DEFAULT_TRUSTED_APP_FIDS,
  describeRejection,
  type Link,
  type LinkMethod,
  resolveLink,
} from './link.ts'
import {
  DEFAULT_EXPIRES_IN,
  decodeToken,
  FID_RESOURCE_PREFIX,
  isToken,
  statement,
} from './token.ts'

export const DEFAULT_HUB_URL = 'https://haatz.quilibrium.com'

/** Issuer of classic Quick Auth JWTs (`sdk.quickAuth`). */
export const DEFAULT_QUICK_AUTH_SERVER_ORIGIN = 'https://auth.farcaster.xyz'

/**
 * jose error codes that mean "couldn't check right now" rather than "bad
 * token": the JWKS fetch timed out or came back unusable.
 */
const JWKS_UNAVAILABLE_CODES = new Set(['ERR_JWKS_TIMEOUT', 'ERR_JWKS_INVALID'])

export type VerifySignature = (parameters: {
  address: Address.Address
  message: string
  signature: Hex.Hex
}) => Promise<boolean>

export type CreateClientOptions = Partial<Omit<HubOptions, 'hubUrl'>> & {
  /** Default {@link DEFAULT_HUB_URL}. */
  hubUrl?: string
  /** App FIDs whose signers may vouch for a verified address. Default `[9152]`. */
  trustedAppFids?: readonly number[]
  /** Accepted link kinds. Default all of custody, auth address, verified. */
  methods?: readonly LinkMethod[]
  /** Longest token lifetime accepted, in seconds. Default 3600. */
  maxTokenLifetime?: number
  /** Tolerated clock skew, in seconds. Default 300. */
  clockSkew?: number
  /**
   * How long a resolved address↔FID link is reused, in seconds. Default
   * 60. Bounds how long a removed verification or transferred custody
   * keeps working.
   */
  linkCacheTtl?: number
  /**
   * Checks signatures that aren't a 65-byte EOA signature over the
   * message (smart-contract wallets, EIP-1271/6492). Without it those
   * tokens are rejected. With viem:
   * `({ address, message, signature }) => publicClient.verifyMessage({ address, message, signature })`
   */
  verifySignature?: VerifySignature
  /**
   * Also accept classic Quick Auth JWTs (from `sdk.quickAuth`), verified
   * against the Quick Auth server's JWKS exactly as `@farcaster/quick-auth`
   * does. Default true, so this client is a drop-in for that one.
   */
  acceptQuickAuthJwt?: boolean
  /**
   * The Quick Auth server: issuer of those JWTs, and where
   * `generateNonce` and `verifySiwf` go. Default
   * {@link DEFAULT_QUICK_AUTH_SERVER_ORIGIN}.
   */
  quickAuthServerOrigin?: string
  /** `@farcaster/quick-auth`'s name for {@link quickAuthServerOrigin}. */
  origin?: string
}

export type VerifyTokenOptions = {
  token: string
  /** Host the token must be for, e.g. `example.com`. */
  domain: string
}

type Claims = {
  /** The FID. */
  sub: number
  /** The domain the token is for. */
  aud: string
  iat: number
  exp: number
}

/** `@farcaster/quick-auth`'s `JWTPayload`, plus how the FID was proven. */
export type TokenPayload =
  | (Claims & {
      /** The hub the link was checked against. */
      iss: string
      /** A protocol token: how the signing address is linked to the FID. */
      method: LinkMethod
      /** The address that signed. */
      address: Address.Address
      /** For `verified`: the app whose signer added the verification. */
      appFid?: number
    })
  | (Claims & {
      /** The Quick Auth server that issued the JWT. */
      iss: string
      /**
       * A classic Quick Auth JWT: the server vouched for the user's
       * custody or an auth address.
       */
      method: 'quickAuthServer'
      /** Only if the server put one in the JWT; auth.farcaster.xyz doesn't. */
      address?: Address.Address
    })

export type LinkedAccount = {
  fid: number
  username?: string
  displayName?: string
  pfpUrl?: string
  link: Link
}

const MAX_CACHE_ENTRIES = 10_000
/** An address maps to at most one custody FID and one verified FID. */
const MAX_CANDIDATES = 4

export type Client = {
  verifyToken: (options: VerifyTokenOptions) => Promise<TokenPayload>
  /** Alias of `verifyToken`, for drop-in use where `@farcaster/quick-auth`'s `verifyJwt` was. */
  verifyJwt: (options: VerifyTokenOptions) => Promise<TokenPayload>
  /**
   * FIDs `address` can sign in as, for an account picker. Discovery
   * comes from the hub's account index; each candidate is then held to
   * the same link policy as `verifyToken`. Accepted links first.
   */
  linkedAccounts: (address: Address.Address) => Promise<LinkedAccount[]>
  /** Gets a nonce from the Quick Auth server, as `@farcaster/quick-auth` does. */
  generateNonce: QuickAuthServerClient['generateNonce']
  /**
   * Exchanges a Sign In with Farcaster message and signature for a
   * Quick Auth JWT from the Quick Auth server, as `@farcaster/quick-auth`
   * does.
   */
  verifySiwf: QuickAuthServerClient['verifySiwf']
}

export function createClient(options: CreateClientOptions = {}): Client {
  const hubUrl = options.hubUrl ?? DEFAULT_HUB_URL
  const hub = createHub({ ...options, hubUrl })
  const policy = {
    trustedAppFids: options.trustedAppFids ?? DEFAULT_TRUSTED_APP_FIDS,
    methods: options.methods ?? ALL_LINK_METHODS,
  }
  const maxLifetime = options.maxTokenLifetime ?? DEFAULT_EXPIRES_IN
  const skew = options.clockSkew ?? 300
  const cacheTtlMs = (options.linkCacheTtl ?? 60) * 1000
  const quickAuthServerOrigin =
    options.quickAuthServerOrigin ??
    options.origin ??
    DEFAULT_QUICK_AUTH_SERVER_ORIGIN
  const acceptQuickAuthJwt = options.acceptQuickAuthJwt !== false
  const quickAuthServer = createQuickAuthServerClient({
    origin: quickAuthServerOrigin,
  })

  // In-flight and recent link lookups, keyed by fid:address. Holding
  // the promise also coalesces concurrent requests for the same key.
  const cache = new Map<string, { link: Promise<Link>; expires: number }>()

  function cachedLink(fid: number, address: Address.Address): Promise<Link> {
    const key = `${fid}:${address.toLowerCase()}`
    const now = Date.now()
    const hit = cache.get(key)
    if (hit && hit.expires > now) return hit.link
    const link = resolveLink(hub, fid, address, policy)
    cache.set(key, { link, expires: now + cacheTtlMs })
    // A hub failure must not be remembered as an answer.
    link.catch(() => cache.delete(key))
    if (cache.size > MAX_CACHE_ENTRIES) {
      for (const [k, v] of cache) {
        if (v.expires <= now || cache.size > MAX_CACHE_ENTRIES) cache.delete(k)
        else break
      }
    }
    return link
  }

  async function verifyToken({
    token,
    domain,
  }: VerifyTokenOptions): Promise<TokenPayload> {
    if (!isToken(token) && acceptQuickAuthJwt) {
      return verifyQuickAuthJwt(token, domain)
    }
    const { message, signature } = decodeToken(token)
    const fields = parseCanonical(message)
    const now = Math.floor(Date.now() / 1000)

    if (fields.domain.toLowerCase() !== domain.toLowerCase()) {
      throw new InvalidTokenError(
        `token is for ${fields.domain}, not ${domain}`,
      )
    }
    let uri: URL
    try {
      uri = new URL(fields.uri)
    } catch {
      throw new InvalidTokenError('invalid URI')
    }
    if (
      !['https:', 'http:'].includes(uri.protocol) ||
      uri.host.toLowerCase() !== domain.toLowerCase()
    ) {
      throw new InvalidTokenError('URI must be an http(s) URI on the domain')
    }
    if (fields.version !== '1') {
      throw new InvalidTokenError(`unsupported version ${fields.version}`)
    }

    const fid = fidFromResources(fields.resources)
    if (fields.statement !== statement(fid)) {
      throw new InvalidTokenError('not a protocol Quick Auth message')
    }

    if (!fields.issuedAt || !fields.expirationTime) {
      throw new InvalidTokenError('Issued At and Expiration Time are required')
    }
    const iat = Math.floor(fields.issuedAt.getTime() / 1000)
    const exp = Math.floor(fields.expirationTime.getTime() / 1000)
    if (iat > now + skew) throw new InvalidTokenError('issued in the future')
    if (exp <= now) throw new InvalidTokenError('token has expired')
    if (exp - iat > maxLifetime) {
      throw new InvalidTokenError(
        `token lifetime ${exp - iat}s exceeds the ${maxLifetime}s maximum`,
      )
    }
    if (fields.notBefore && fields.notBefore.getTime() / 1000 > now + skew) {
      throw new InvalidTokenError('token is not valid yet')
    }

    if (!(await signatureMatches(fields.address, message, signature))) {
      throw new InvalidTokenError(
        "signature wasn't made by the message's address",
      )
    }

    const link = await cachedLink(fid, fields.address)
    if (!link.linked) {
      throw new InvalidTokenError(describeRejection(link, fid, fields.address))
    }

    return {
      sub: fid,
      address: fields.address,
      aud: fields.domain,
      iss: hubUrl,
      iat,
      exp,
      method: link.method,
      ...(link.appFid !== undefined ? { appFid: link.appFid } : {}),
    }
  }

  async function verifyQuickAuthJwt(
    token: string,
    domain: string,
  ): Promise<TokenPayload> {
    try {
      const payload = await quickAuthServer.verifyJwt({ token, domain })
      // These are the JWT's raw claims, whatever the type says: the server
      // issues `sub` as a string and has stopped including `address`.
      const { address } = payload as { address?: unknown }
      return {
        sub: Number(payload.sub),
        aud: String(payload.aud),
        iss: String(payload.iss),
        iat: Number(payload.iat ?? 0),
        exp: Number(payload.exp ?? 0),
        method: 'quickAuthServer',
        ...(typeof address === 'string' && Address.validate(address)
          ? { address }
          : {}),
      }
    } catch (e) {
      const code = (e as { code?: unknown } | null)?.code
      const badToken =
        e instanceof QuickAuthErrors.InvalidTokenError ||
        (typeof code === 'string' &&
          code.startsWith('ERR_J') &&
          !JWKS_UNAVAILABLE_CODES.has(code))
      if (badToken) {
        throw new InvalidTokenError(
          `invalid Quick Auth JWT: ${(e as Error).message}`,
        )
      }
      throw new HubError(
        `couldn't verify Quick Auth JWT against ${quickAuthServerOrigin}`,
        { cause: e },
      )
    }
  }

  async function signatureMatches(
    address: Address.Address,
    message: string,
    signature: Hex.Hex,
  ): Promise<boolean> {
    if (Hex.size(signature) === 65) {
      try {
        const recovered = Secp256k1.recoverAddress({
          payload: PersonalMessage.getSignPayload(Hex.fromString(message)),
          signature: Signature.fromHex(signature),
        })
        if (Address.isEqual(recovered, address)) return true
      } catch {
        // Not a recoverable EOA signature; maybe a contract wallet's.
      }
    }
    return options.verifySignature
      ? options.verifySignature({ address, message, signature })
      : false
  }

  async function linkedAccounts(
    address: Address.Address,
  ): Promise<LinkedAccount[]> {
    const users = await hub.usersByAddress(address)
    const unique = [...new Map(users.map((u) => [u.fid, u])).values()]
    const candidates = unique.slice(0, MAX_CANDIDATES)
    const links = await Promise.all(
      candidates.map((u) => cachedLink(u.fid, address)),
    )
    return candidates
      .map((u, i) => ({ ...u, link: links[i] as Link }))
      .sort((a, b) => Number(b.link.linked) - Number(a.link.linked))
  }

  return {
    verifyToken,
    verifyJwt: verifyToken,
    linkedAccounts,
    generateNonce: quickAuthServer.generateNonce,
    verifySiwf: quickAuthServer.verifySiwf,
  }
}

// `@farcaster/quick-auth`'s type names, for code written against it.
export declare namespace createClient {
  type Options = CreateClientOptions
  type ReturnType = Client
}

/**
 * Parse an EIP-4361 message and insist it's byte-for-byte what
 * re-serializing it produces. The signature covers the raw text, so any
 * slack between what was signed and what was parsed (extra lines,
 * odd whitespace, alternate spellings) is refused outright.
 */
function parseCanonical(message: string) {
  let parsed: ReturnType<typeof Siwe.parseMessage>
  try {
    parsed = Siwe.parseMessage(message)
    if (Siwe.createMessage(parsed as Siwe.Message) === message) {
      return parsed as Siwe.Message & { statement?: string }
    }
  } catch {
    // fall through
  }
  throw new InvalidTokenError('malformed message')
}

function fidFromResources(resources: readonly string[] | undefined): number {
  if (
    resources?.length !== 1 ||
    !resources[0]?.startsWith(FID_RESOURCE_PREFIX)
  ) {
    throw new InvalidTokenError(
      `message must have exactly one resource, ${FID_RESOURCE_PREFIX}<fid>`,
    )
  }
  const raw = resources[0].slice(FID_RESOURCE_PREFIX.length)
  if (!/^[1-9][0-9]{0,15}$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
    throw new InvalidTokenError('malformed FID resource')
  }
  return Number(raw)
}
