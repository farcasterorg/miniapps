export const ALL_LINK_METHODS = [
    'custody',
    'authAddress',
    'verified',
];
/** The Farcaster app. */
export const DEFAULT_TRUSTED_APP_FIDS = [9152];
export async function resolveLink(hub, fid, address, policy) {
    const allows = (m) => policy.methods.includes(m);
    const kind = await hub.addressType(fid, address);
    if (allows('custody') && kind?.is_custody) {
        return { linked: true, method: 'custody' };
    }
    let untrustedAppFid;
    let untrusted = false;
    if (allows('verified') && kind?.is_verified) {
        const signer = await hub.verificationSigner(fid, address);
        const appFid = signer ? await hub.signerRequestFid(fid, signer) : undefined;
        if (appFid !== undefined &&
            (appFid === fid || policy.trustedAppFids.includes(appFid))) {
            return { linked: true, method: 'verified', appFid };
        }
        untrusted = true;
        untrustedAppFid = appFid;
    }
    // Checked after verifications: it costs a full signer-history read,
    // and most sign-ins resolve above.
    if (allows('authAddress') && (await hub.isAuthAddress(fid, address))) {
        return { linked: true, method: 'authAddress' };
    }
    return untrusted
        ? { linked: false, reason: 'untrusted_verifier', appFid: untrustedAppFid }
        : { linked: false, reason: 'unlinked' };
}
export function describeRejection(link, fid, address) {
    if (link.reason === 'untrusted_verifier') {
        const via = link.appFid !== undefined
            ? `an app (FID ${link.appFid})`
            : 'a signer that is no longer active';
        return `${address} is verified on FID ${fid} through ${via} that isn't trusted to vouch for sign-in addresses`;
    }
    return `${address} is not linked to FID ${fid}`;
}
