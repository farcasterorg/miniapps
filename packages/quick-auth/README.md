# @farcasterorg/quick-auth

Quick Auth without an auth server. A Quick Auth token is a short-lived
[EIP-4361](https://eips.ethereum.org/EIPS/eip-4361) message naming a Farcaster
FID, signed by a wallet linked to that FID. This library verifies one against
Farcaster protocol state read from a hub.

Tokens come from the Mini App SDK's `sdk.protocolAuth.getToken()`; this package
also exports the token format (`createMessage`, `encodeToken`, `decodeToken`,
from `@farcasterorg/quick-auth/token`) for producing them elsewhere.

It also verifies classic Quick Auth JWTs (`sdk.quickAuth.getToken()`), and is a
drop-in replacement for [`@farcaster/quick-auth`](#replacing-farcasterquick-auth).

```ts
import { createClient, HubError, InvalidTokenError } from '@farcasterorg/quick-auth'

const client = createClient() // hubUrl defaults to https://haatz.quilibrium.com

try {
  const { sub: fid, address, method } = await client.verifyToken({
    token, // from `Authorization: Bearer <token>`
    domain: 'example.com',
  })
} catch (e) {
  if (e instanceof InvalidTokenError) // 401
  if (e instanceof HubError) // 503: couldn't check, let the client retry
}
```

`method` says how the FID was proven: `custody`, `authAddress` or `verified`
for a protocol token, `quickAuthServer` for a JWT. `address` is always set for
a protocol token; JWTs from auth.farcaster.xyz don't carry one.

## Replacing `@farcaster/quick-auth`

Everything `@farcaster/quick-auth` exports is exported here under the same name,
from the same entry points (`.`, `/light`, `/decodeJwt`), as ESM and CommonJS:

- `createClient({ origin })`. `origin` is the Quick Auth server, as there
  (`quickAuthServerOrigin` is a synonym).
- `verifyJwt` verifies Quick Auth JWTs exactly as there, and protocol tokens
  too. `verifyToken` is the same function.
- `generateNonce`, `verifySiwf`, `createLightClient`, `decodeJwt`, `Actions`
  and `Endpoints` are `@farcaster/quick-auth`'s own.
- `Errors` holds the same classes. Our `InvalidTokenError` subclasses theirs,
  so `instanceof` agrees across the two packages; `HubError` (503, couldn't
  check) is new, and extends their `BaseError`.

`verifyJwt` differs in two ways. It throws `InvalidTokenError` for every
rejected JWT, including a bad signature or unknown key, which
`@farcaster/quick-auth` throws as jose errors. And `sub` is always a number,
which the JWT itself carries as a string.

## What a token must be

- Starts with `hqa1.`, followed by the base64url message and signature.
- The message is canonical EIP-4361 (it must re-serialize to the exact bytes
  that were signed), for the given `domain`, with an http(s) URI on that domain,
  the statement `Authenticate as Farcaster FID <fid>.`, and exactly one resource,
  `farcaster://fid/<fid>`.
- `Issued At` and `Expiration Time` are required; the lifetime is at most
  `maxTokenLifetime` (default 3600s), with `clockSkew` (default 300s) tolerance.
- The signature is a 65-byte EOA signature over the message (EIP-191), or
  passes your `verifySignature` hook (smart-contract wallets).
- The signing address is linked to the FID:
  - its **custody address**;
  - an **auth address** — KeyRegistry key type 2, read from the signer event
    history, since hubs store the key left-padded to 32 bytes;
  - a **verified address** whose verification was added by a signer with a
    trusted `requestFid` (`trustedAppFids`, default `[9152]`, the Farcaster
    app) or the user's own FID. The signer must still be active.

Links are cached for `linkCacheTtl` seconds (default 60) and hub failures are
never cached.

## Hub API

Uses `/v1/fidAddressType`, `/v1/verificationsByFid`, `/v1/signer` and
`/v1/onChainEventsByFid`. `linkedAccounts(address)`, for building an account
picker, also needs `/v2/farcaster/user/bulk-by-address` (haatz, Neynar).
