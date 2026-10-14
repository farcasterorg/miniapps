import {
  createMessage,
  DEFAULT_EXPIRES_IN,
  encodeToken,
} from '@farcasterorg/quick-auth/token'
import type * as Address from 'ox/Address'
import * as Hex from 'ox/Hex'
import type * as Provider from 'ox/Provider'

import { getEthereumProvider } from './ethereumProvider.ts'
import { miniAppHost } from './miniAppHost.ts'

export declare namespace getToken {
  type Options = {
    /**
     * Acquire a new token even if one is already in memory and not expired.
     *
     * @default false
     */
    force?: boolean

    /**
     * EIP-1193 wallet to sign with. Defaults to the host's wallet inside a
     * Mini App; required outside one.
     */
    provider?: Provider.Provider

    /**
     * FID to authenticate as. Defaults to the Mini App's user; required
     * outside a Mini App. The server checks the signing address is linked
     * to it, so this is only a claim.
     */
    fid?: number

    /**
     * Token lifetime in seconds. Must not exceed what the verifying server
     * accepts.
     *
     * @default 3600
     */
    expiresIn?: number
  }

  type ReturnValue = { token: string }
  type ReturnType = Promise<ReturnValue>

  type ErrorType = Provider.UserRejectedRequestError | Error
}

/**
 * Protocol Quick Auth: like `sdk.quickAuth`, but with no auth server.
 * The token is an EIP-4361 message naming the FID, signed by a wallet
 * linked to it, and servers verify it against Farcaster protocol state
 * with `@farcasterorg/quick-auth`. `sdk.quickAuth` is unchanged.
 */
export type ProtocolAuth = {
  /**
   * Returns the token if one is present and not expired.
   */
  readonly token: string | undefined

  /**
   * Get a protocol Quick Auth token (`hqa1.…`).
   *
   * If a token is already in memory and not expired it will be returned
   * unless `force` is used or a different `fid` is asked for. Otherwise
   * the wallet is asked to sign a new one.
   */
  getToken: (options?: getToken.Options) => getToken.ReturnType

  /**
   * Make an authenticated fetch request. The `Authorization` header will
   * contain `Bearer ${token}` where token is a protocol Quick Auth token.
   */
  fetch: typeof fetch
}

/** Tokens are renewed this long before they expire. */
const RENEW_MARGIN_MS = 15_000

/** How long to wait for a Mini App host to answer before assuming none. */
const HOST_TIMEOUT_MS = 1000

export const protocolAuth: ProtocolAuth = (() => {
  let current: { token: string; fid: number; expiresAt: number } | undefined
  let pendingPromise: Promise<getToken.ReturnValue> | undefined

  function live(fid?: number) {
    if (
      current &&
      current.expiresAt > Date.now() + RENEW_MARGIN_MS &&
      (fid === undefined || fid === current.fid)
    ) {
      return current
    }
    return undefined
  }

  async function getTokenInner(options: getToken.Options): getToken.ReturnType {
    if (typeof window === 'undefined') {
      throw new Error('protocolAuth.getToken must run in a browser')
    }

    const context =
      options.fid === undefined || !options.provider
        ? await hostContext()
        : undefined
    const fid = options.fid ?? context?.user.fid
    const provider =
      options.provider ?? (context ? await getEthereumProvider() : undefined)
    if (fid === undefined || !provider) {
      throw new Error(
        'Outside a Mini App, pass `provider` and `fid` to protocolAuth.getToken',
      )
    }

    const address = await signingAddress(provider)
    const expiresIn = options.expiresIn ?? DEFAULT_EXPIRES_IN
    const issuedAt = new Date()
    const message = createMessage({
      domain: window.location.host,
      uri: `${window.location.origin}/`,
      address,
      chainId: await chainId(provider),
      fid,
      issuedAt,
      expiresIn,
    })
    const signature = await provider.request({
      method: 'personal_sign',
      params: [Hex.fromString(message), address],
    })

    const token = encodeToken({ message, signature })
    current = {
      token,
      fid,
      expiresAt: issuedAt.getTime() + expiresIn * 1000,
    }
    return { token }
  }

  return {
    get token() {
      return live()?.token
    },
    async getToken(options = {}) {
      const cached = !options.force && live(options.fid)
      if (cached) {
        return { token: cached.token }
      }

      if (!pendingPromise) {
        pendingPromise = getTokenInner(options).finally(() => {
          pendingPromise = undefined
        })
      }

      return pendingPromise
    },
    async fetch(url, options) {
      const { token } = await this.getToken()

      const headers = new Headers(options?.headers)
      headers.set('Authorization', `Bearer ${token}`)

      return fetch(url, {
        ...options,
        headers,
      })
    },
  }
})()

/**
 * The Mini App context, or `undefined` outside a Mini App. Mirrors
 * `sdk.isInMiniApp`'s short-circuit so a plain page never waits on a host
 * that isn't there.
 */
async function hostContext() {
  if (!window.ReactNativeWebView && window === window.parent) {
    return undefined
  }
  return Promise.race([
    miniAppHost.context,
    new Promise<undefined>((resolve) =>
      setTimeout(() => resolve(undefined), HOST_TIMEOUT_MS),
    ),
  ]).catch(() => undefined)
}

async function signingAddress(
  provider: Provider.Provider,
): Promise<Address.Address> {
  const accounts = await provider.request({ method: 'eth_accounts' })
  const [address] = accounts.length
    ? accounts
    : await provider.request({ method: 'eth_requestAccounts' })
  if (!address) {
    throw new Error('The wallet has no account to sign with')
  }
  return address
}

async function chainId(provider: Provider.Provider): Promise<number> {
  try {
    return Hex.toNumber(await provider.request({ method: 'eth_chainId' }))
  } catch {
    // The chain doesn't matter for an EOA signature; any valid id will do.
    return 1
  }
}
