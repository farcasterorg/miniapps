import { createSign, generateKeyPairSync, randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import * as QuickAuth from '@farcaster/quick-auth'
import * as QuickAuthDecodeJwt from '@farcaster/quick-auth/decodeJwt'
import * as QuickAuthLight from '@farcaster/quick-auth/light'
import * as Address from 'ox/Address'
import * as Hex from 'ox/Hex'
import * as PersonalMessage from 'ox/PersonalMessage'
import * as Secp256k1 from 'ox/Secp256k1'
import * as Signature from 'ox/Signature'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import * as DecodeJwt from '../src/decodeJwt.ts'
import * as Ours from '../src/index.ts'
import * as Light from '../src/light.ts'

const { createClient, createMessage, decodeJwt, encodeToken, Errors } = Ours

// A stand-in Quick Auth server: nonce, Sign In with Farcaster, and JWKS,
// like auth.farcaster.xyz.
const DOMAIN = 'example.com'
const KID = randomUUID()
const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
})
let server: Server
let origin: string

function jwt(claims: Record<string, unknown>): string {
  const b64url = (s: string) => Buffer.from(s).toString('base64url')
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: KID }))
  const payload = b64url(JSON.stringify(claims))
  const signer = createSign('RSA-SHA256')
  signer.update(`${header}.${payload}`)
  return `${header}.${payload}.${signer.sign(privateKey).toString('base64url')}`
}

function claims() {
  const now = Math.floor(Date.now() / 1000)
  return {
    sub: '6841',
    iss: origin,
    aud: DOMAIN,
    iat: now,
    exp: now + 3600,
  }
}

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (req.method === 'POST' && req.url === '/nonce') {
      return send(200, { nonce: 'n0nce' })
    }
    if (req.method === 'POST' && req.url === '/verify-siwf') {
      let raw = ''
      for await (const chunk of req) raw += chunk
      const { message } = JSON.parse(raw) as { message: string }
      if (message === 'down') return send(500, {})
      if (message !== 'good') {
        return send(200, { valid: false, message: 'bad signature' })
      }
      return send(200, { valid: true, token: jwt(claims()) })
    }
    if (req.url === '/.well-known/jwks.json') {
      const jwk = {
        ...publicKey.export({ format: 'jwk' }),
        kid: KID,
        alg: 'RS256',
        use: 'sig',
      }
      return send(200, { keys: [jwk] })
    }
    res.writeHead(404).end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(() => {
  server.close()
})

describe('exports', () => {
  test('everything @farcaster/quick-auth exports, under the same names', () => {
    expect(Object.keys(Ours)).toEqual(
      expect.arrayContaining(Object.keys(QuickAuth)),
    )
    expect(Object.keys(Light)).toEqual(Object.keys(QuickAuthLight))
    expect(Object.keys(DecodeJwt)).toEqual(Object.keys(QuickAuthDecodeJwt))
    expect(Object.keys(Errors)).toEqual(
      expect.arrayContaining(Object.keys(QuickAuth.Errors)),
    )
    expect(Ours.Actions).toBe(QuickAuth.Actions)
    expect(Ours.Endpoints).toBe(QuickAuth.Endpoints)
    expect(Light.createLightClient).toBe(QuickAuthLight.createLightClient)
    expect(DecodeJwt.decodeJwt).toBe(QuickAuthDecodeJwt.decodeJwt)
  })

  test("errors are @farcaster/quick-auth's classes", () => {
    expect(Errors.InvalidTokenError).toBe(Ours.InvalidTokenError)
    expect(Errors.HubError).toBe(Ours.HubError)
    for (const name of [
      'BaseError',
      'ResponseError',
      'InvalidSiwfError',
      'InvalidParametersError',
    ] as const) {
      expect(Errors[name]).toBe(QuickAuth.Errors[name])
    }
    const invalid = new Errors.InvalidTokenError('nope')
    expect(invalid).toBeInstanceOf(QuickAuth.Errors.InvalidTokenError)
    expect(invalid).toBeInstanceOf(QuickAuth.Errors.BaseError)
    expect(invalid.name).toBe(new QuickAuth.Errors.InvalidTokenError('').name)
    const hub = new Errors.HubError('down', { cause: new Error('ECONNRESET') })
    expect(hub).toBeInstanceOf(QuickAuth.Errors.BaseError)
    expect(hub).not.toBeInstanceOf(QuickAuth.Errors.InvalidTokenError)
    expect(hub.name).toBe('HubError')
    expect(hub.cause).toBeInstanceOf(Error)
  })
})

describe('used as @farcaster/quick-auth', () => {
  test('origin, generateNonce, verifySiwf, verifyJwt, decodeJwt', async () => {
    const client = createClient({ origin })
    await expect(client.generateNonce()).resolves.toEqual({ nonce: 'n0nce' })

    const { token } = await client.verifySiwf({
      message: 'good',
      signature: '0x',
      domain: DOMAIN,
    })
    const payload = await client.verifyJwt({ token, domain: DOMAIN })
    expect(payload).toMatchObject({ sub: 6841, iss: origin, aud: DOMAIN })
    expect(decodeJwt(token)).toMatchObject({ sub: '6841', iss: origin })

    // `origin` is also the issuer a JWT must name.
    const foreign = jwt({ ...claims(), iss: 'https://auth.farcaster.xyz' })
    await expect(
      client.verifyJwt({ token: foreign, domain: DOMAIN }),
    ).rejects.toBeInstanceOf(Errors.InvalidTokenError)
  })

  test("verifySiwf fails with @farcaster/quick-auth's errors", async () => {
    const client = createClient({ origin })
    const siwf = (message: string) =>
      client.verifySiwf({ message, signature: '0x', domain: DOMAIN })
    await expect(siwf('bad')).rejects.toBeInstanceOf(
      QuickAuth.Errors.InvalidSiwfError,
    )
    await expect(siwf('down')).rejects.toBeInstanceOf(Errors.ResponseError)
  })

  test("token rejections are @farcaster/quick-auth's InvalidTokenError", async () => {
    const client = createClient({ origin })
    for (const token of [
      'hqa1.garbage',
      jwt({ ...claims(), aud: 'other.com' }),
    ]) {
      const error = await client
        .verifyJwt({ token, domain: DOMAIN })
        .catch((e: unknown) => e)
      expect(error).toBeInstanceOf(QuickAuth.Errors.InvalidTokenError)
      expect(error).toBeInstanceOf(Errors.InvalidTokenError)
    }
  })

  test('a hub outage is a BaseError but never an InvalidTokenError', async () => {
    const key = Secp256k1.randomPrivateKey()
    const address = Address.fromPublicKey(
      Secp256k1.getPublicKey({ privateKey: key }),
    )
    const message = createMessage({
      domain: DOMAIN,
      address,
      chainId: 1,
      fid: 6841,
    })
    const signature = Signature.toHex(
      Secp256k1.sign({
        payload: PersonalMessage.getSignPayload(Hex.fromString(message)),
        privateKey: key,
      }),
    )
    const client = createClient({
      fetch: async () => {
        throw new TypeError('fetch failed')
      },
    })
    const error = await client
      .verifyJwt({ token: encodeToken({ message, signature }), domain: DOMAIN })
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(Errors.HubError)
    expect(error).toBeInstanceOf(QuickAuth.Errors.BaseError)
    expect(error).not.toBeInstanceOf(QuickAuth.Errors.InvalidTokenError)
  })
})
