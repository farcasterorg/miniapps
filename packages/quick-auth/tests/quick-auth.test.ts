import * as AbiParameters from 'ox/AbiParameters'
import * as Address from 'ox/Address'
import * as Base64 from 'ox/Base64'
import * as Hex from 'ox/Hex'
import * as PersonalMessage from 'ox/PersonalMessage'
import * as Secp256k1 from 'ox/Secp256k1'
import * as Signature from 'ox/Signature'
import { describe, expect, test, vi } from 'vitest'
import {
  createClient,
  createMessage,
  decodeToken,
  encodeToken,
  HubError,
  InvalidTokenError,
  isToken,
  requestFidFromMetadata,
} from '../src/index.ts'

const DOMAIN = 'example.com'
const FID = 4242

// ---------------------------------------------------------------------
// Fake hub
// ---------------------------------------------------------------------

type FakeHub = {
  custody?: Record<number, Address.Address>
  verifications?: { fid: number; address: Address.Address; signer: Hex.Hex }[]
  /** `${fid}:${signer}` → how the hub describes that active signer. */
  signers?: Record<string, { gasless?: number; onchain?: number }>
  authEvents?: {
    fid: number
    key: Hex.Hex
    eventType: 'ADD' | 'REMOVE' | 'ADMIN_RESET'
    blockNumber: number
    logIndex?: number
  }[]
  /** address (lowercase) → FIDs bulk-by-address returns. */
  users?: Record<string, number[]>
  /** path → status to answer with instead. */
  status?: Record<string, number>
}

const signedKeyRequestAbi = AbiParameters.from([
  'struct SignedKeyRequest { uint256 requestFid; address requestSigner; bytes signature; uint256 deadline; }',
  'SignedKeyRequest',
])

function metadataFor(requestFid: number): string {
  const encoded = AbiParameters.encode(signedKeyRequestAbi, [
    {
      requestFid: BigInt(requestFid),
      requestSigner: '0x1111111111111111111111111111111111111111',
      signature: '0x',
      deadline: 1n,
    },
  ])
  return Base64.fromHex(encoded)
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status })
}

function fakeFetch(hub: FakeHub, calls: string[] = []): typeof fetch {
  return (async (input: URL | RequestInfo) => {
    const url = new URL(input.toString())
    const q = url.searchParams
    calls.push(url.pathname)
    const forced = hub.status?.[url.pathname]
    if (forced) return json({ error: 'forced' }, forced)
    const fid = Number(q.get('fid'))
    const sameAddress = (a: string) =>
      a.toLowerCase() === q.get('address')?.toLowerCase()

    switch (url.pathname) {
      case '/v1/fidAddressType':
        return json({
          is_custody: sameAddress(hub.custody?.[fid] ?? ''),
          is_auth: false,
          is_verified: (hub.verifications ?? []).some(
            (v) => v.fid === fid && sameAddress(v.address),
          ),
        })
      case '/v1/verificationsByFid': {
        const verification = (
          address: string,
          protocol: string,
          signer: string,
        ) => ({
          data: { fid, verificationAddAddressBody: { address, protocol } },
          signer,
        })
        if (!q.get('pageToken')) {
          // Decoys first, real verifications on page two.
          return json({
            messages: [
              verification(
                'ExAqci8uUVKtqHqFW58fmwgMMY9PATfRGGyv6837j9Lx',
                'PROTOCOL_SOLANA',
                '0x01',
              ),
              verification(`0x${'de'.repeat(20)}`, 'PROTOCOL_ETHEREUM', '0x02'),
              { dataBytes: 'AAAA', signer: '0x03' },
            ],
            nextPageToken: 'page2',
          })
        }
        return json({
          messages: (hub.verifications ?? [])
            .filter((v) => v.fid === fid)
            .map((v) => verification(v.address, 'PROTOCOL_ETHEREUM', v.signer)),
          nextPageToken: '',
        })
      }
      case '/v1/signer': {
        const s = hub.signers?.[`${fid}:${q.get('signer')}`]
        if (!s) return json({ error: 'Failed to get signer' }, 400)
        if (s.gasless !== undefined) {
          return json({
            signer: { source: 'SIGNER_SOURCE_OFFCHAIN', requestFid: s.gasless },
          })
        }
        return json({
          signer: {
            source: 'SIGNER_SOURCE_ONCHAIN',
            onChainEvent: {
              signerEventBody: {
                metadata: metadataFor(s.onchain ?? 0),
                metadataType: 1,
              },
            },
          },
        })
      }
      case '/v1/onChainEventsByFid':
        return json({
          events: [
            // An ordinary keyType 1 signer, which must be ignored.
            {
              blockNumber: 1,
              logIndex: 0,
              signerEventBody: {
                key: `0x${'ab'.repeat(32)}`,
                keyType: 1,
                eventType: 'SIGNER_EVENT_TYPE_ADD',
              },
            },
            ...(hub.authEvents ?? [])
              .filter((e) => e.fid === fid)
              .map((e) => ({
                blockNumber: e.blockNumber,
                logIndex: e.logIndex ?? 0,
                signerEventBody: {
                  key: e.key,
                  keyType: 2,
                  eventType: `SIGNER_EVENT_TYPE_${e.eventType}`,
                },
              })),
          ],
        })
      case '/v2/farcaster/user/bulk-by-address':
        return json({
          users: (hub.users?.[q.get('addresses') ?? ''] ?? []).map((f) => ({
            fid: f,
            username: `user${f}`,
            display_name: '',
          })),
        })
      default:
        return json({ error: 'not found' }, 404)
    }
  }) as typeof fetch
}

