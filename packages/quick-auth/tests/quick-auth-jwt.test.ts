import {
  createSign,
  generateKeyPairSync,
  type KeyObject,
  randomUUID,
} from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import * as Address from 'ox/Address'
import * as Hex from 'ox/Hex'
import * as PersonalMessage from 'ox/PersonalMessage'
import * as Secp256k1 from 'ox/Secp256k1'
import * as Signature from 'ox/Signature'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import {
  createClient,
  createMessage,
  encodeToken,
  HubError,
  InvalidTokenError,
} from '../src/index.ts'

// A stand-in Quick Auth server: an RSA JWKS like auth.farcaster.xyz's.
const DOMAIN = 'example.com'
const KID = randomUUID()
const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
})
const other = generateKeyPairSync('rsa', { modulusLength: 2048 })
let server: Server
let origin: string

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/.well-known/jwks.json') {
      const jwk = {
        ...publicKey.export({ format: 'jwk' }),
        kid: KID,
        alg: 'RS256',
        use: 'sig',
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ keys: [jwk] }))
      return
    }
    res.writeHead(404).end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(() => {
  server.close()
})

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url')

function jwt(
  claims: Record<string, unknown>,
  options: { key?: KeyObject; kid?: string } = {},
): string {
  const header = b64url(
    JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: options.kid ?? KID }),
  )
  const payload = b64url(JSON.stringify(claims))
  const signer = createSign('RSA-SHA256')
  signer.update(`${header}.${payload}`)
  return `${header}.${payload}.${b64url(signer.sign(options.key ?? privateKey))}`
}

// What auth.farcaster.xyz issues: jose's `setSubject` takes a string, and
// there's no `address` claim (removed upstream in June 2025).
function claims(overrides: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000)
  return {
    sub: '6841',
    iss: origin,
    aud: DOMAIN,
    iat: now,
    exp: now + 3600,
    ...overrides,
  }
}

const client = () =>
  createClient({
    quickAuthServerOrigin: origin,
    // The protocol path's hub: custody of FID 4242 for any address.
    fetch: (async (input: URL | RequestInfo) => {
      const url = new URL(input.toString())
      if (url.pathname === '/v1/fidAddressType') {
        return new Response(
          JSON.stringify({
            is_custody: url.searchParams.get('fid') === '4242',
            is_verified: false,
          }),
        )
      }
      return new Response(JSON.stringify({ events: [] }))
    }) as typeof fetch,
  })

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (e) {
    return e as Error
  }
  throw new Error('expected a rejection')
}

describe('classic Quick Auth JWTs', () => {
  test('are accepted alongside protocol tokens', async () => {
    const c = client()
    const payload = await c.verifyToken({
      token: jwt(claims()),
      domain: DOMAIN,
    })
    expect(payload).toEqual({
      sub: 6841,
      method: 'quickAuthServer',
      aud: DOMAIN,
      iss: origin,
      iat: expect.any(Number),
      exp: expect.any(Number),
    })
    // A server that does include the signing address gets it passed on.
    const withAddress = await c.verifyToken({
      token: jwt(
        claims({ address: '0x0000000000000000000000000000000000000001' }),
      ),
      domain: DOMAIN,
    })
    expect(withAddress.address).toBe(
      '0x0000000000000000000000000000000000000001',
    )

    const privateKey = Secp256k1.randomPrivateKey()
    const address = Address.checksum(
      Address.fromPublicKey(Secp256k1.getPublicKey({ privateKey })),
    )
    const message = createMessage({
      domain: DOMAIN,
      address,
      chainId: 1,
      fid: 4242,
    })
    const signature = Signature.toHex(
      Secp256k1.sign({
        payload: PersonalMessage.getSignPayload(Hex.fromString(message)),
        privateKey,
      }),
    )
    const protocol = await c.verifyToken({
      token: encodeToken({ message, signature }),
      domain: DOMAIN,
    })
    expect(protocol).toMatchObject({ sub: 4242, method: 'custody', address })

    // verifyJwt (the drop-in name) takes both too.
    await expect(
      c.verifyJwt({ token: jwt(claims()), domain: DOMAIN }),
    ).resolves.toMatchObject({
      sub: 6841,
    })
  })

  test('bad JWTs are InvalidTokenError (401), never HubError', async () => {
    const now = Math.floor(Date.now() / 1000)
    const c = client()
    const cases: [string, string][] = [
      ['other audience', jwt(claims({ aud: 'evil.example' }))],
      ['other issuer', jwt(claims({ iss: 'https://evil.example' }))],
      ['expired', jwt(claims({ iat: now - 7200, exp: now - 3600 }))],
      ['forged signature', jwt(claims(), { key: other.privateKey })],
      ['unknown kid', jwt(claims(), { kid: 'nope' })],
      ['garbage', 'not.a.jwt'],
    ]
    for (const [label, token] of cases) {
      const e = await rejection(c.verifyToken({ token, domain: DOMAIN }))
      expect(e, label).toBeInstanceOf(InvalidTokenError)
    }
  })

  test('an unreachable Quick Auth server is HubError (503)', async () => {
    const down = createClient({ quickAuthServerOrigin: 'http://127.0.0.1:9' })
    const e = await rejection(
      down.verifyToken({
        token: jwt(claims({ iss: 'http://127.0.0.1:9' })),
        domain: DOMAIN,
      }),
    )
    expect(e).toBeInstanceOf(HubError)
  })

  test('can be turned off', async () => {
    const strict = createClient({
      quickAuthServerOrigin: origin,
      acceptQuickAuthJwt: false,
    })
    const e = await rejection(
      strict.verifyToken({ token: jwt(claims()), domain: DOMAIN }),
    )
    expect(e).toBeInstanceOf(InvalidTokenError)
  })
})
