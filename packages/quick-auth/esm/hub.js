import * as AbiParameters from 'ox/AbiParameters';
import * as Base64 from 'ox/Base64';
import { z } from 'zod';
import { HubError } from "./errors.js";
const signedKeyRequestAbi = [
    {
        components: [
            { name: 'requestFid', type: 'uint256' },
            { name: 'requestSigner', type: 'address' },
            { name: 'signature', type: 'bytes' },
            { name: 'deadline', type: 'uint256' },
        ],
        name: 'SignedKeyRequest',
        type: 'tuple',
    },
];
/**
 * `requestFid` — the app that asked for the key — from an on-chain
 * signer event's SignedKeyRequest metadata. The KeyRegistry's validator
 * checked it was signed by that app's custody when the key was added.
 */
export function requestFidFromMetadata(metadataBase64, metadataType) {
    if (metadataType !== 1 || !metadataBase64)
        return undefined;
    try {
        const [decoded] = AbiParameters.decode(signedKeyRequestAbi, Base64.toBytes(metadataBase64));
        const fid = decoded.requestFid;
        return fid <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(fid) : undefined;
    }
    catch {
        return undefined;
    }
}
const addressTypeSchema = z.object({
    is_custody: z.boolean().default(false),
    is_verified: z.boolean().default(false),
});
const messagesPageSchema = z.object({
    messages: z.array(z.unknown()).default([]),
    nextPageToken: z.string().optional(),
});
const verificationMessageSchema = z.object({
    data: z.object({
        verificationAddAddressBody: z.object({
            address: z.string(),
            protocol: z.string().optional(),
        }),
    }),
    signer: z.string(),
});
const signerSchema = z.object({
    signer: z.object({
        requestFid: z.number().optional(),
        onChainEvent: z
            .object({
            signerEventBody: z
                .object({
                metadata: z.string().default(''),
                metadataType: z.number().default(0),
            })
                .optional(),
        })
            .optional(),
    }),
});
const signerEventsSchema = z.object({
    events: z.array(z.unknown()).default([]),
});
const signerEventSchema = z.object({
    blockNumber: z.number(),
    logIndex: z.number().default(0),
    signerEventBody: z.object({
        key: z.string(),
        keyType: z.number(),
        eventType: z.string(),
    }),
});
const bulkUsersSchema = z.object({
    users: z
        .array(z.object({
        fid: z.number(),
        username: z.string().nullish(),
        display_name: z.string().nullish(),
        pfp_url: z.string().nullish(),
    }))
        .default([]),
});
/** `verificationsByFid` pages to scan before giving up. */
const MAX_VERIFICATION_PAGES = 10;
export function createHub(options) {
    const doFetch = options.fetch ?? fetch;
    const timeoutMs = options.timeoutMs ?? 30_000;
    async function get(path, params, schema) {
        const url = new URL(path, options.hubUrl);
        for (const [k, v] of Object.entries(params))
            url.searchParams.set(k, v);
        let response;
        try {
            response = await doFetch(url, {
                ...options.requestInit,
                signal: AbortSignal.timeout(timeoutMs),
            });
        }
        catch (e) {
            throw new HubError(`${path}: request failed`, { cause: e });
        }
        if (response.status === 400 || response.status === 404)
            return undefined;
        if (!response.ok) {
            throw new HubError(`${path}: HTTP ${response.status}`);
        }
        let json;
        try {
            json = await response.json();
        }
        catch (e) {
            throw new HubError(`${path}: invalid JSON`, { cause: e });
        }
        const parsed = schema.safeParse(json);
        if (!parsed.success) {
            throw new HubError(`${path}: unexpected response`, {
                cause: parsed.error,
            });
        }
        return parsed.data;
    }
    return {
        /** Current custody and live verification status of `address` for `fid`. */
        async addressType(fid, address) {
            return get('/v1/fidAddressType', { fid: String(fid), address }, addressTypeSchema);
        },
        /** Key of the signer that added the live ETH verification of `address`. */
        async verificationSigner(fid, address) {
            const target = address.toLowerCase();
            let pageToken;
            for (let page = 0; page < MAX_VERIFICATION_PAGES; page++) {
                const params = {
                    fid: String(fid),
                    pageSize: '100',
                };
                if (pageToken)
                    params.pageToken = pageToken;
                const result = await get('/v1/verificationsByFid', params, messagesPageSchema);
                if (!result)
                    return undefined;
                for (const raw of result.messages) {
                    // Skip anything that isn't a well-formed ETH verification
                    // rather than failing the whole page on it.
                    const m = verificationMessageSchema.safeParse(raw);
                    if (!m.success)
                        continue;
                    const body = m.data.data.verificationAddAddressBody;
                    const isEth = (body.protocol ?? 'PROTOCOL_ETHEREUM') === 'PROTOCOL_ETHEREUM';
                    if (isEth && body.address.toLowerCase() === target) {
                        return m.data.signer;
                    }
                }
                if (!result.nextPageToken)
                    return undefined;
                pageToken = result.nextPageToken;
            }
            return undefined;
        },
        /**
         * `requestFid` of an *active* signer, from the gasless key record or
         * the on-chain event's metadata. `undefined` if the signer isn't
         * active or can't be attributed.
         */
        async signerRequestFid(fid, signer) {
            const result = await get('/v1/signer', { fid: String(fid), signer }, signerSchema);
            if (!result)
                return undefined;
            if (result.signer.requestFid !== undefined) {
                return result.signer.requestFid;
            }
            const body = result.signer.onChainEvent?.signerEventBody;
            return body
                ? requestFidFromMetadata(body.metadata, body.metadataType)
                : undefined;
        },
        /**
         * Whether `address` is a currently registered auth address
         * (KeyRegistry keyType 2) for `fid`. Worked out from the signer event
         * history: the latest event for the key decides. Auth-address keys
         * are stored left-padded to 32 bytes.
         */
        async isAuthAddress(fid, address) {
            const result = await get('/v1/onChainEventsByFid', { fid: String(fid), event_type: 'EVENT_TYPE_SIGNER' }, signerEventsSchema);
            if (!result)
                return false;
            const target = address.toLowerCase().slice(2);
            let latest;
            for (const raw of result.events) {
                const e = signerEventSchema.safeParse(raw);
                if (!e.success || e.data.signerEventBody.keyType !== 2)
                    continue;
                if (authKeyAddress(e.data.signerEventBody.key) !== target)
                    continue;
                const later = !latest ||
                    e.data.blockNumber > latest.blockNumber ||
                    (e.data.blockNumber === latest.blockNumber &&
                        e.data.logIndex > latest.logIndex);
                if (later)
                    latest = e.data;
            }
            return latest?.signerEventBody.eventType === 'SIGNER_EVENT_TYPE_ADD';
        },
        /**
         * FIDs a hub's account index associates with `address`. Discovery
         * only — these are candidates to check, not links. Needs the
         * `/v2/farcaster/user/bulk-by-address` API (haatz, Neynar).
         */
        async usersByAddress(address) {
            const result = await get('/v2/farcaster/user/bulk-by-address', { addresses: address.toLowerCase() }, bulkUsersSchema);
            return (result?.users ?? []).map((u) => ({
                fid: u.fid,
                username: u.username || undefined,
                displayName: u.display_name || undefined,
                pfpUrl: u.pfp_url || undefined,
            }));
        },
    };
}
/** Lowercase 40-hex-char address from a 20- or zero-padded 32-byte key. */
function authKeyAddress(key) {
    const hex = key.toLowerCase().replace(/^0x/, '');
    if (hex.length === 40)
        return hex;
    if (hex.length === 64 && /^0{24}/.test(hex))
        return hex.slice(24);
    return undefined;
}