// ---------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------

function wallet() {
  const privateKey = Secp256k1.randomPrivateKey()
  const address = Address.checksum(
    Address.fromPublicKey(Secp256k1.getPublicKey({ privateKey })),
  )
  return { privateKey, address }
}

function sign(privateKey: Hex.Hex, message: string): Hex.Hex {
  return Signature.toHex(
    Secp256k1.sign({
      payload: PersonalMessage.getSignPayload(Hex.fromString(message)),
      privateKey,
    }),
  )
}

function tokenFor(
  w: ReturnType<typeof wallet>,
  options: {
    fid?: number
    domain?: string
    issuedAt?: Date
    expiresIn?: number
    edit?: (message: string) => string
  } = {},
): string {
  const base = createMessage({
    domain: options.domain ?? DOMAIN,
    address: w.address,
    chainId: 1,
    fid: options.fid ?? FID,
    issuedAt: options.issuedAt,
    expiresIn: options.expiresIn,
  })
  const message = options.edit ? options.edit(base) : base
  return encodeToken({ message, signature: sign(w.privateKey, message) })
}

const SIGNER = `0x${'5a'.repeat(32)}` as Hex.Hex

function verifiedBy(
  address: Address.Address,
  signer: { gasless?: number; onchain?: number },
): FakeHub {
  return {
    verifications: [{ fid: FID, address, signer: SIGNER }],
    signers: { [`${FID}:${SIGNER}`]: signer },
  }
}

function padKey(address: Address.Address): Hex.Hex {
  return `0x${'0'.repeat(24)}${address.slice(2).toLowerCase()}`
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (e) {
    return e as Error
  }
  throw new Error('expected a rejection')
}

// ---------------------------------------------------------------------

describe('token format', () => {
  test('round trips and is never mistaken for a JWT', () => {
    const w = wallet()
    const token = tokenFor(w)
    expect(isToken(token)).toBe(true)
    expect(token.split('.').length).toBe(3)
    const { message, signature } = decodeToken(token)
    expect(message).toContain(`farcaster://fid/${FID}`)
    expect(Hex.size(signature)).toBe(65)
    expect(isToken('eyJhbGciOiJFUzI1NiJ9.e30.sig')).toBe(false)
  })

  test('rejects malformed tokens', () => {
    for (const bad of ['hqa1.', 'hqa1.abc', 'hqa1.a.b.c', 'eyJ.e30.x']) {
      expect(() => decodeToken(bad)).toThrow(InvalidTokenError)
    }
  })

  test('createMessage pins the statement, resource and lifetime', () => {
    const issuedAt = new Date('2026-01-01T00:00:00.000Z')
    const message = createMessage({
      domain: DOMAIN,
      address: wallet().address,
      chainId: 8453,
      fid: 3,
      issuedAt,
      expiresIn: 600,
    })
    expect(message).toContain('\nAuthenticate as Farcaster FID 3.\n')
    expect(message).toContain('\nURI: https://example.com/\n')
    expect(message).toContain('\nExpiration Time: 2026-01-01T00:10:00.000Z')
    expect(message.endsWith('\nResources:\n- farcaster://fid/3')).toBe(true)
  })
})

