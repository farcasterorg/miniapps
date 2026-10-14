import { createClient as createQuickAuthServerClient, Errors as QuickAuthErrors, } from '@farcaster/quick-auth';
import * as Address from 'ox/Address';
import * as Hex from 'ox/Hex';
import * as PersonalMessage from 'ox/PersonalMessage';
import * as Secp256k1 from 'ox/Secp256k1';
import * as Signature from 'ox/Signature';
import * as Siwe from 'ox/Siwe';
import { HubError, InvalidTokenError } from "./errors.js";
import { createHub } from "./hub.js";
import { ALL_LINK_METHODS, DEFAULT_TRUSTED_APP_FIDS, describeRejection, resolveLink, } from "./link.js";
import { DEFAULT_EXPIRES_IN, decodeToken, FID_RESOURCE_PREFIX, isToken, statement, } from "./token.js";
export const DEFAULT_HUB_URL = 'https://haatz.quilibrium.com';
/** Issuer of classic Quick Auth JWTs (`sdk.quickAuth`). */
export const DEFAULT_QUICK_AUTH_SERVER_ORIGIN = 'https://auth.farcaster.xyz';
/**
 * jose error codes that mean "couldn't check right now" rather than "bad
 * token": the JWKS fetch timed out or came back unusable.
 */
