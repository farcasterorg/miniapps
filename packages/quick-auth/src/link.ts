import type * as Address from 'ox/Address'
import type { Hub } from './hub.ts'

/**
 * How the signing address relates to the FID:
 *
 * - `custody` — the FID's current custody address.
 * - `authAddress` — an auth address (KeyRegistry keyType 2) the custody
 *   registered for signing in.
 * - `verified` — a verified address, accepted only if the verification
 *   was added by a signer that a trusted app (or the user themselves)
 *   requested. Any active signer can add a verification, so without
 *   that rule any app holding a signer could verify its own wallet on a
 *   user's FID and sign in as them.
 */
export type LinkMethod = 'custody' | 'authAddress' | 'verified'

export const ALL_LINK_METHODS: readonly LinkMethod[] = [
  'custody',
  'authAddress',
  'verified',
]

/** The Farcaster app. */
export const DEFAULT_TRUSTED_APP_FIDS: readonly number[] = [9152]

export type LinkPolicy = {
  /** App FIDs whose signers may vouch for a verified address. */
  trustedAppFids: readonly number[]
  /** Which kinds of link are accepted. */
  methods: readonly LinkMethod[]
}

export type Link =
  | { linked: true; method: LinkMethod; appFid?: number }
  | {
      linked: false
      reason: 'unlinked' | 'untrusted_verifier'
      /** For `untrusted_verifier`: the app that added the verification, if known. */
      appFid?: number
    }

export async function resolveLink(
  hub: Hub,
  fid: number,
  address: Address.Address,
  policy: LinkPolicy,
): Promise<Link> {
  const allows = (m: LinkMethod) => policy.methods.includes(m)
  const kind = await hub.addressType(fid, address)

  if (allows('custody') && kind?.is_custody) {
    return { linked: true, method: 'custody' }
  }

  let untrustedAppFid: number | undefined
  let untrusted = false
  if (allows('verified') && kind?.is_verified) {
    const signer = await hub.verificationSigner(fid, address)
    const appFid = signer ? await hub.signerRequestFid(fid, signer) : undefined
    if (
      appFid !== undefined &&
      (appFid === fid || policy.trustedAppFids.includes(appFid))
    ) {
      return { linked: true, method: 'verified', appFid }
    }
    untrusted = true
    untrustedAppFid = appFid
  }

  // Checked after verifications: it costs a full signer-history read,
  // and most sign-ins resolve above.
  if (allows('authAddress') && (await hub.isAuthAddress(fid, address))) {
    return { linked: true, method: 'authAddress' }
  }

  return untrusted
    ? { linked: false, reason: 'untrusted_verifier', appFid: untrustedAppFid }
    : { linked: false, reason: 'unlinked' }
}

export function describeRejection(
  link: Extract<Link, { linked: false }>,
  fid: number,
  address: Address.Address,
): string {
  if (link.reason === 'untrusted_verifier') {
    const via =
      link.appFid !== undefined
        ? `an app (FID ${link.appFid})`
        : 'a signer that is no longer active'
    return `${address} is verified on FID ${fid} through ${via} that isn't trusted to vouch for sign-in addresses`
  }
  return `${address} is not linked to FID ${fid}`
}