describe('requestFidFromMetadata', () => {
  test('decodes SignedKeyRequest metadata, including a live capture', () => {
    expect(requestFidFromMetadata(metadataFor(9152), 1)).toBe(9152)
    // The on-chain signer behind FID 3's verification of 0x187c…8899,
    // as served by haatz.
    const live =
      'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAjwAAAAAAAAAAAAAAAAALveQ3XmTo1/YR8BT7drpQNBVWWAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAZO55jgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABBmUVWQv9Ny0b1L47L0MPftfyiF8T0lECNeNpo2QK0Kv0HB3HHy1nUZ0J19bcxVHVt7jamCIeKonCMgLQe8kfOKBwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
    expect(requestFidFromMetadata(live, 1)).toBe(9152)
    expect(requestFidFromMetadata(live, 0)).toBeUndefined()
    expect(requestFidFromMetadata('not base64!', 1)).toBeUndefined()
    expect(requestFidFromMetadata('', 1)).toBeUndefined()
  })
})

describe('links', () => {
  test('custody address', async () => {
    const w = wallet()
    const client = createClient({
      fetch: fakeFetch({ custody: { [FID]: w.address } }),
    })
    const payload = await client.verifyToken({
      token: tokenFor(w),
      domain: DOMAIN,
    })
    expect(payload).toMatchObject({
      sub: FID,
      address: w.address,
      aud: DOMAIN,
      method: 'custody',
    })
    expect(payload.exp - payload.iat).toBe(3600)
  })

  test('verified by a trusted app, gasless or on-chain signer', async () => {
    for (const signer of [{ gasless: 9152 }, { onchain: 9152 }]) {
      const w = wallet()
      const client = createClient({
        fetch: fakeFetch(verifiedBy(w.address, signer)),
      })
      const payload = await client.verifyToken({
        token: tokenFor(w),
        domain: DOMAIN,
      })
      expect(payload).toMatchObject({
        sub: FID,
        method: 'verified',
        appFid: 9152,
      })
    }
  })

  test("verified by the user's own signer, even with no trusted apps", async () => {
    for (const signer of [{ gasless: FID }, { onchain: FID }]) {
      const w = wallet()
      const client = createClient({
        trustedAppFids: [],
        fetch: fakeFetch(verifiedBy(w.address, signer)),
      })
      const payload = await client.verifyToken({
        token: tokenFor(w),
        domain: DOMAIN,
      })
      expect(payload).toMatchObject({ method: 'verified', appFid: FID })
    }
  })

  test('verified by an untrusted app is refused, naming the app', async () => {
    const w = wallet()
    const client = createClient({
      fetch: fakeFetch(verifiedBy(w.address, { onchain: 309857 })),
    })
    const e = await rejection(
      client.verifyToken({ token: tokenFor(w), domain: DOMAIN }),
    )
    expect(e).toBeInstanceOf(InvalidTokenError)
    expect(e.message).toContain('FID 309857')
  })

  test('verification whose signer is no longer active is refused', async () => {
    const w = wallet()
    const hub = verifiedBy(w.address, { gasless: 9152 })
    hub.signers = {}
    const client = createClient({ fetch: fakeFetch(hub) })
    const e = await rejection(
      client.verifyToken({ token: tokenFor(w), domain: DOMAIN }),
    )
    expect(e).toBeInstanceOf(InvalidTokenError)
    expect(e.message).toContain('no longer active')
  })

  test('auth address, from the signer event history', async () => {
    const w = wallet()
    const key = padKey(w.address)
    const cases: [FakeHub['authEvents'], boolean][] = [
      [[{ fid: FID, key, eventType: 'ADD', blockNumber: 10 }], true],
      [
        [
          { fid: FID, key, eventType: 'ADD', blockNumber: 10 },
          { fid: FID, key, eventType: 'REMOVE', blockNumber: 11 },
        ],
        false,
      ],
      [
        // Same block: log order decides. Listed out of order on purpose.
        [
          {
            fid: FID,
            key,
            eventType: 'ADMIN_RESET',
            blockNumber: 12,
            logIndex: 4,
          },
          { fid: FID, key, eventType: 'ADD', blockNumber: 12, logIndex: 2 },
        ],
        false,
      ],
      // Another FID's auth address doesn't count.
      [[{ fid: FID + 1, key, eventType: 'ADD', blockNumber: 10 }], false],
    ]
    for (const [authEvents, accepted] of cases) {
      const client = createClient({ fetch: fakeFetch({ authEvents }) })
      const result = client.verifyToken({ token: tokenFor(w), domain: DOMAIN })
      if (accepted) {
        expect(await result).toMatchObject({ method: 'authAddress' })
      } else {
        expect(await rejection(result)).toBeInstanceOf(InvalidTokenError)
      }
    }
  })

  test('auth address wins over an untrusted verification of the same address', async () => {
    const w = wallet()
    const hub = verifiedBy(w.address, { onchain: 309857 })
    hub.authEvents = [
      { fid: FID, key: padKey(w.address), eventType: 'ADD', blockNumber: 1 },
    ]
    const client = createClient({ fetch: fakeFetch(hub) })
    const payload = await client.verifyToken({
      token: tokenFor(w),
      domain: DOMAIN,
    })
    expect(payload.method).toBe('authAddress')
  })

  test('methods option limits the accepted links', async () => {
    const w = wallet()
    const client = createClient({
      methods: ['custody'],
      fetch: fakeFetch(verifiedBy(w.address, { gasless: 9152 })),
    })
    const e = await rejection(
      client.verifyToken({ token: tokenFor(w), domain: DOMAIN }),
    )
    expect(e).toBeInstanceOf(InvalidTokenError)
  })

  test('an address linked to nothing is refused', async () => {
    const client = createClient({ fetch: fakeFetch({}) })
    const e = await rejection(
      client.verifyToken({ token: tokenFor(wallet()), domain: DOMAIN }),
    )
    expect(e).toBeInstanceOf(InvalidTokenError)
  })
})