const JWKS_UNAVAILABLE_CODES = new Set(['ERR_JWKS_TIMEOUT', 'ERR_JWKS_INVALID']);
const MAX_CACHE_ENTRIES = 10_000;
/** An address maps to at most one custody FID and one verified FID. */
const MAX_CANDIDATES = 4;
export function createClient(options = {}) {
    const hubUrl = options.hubUrl ?? DEFAULT_HUB_URL;
    const hub = createHub({ ...options, hubUrl });
    const policy = {
        trustedAppFids: options.trustedAppFids ?? DEFAULT_TRUSTED_APP_FIDS,
        methods: options.methods ?? ALL_LINK_METHODS,
    };
    const maxLifetime = options.maxTokenLifetime ?? DEFAULT_EXPIRES_IN;
    const skew = options.clockSkew ?? 300;
    const cacheTtlMs = (options.linkCacheTtl ?? 60) * 1000;
    const quickAuthServerOrigin = options.quickAuthServerOrigin ??
        options.origin ??
        DEFAULT_QUICK_AUTH_SERVER_ORIGIN;
    const acceptQuickAuthJwt = options.acceptQuickAuthJwt !== false;
    const quickAuthServer = createQuickAuthServerClient({
        origin: quickAuthServerOrigin,
    });
    // In-flight and recent link lookups, keyed by fid:address. Holding
    // the promise also coalesces concurrent requests for the same key.
    const cache = new Map();
    function cachedLink(fid, address) {
        const key = `${fid}:${address.toLowerCase()}`;
        const now = Date.now();
        const hit = cache.get(key);
        if (hit && hit.expires > now)
            return hit.link;
        const link = resolveLink(hub, fid, address, policy);
        cache.set(key, { link, expires: now + cacheTtlMs });
        // A hub failure must not be remembered as an answer.
        link.catch(() => cache.delete(key));
        if (cache.size > MAX_CACHE_ENTRIES) {
            for (const [k, v] of cache) {
                if (v.expires <= now || cache.size > MAX_CACHE_ENTRIES)
                    cache.delete(k);
                else
                    break;
            }
        }
        return link;
    }
    async function verifyToken({ token, domain, }) {
        if (!isToken(token) && acceptQuickAuthJwt) {
            return verifyQuickAuthJwt(token, domain);
        }
        const { message, signature } = decodeToken(token);
        const fields = parseCanonical(message);
        const now = Math.floor(Date.now() / 1000);
        if (fields.domain.toLowerCase() !== domain.toLowerCase()) {
            throw new InvalidTokenError(`token is for ${fields.domain}, not ${domain}`);
        }
        let uri;
        try {
            uri = new URL(fields.uri);
        }
        catch {
            throw new InvalidTokenError('invalid URI');
        }
        if (!['https:', 'http:'].includes(uri.protocol) ||
            uri.host.toLowerCase() !== domain.toLowerCase()) {
            throw new InvalidTokenError('URI must be an http(s) URI on the domain');
        }
        if (fields.version !== '1') {
            throw new InvalidTokenError(`unsupported version ${fields.version}`);
        }
        const fid = fidFromResources(fields.resources);
        if (fields.statement !== statement(fid)) {
            throw new InvalidTokenError('not a protocol Quick Auth message');
        }
        if (!fields.issuedAt || !fields.expirationTime) {
            throw new InvalidTokenError('Issued At and Expiration Time are required');
        }
        const iat = Math.floor(fields.issuedAt.getTime() / 1000);
        const exp = Math.floor(fields.expirationTime.getTime() / 1000);
        if (iat > now + skew)
            throw new InvalidTokenError('issued in the future');
        if (exp <= now)
            throw new InvalidTokenError('token has expired');
        if (exp - iat > maxLifetime) {
            throw new InvalidTokenError(`token lifetime ${exp - iat}s exceeds the ${maxLifetime}s maximum`);
        }
        if (fields.notBefore && fields.notBefore.getTime() / 1000 > now + skew) {
            throw new InvalidTokenError('token is not valid yet');
        }
        if (!(await signatureMatches(fields.address, message, signature))) {
            throw new InvalidTokenError("signature wasn't made by the message's address");
        }
        const link = await cachedLink(fid, fields.address);
        if (!link.linked) {
            throw new InvalidTokenError(describeRejection(link, fid, fields.address));
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
        };
    }
    async function verifyQuickAuthJwt(token, domain) {
        try {
            const payload = await quickAuthServer.verifyJwt({ token, domain });
            // These are the JWT's raw claims, whatever the type says: the server
            // issues `sub` as a string and has stopped including `address`.
            const { address } = payload;
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
            };
        }
        catch (e) {
            const code = e?.code;
            const badToken = e instanceof QuickAuthErrors.InvalidTokenError ||
                (typeof code === 'string' &&
                    code.startsWith('ERR_J') &&
                    !JWKS_UNAVAILABLE_CODES.has(code));
            if (badToken) {
                throw new InvalidTokenError(`invalid Quick Auth JWT: ${e.message}`);
            }
            throw new HubError(`couldn't verify Quick Auth JWT against ${quickAuthServerOrigin}`, { cause: e });
        }
    }
    async function signatureMatches(address, message, signature) {
        if (Hex.size(signature) === 65) {
            try {
                const recovered = Secp256k1.recoverAddress({
                    payload: PersonalMessage.getSignPayload(Hex.fromString(message)),
                    signature: Signature.fromHex(signature),
                });
                if (Address.isEqual(recovered, address))
                    return true;
            }
            catch {
                // Not a recoverable EOA signature; maybe a contract wallet's.
            }
        }
        return options.verifySignature
            ? options.verifySignature({ address, message, signature })
            : false;
    }
    async function linkedAccounts(address) {
        const users = await hub.usersByAddress(address);
        const unique = [...new Map(users.map((u) => [u.fid, u])).values()];
        const candidates = unique.slice(0, MAX_CANDIDATES);
        const links = await Promise.all(candidates.map((u) => cachedLink(u.fid, address)));
        return candidates
            .map((u, i) => ({ ...u, link: links[i] }))
            .sort((a, b) => Number(b.link.linked) - Number(a.link.linked));
    }
    return {
        verifyToken,
        verifyJwt: verifyToken,
        linkedAccounts,
        generateNonce: quickAuthServer.generateNonce,
        verifySiwf: quickAuthServer.verifySiwf,
    };
}
/**
 * Parse an EIP-4361 message and insist it's byte-for-byte what
 * re-serializing it produces. The signature covers the raw text, so any
 * slack between what was signed and what was parsed (extra lines,
 * odd whitespace, alternate spellings) is refused outright.
 */
function parseCanonical(message) {
    let parsed;
    try {
        parsed = Siwe.parseMessage(message);
        if (Siwe.createMessage(parsed) === message) {
            return parsed;
        }
    }
    catch {
        // fall through
    }
    throw new InvalidTokenError('malformed message');
}
function fidFromResources(resources) {
    if (resources?.length !== 1 ||
        !resources[0]?.startsWith(FID_RESOURCE_PREFIX)) {
        throw new InvalidTokenError(`message must have exactly one resource, ${FID_RESOURCE_PREFIX}<fid>`);
    }
    const raw = resources[0].slice(FID_RESOURCE_PREFIX.length);
    if (!/^[1-9][0-9]{0,15}$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
        throw new InvalidTokenError('malformed FID resource');
    }
    return Number(raw);
}