describe('message checks', () => {
  const custodyClient = (w: ReturnType<typeof wallet>, options = {}) =>
    createClient({
      ...options,
      fetch: fakeFetch({ custody: { [FID]: w.address } }),
    })

  async function refused(
    edit: Parameters<typeof tokenFor>[1],
    domain = DOMAIN,
    clientOptions = {},
  ) {
    const w = wallet()
    const e = await rejection(
      custodyClient(w, clientOptions).verifyToken({
        token: tokenFor(w, edit),
        domain,
      }),
    )
    expect(e).toBeInstanceOf(InvalidTokenError)
    return e
  }

  test('domain and URI', async () => {
    await refused({}, 'other.example')
    await refused({
      edit: (m) =>
        m.replace('URI: https://example.com/', 'URI: https://evil.example/'),
    })
    await refused({
      edit: (m) =>
        m.replace('URI: https://example.com/', 'URI: ftp://example.com/'),
    })
  })

  test('freshness and lifetime', async () => {
    const hourAgo = new Date(Date.now() - 3601 * 1000)
    await refused({ issuedAt: hourAgo })
    await refused({ expiresIn: 7200 })
    await refused({ issuedAt: new Date(Date.now() + 600 * 1000) })
    // Up to the skew in the future is fine.
    const w = wallet()
    const payload = await custodyClient(w).verifyToken({
      token: tokenFor(w, { issuedAt: new Date(Date.now() + 120 * 1000) }),
      domain: DOMAIN,
    })
    expect(payload.sub).toBe(FID)
    // A longer lifetime is accepted when the server allows it.
    const v = wallet()
    await expect(
      custodyClient(v, { maxTokenLifetime: 86400 }).verifyToken({
        token: tokenFor(v, { expiresIn: 7200 }),
        domain: DOMAIN,
      }),
    ).resolves.toMatchObject({ sub: FID })
  })

  test('statement and FID resource', async () => {
    // Farcaster's own SIWF message for the same domain isn't a token.
    await refused({
      edit: (m) =>
        m.replace(`Authenticate as Farcaster FID ${FID}.`, 'Farcaster Auth'),
    })
    // Statement and resource must name the same FID.
    await refused({ edit: (m) => m.replace(`fid/${FID}`, 'fid/1') })
    await refused({ edit: (m) => `${m}\n- farcaster://fid/1` })
    await refused({
      edit: (m) =>
        m
          .replace(`fid/${FID}`, `fid/0${FID}`)
          .replace(`FID ${FID}.`, `FID 0${FID}.`),
    })
  })

  test('only the canonical serialization is accepted', async () => {
    await refused({ edit: (m) => `${m}\n` })
    await refused({ edit: (m) => m.replace('\nVersion: 1', '\nVersion:  1') })
    await refused({
      edit: (m) => m.replace('\n\nAuthenticate', '\n\n\nAuthenticate'),
    })
  })
})

describe('signatures', () => {
  test('a signature from another key is refused', async () => {
    const w = wallet()
    const { message } = decodeToken(tokenFor(w))
    const forged = encodeToken({
      message,
      signature: sign(wallet().privateKey, message),
    })
    const client = createClient({
      fetch: fakeFetch({ custody: { [FID]: w.address } }),
    })
    const e = await rejection(
      client.verifyToken({ token: forged, domain: DOMAIN }),
    )
    expect(e).toBeInstanceOf(InvalidTokenError)
  })

  test('contract-wallet signatures need verifySignature', async () => {
    const w = wallet()
    const { message } = decodeToken(tokenFor(w))
    const wrapped = Hex.concat(
      Hex.padLeft('0x01', 32),
      sign(w.privateKey, message),
      Hex.padLeft('0x02', 32),
    )
    const token = encodeToken({ message, signature: wrapped })
    const hub = fakeFetch({ custody: { [FID]: w.address } })

    const plain = createClient({ fetch: hub })
    expect(
      await rejection(plain.verifyToken({ token, domain: DOMAIN })),
    ).toBeInstanceOf(InvalidTokenError)

    const verifySignature = vi.fn(async () => true)
    const withHook = createClient({ fetch: hub, verifySignature })
    await expect(
      withHook.verifyToken({ token, domain: DOMAIN }),
    ).resolves.toMatchObject({
      sub: FID,
    })
    expect(verifySignature).toHaveBeenCalledWith({
      address: w.address,
      message,
      signature: wrapped,
    })
  })
})

describe('hub behavior', () => {
  test('hub failures are HubErrors, not rejections, and are not cached', async () => {
    const w = wallet()
    const hub: FakeHub = {
      custody: { [FID]: w.address },
      status: { '/v1/fidAddressType': 503 },
    }
    const client = createClient({ fetch: fakeFetch(hub) })
    const token = tokenFor(w)
    expect(
      await rejection(client.verifyToken({ token, domain: DOMAIN })),
    ).toBeInstanceOf(HubError)
    hub.status = { '/v1/fidAddressType': 429 }
    expect(
      await rejection(client.verifyToken({ token, domain: DOMAIN })),
    ).toBeInstanceOf(HubError)
    hub.status = {}
    await expect(
      client.verifyToken({ token, domain: DOMAIN }),
    ).resolves.toMatchObject({ sub: FID })
  })

  test('links are cached for linkCacheTtl', async () => {
    const w = wallet()
    const calls: string[] = []
    const token = tokenFor(w)
    const cached = createClient({
      fetch: fakeFetch({ custody: { [FID]: w.address } }, calls),
    })
    await cached.verifyToken({ token, domain: DOMAIN })
    await cached.verifyToken({ token, domain: DOMAIN })
    expect(calls.filter((p) => p === '/v1/fidAddressType').length).toBe(1)

    calls.length = 0
    const uncached = createClient({
      linkCacheTtl: 0,
      fetch: fakeFetch({ custody: { [FID]: w.address } }, calls),
    })
    await uncached.verifyToken({ token, domain: DOMAIN })
    await uncached.verifyToken({ token, domain: DOMAIN })
    expect(calls.filter((p) => p === '/v1/fidAddressType').length).toBe(2)
  })

  test('verifyJwt is a drop-in alias', async () => {
    const w = wallet()
    const client = createClient({
      fetch: fakeFetch({ custody: { [FID]: w.address } }),
    })
    await expect(
      client.verifyJwt({ token: tokenFor(w), domain: DOMAIN }),
    ).resolves.toMatchObject({
      sub: FID,
    })
  })
})

describe('linkedAccounts', () => {
  test('applies the link policy to discovered candidates, accepted first', async () => {
    const w = wallet()
    const hub: FakeHub = {
      ...verifiedBy(w.address, { onchain: 309857 }),
      custody: { 77: w.address },
      users: { [w.address.toLowerCase()]: [1, FID, 77] },
    }
    const client = createClient({ fetch: fakeFetch(hub) })
    const accounts = await client.linkedAccounts(w.address)
    expect(accounts.map((a) => [a.fid, a.link])).toEqual([
      [77, { linked: true, method: 'custody' }],
      [1, { linked: false, reason: 'unlinked' }],
      [FID, { linked: false, reason: 'untrusted_verifier', appFid: 309857 }],
    ])
    expect(accounts[0]?.username).toBe('user77')
    expect(accounts[0]?.displayName).toBeUndefined()
  })
})
