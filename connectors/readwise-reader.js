import { ConnectorOperationError } from './types.js';
import { decideMatch, extractTitleAuthor } from './matching.js';

/**
 * Readwise Reader connector (Tier 1) — 2-Way Reading Progress & Library Sync.
 *
 * Distinct from the highlights-only `readwise` connector (classic /api/v2): this
 * connector carries reading *state* and *progress*.
 * 
 * Capabilities:
 * - Fan-out (Push): When a document is read or finished on the CrossInk / CrossPoint
 *   device, reading progress is sent to Readwise Reader API v3 (PATCH /api/v3/bulk_update/).
 * - Fan-in (Pull): When a book is opened on the device (or on demand), reading progress
 *   is retrieved from Readwise Reader so reading position resumes seamlessly.
 * - Rate Limiting & Caching: In-memory candidate pool with 10-minute TTL to safely
 *   adhere to Readwise's strict 20 req/min rate limit.
 * - Auto-Provisioning: If a book read on the e-reader does not yet exist in Readwise Reader,
 *   createBook automatically creates it via POST /api/v3/save/ with category 'epub'.
 */

const BASE = 'https://readwise.io/api/v3';

// Non-archived locations = the pool of docs that could still be in progress.
const CANDIDATE_LOCATIONS = ['new', 'later', 'shortlist', 'feed', 'archive'];

// Follow nextPageCursor to the end of each location; safety bound against loop
const MAX_CANDIDATE_PAGES = 50;

// Tuned threshold: 0.7 accommodates slight edition variations, subtitles, and punctuation.
const MATCH_THRESHOLD = Number(process.env.READWISE_MATCH_THRESHOLD ?? 0.7);

// Rate-limit backoff. Readwise is 20 req/min per access token; on a 429 back off.
const COOLDOWN_MS = Number(process.env.READWISE_RATE_COOLDOWN_MS ?? 60_000);
const rateLimitedUntil = new Map();

function rateLimited(token) {
    const until = rateLimitedUntil.get(token) ?? 0;
    if (Date.now() < until)
        return true;
    if (until)
        rateLimitedUntil.delete(token); // expired; keep map small
    return false;
}

function noteRateLimit(token, status) {
    if (status === 429)
        rateLimitedUntil.set(token, Date.now() + COOLDOWN_MS);
}

function tokenOf(cred) {
    const t = cred.token;
    if (typeof t !== 'string' || t.length === 0)
        throw new Error('missing readwise token');
    return t;
}

function authHeaders(token) {
    return { authorization: `Token ${token}`, 'content-type': 'application/json' };
}

async function listDocs(token, http, location) {
    const out = [];
    let cursor;
    const seenCursors = new Set();
    for (let page = 0; page < MAX_CANDIDATE_PAGES; page++) {
        const params = new URLSearchParams({ location, withHtmlContent: 'false' });
        if (cursor)
            params.set('pageCursor', cursor);
        const res = await http(`${BASE}/list/?${params.toString()}`, {
            method: 'GET',
            headers: authHeaders(token),
        });
        if (res.status === 429) {
            noteRateLimit(token, res.status);
            break;
        }
        if (res.status !== 200)
            break;
        const body = (await res.json());
        out.push(...(body.results ?? []));
        const next = body.nextPageCursor ?? undefined;
        if (!next || seenCursors.has(next))
            break;
        seenCursors.add(next);
        cursor = next;
    }
    return out;
}

let cachedPool = null;
let cachedPoolTime = 0;
const CACHE_TTL_MS = 10 * 60 * 1000;

async function candidatePool(token, http) {
    if (cachedPool && (Date.now() - cachedPoolTime < CACHE_TTL_MS)) {
        return cachedPool;
    }
    const seen = new Set();
    const pool = [];
    for (const loc of ['later', 'new', 'archive']) {
        for (const d of await listDocs(token, http, loc)) {
            if (!d.title || seen.has(d.id))
                continue;
            seen.add(d.id);
            pool.push({ externalId: d.id, title: d.title, author: d.author ?? d.site_name ?? null });
        }
    }
    if (pool.length > 0) {
        cachedPool = pool;
        cachedPoolTime = Date.now();
    }
    return pool.length > 0 ? pool : (cachedPool ?? []);
}

async function validate(cred, http) {
    try {
        const res = await http(`${BASE}/list/?withHtmlContent=false`, {
            method: 'GET',
            headers: authHeaders(tokenOf(cred)),
        });
        if (res.status === 200)
            return { ok: true };
        if (res.status === 401)
            return { ok: false, error: 'invalid token' };
        return { ok: false, error: `unexpected status ${res.status}` };
    }
    catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
}

/** Push progress updates and finished events. */
function shouldPush(ev) {
    return ev.kind === 'finished' || ev.kind === 'progress';
}

async function match(cred, doc, http) {
    const token = tokenOf(cred);
    if (rateLimited(token))
        return null;
    const ta = extractTitleAuthor(doc);
    if (!ta)
        return null;
    const candidates = await candidatePool(token, http);
    const decision = decideMatch(ta.title, ta.author, candidates, { threshold: MATCH_THRESHOLD });
    if (!decision.accepted || !decision.best)
        return null;
    return {
        externalId: decision.best.externalId,
        confidence: decision.best.score,
        queryUsed: ta.title,
        title: decision.best.title,
        author: decision.best.author ?? null,
    };
}

/** The Reader candidate set used for matching. */
async function listCurrentlyReading(cred, http) {
    const pool = await candidatePool(tokenOf(cred), http);
    return pool.map((c) => ({ externalId: c.externalId, title: c.title, author: c.author ?? null }));
}

/**
 * Fan-in: pull the current Readwise reading position for a matched document.
 * If Readwise progress is ahead of device progress, Readwise position takes precedence.
 */
async function pullProgress(cred, match, http, sinceMs, extra) {
    const token = tokenOf(cred);
    if (rateLimited(token))
        throw new ConnectorOperationError('Readwise Reader is rate limited; try again later', true);
    const res = await http(`${BASE}/list/?id=${encodeURIComponent(match.externalId)}&withHtmlContent=false`, { method: 'GET', headers: authHeaders(token) });
    noteRateLimit(token, res.status);
    if (res.status !== 200)
        throw new ConnectorOperationError(`Readwise Reader request failed (${res.status})`, res.status === 429 || res.status >= 500, res.status === 401 || res.status === 403);
    const body = (await res.json());
    const doc = body.results?.[0];
    if (!doc || typeof doc.reading_progress !== 'number')
        return null;
    const pct = Math.max(0, Math.min(1, doc.reading_progress));
    const parsed = doc.updated_at ? Date.parse(doc.updated_at) : NaN;
    let updatedAtMs = Number.isFinite(parsed) ? parsed : Date.now();
    let currentPct = 0;
    if (extra && extra.db && extra.userId && extra.document) {
        const row = extra.db.prepare('SELECT percentage FROM progress WHERE user_id = ? AND document = ? ORDER BY updated_at DESC LIMIT 1').get(extra.userId, extra.document);
        if (row && typeof row.percentage === 'number') currentPct = row.percentage;
    }
    if (pct > currentPct + 0.005) {
        updatedAtMs = Date.now();
    } else if (sinceMs && updatedAtMs <= sinceMs) {
        return null;
    }
    return { externalId: match.externalId, percentage: pct, finished: pct >= 0.98, updatedAtMs };
}

async function push(cred, m, ev, http) {
    if (ev.kind !== 'finished' && ev.kind !== 'progress')
        return { ok: true };
    const token = tokenOf(cred);
    const payload = ev.kind === 'finished'
        ? { updates: [{ id: m.externalId, location: 'archive', seen: true, reading_progress: 1.0 }] }
        : { updates: [{ id: m.externalId, reading_progress: Math.max(0, Math.min(1, ev.percentage)) }] };
    const res = await http(`${BASE}/bulk_update/`, {
        method: 'PATCH',
        headers: authHeaders(token),
        body: JSON.stringify(payload),
    });
    if (res.status === 401)
        return { ok: false, retryable: false, needsReauth: true, error: 'unauthorized' };
    if (res.status === 429) {
        noteRateLimit(token, res.status);
        return { ok: false, retryable: true, error: 'rate limited' };
    }
    if (res.status >= 500)
        return { ok: false, retryable: true, error: `server ${res.status}` };
    if (res.status === 207) {
        return { ok: false, retryable: true, error: 'bulk_update partial failure' };
    }
    if (res.status >= 200 && res.status < 300)
        return { ok: true };
    return { ok: false, retryable: false, error: `unexpected status ${res.status}` };
}

/**
 * Auto-provision a missing book in Readwise Reader so newly opened books
 * on the e-reader get matched and synced to "Currently Reading" immediately.
 */
async function createBook(cred, meta, ev, http) {
    const token = tokenOf(cred);
    if (rateLimited(token)) return null;
    const ta = extractTitleAuthor(meta);
    if (!ta || !ta.title) return null;
    try {
        const payload = {
            url: "https://books.unchained.com.es/book/" + encodeURIComponent(ta.title),
            title: ta.title,
            author: ta.author || undefined,
            category: "epub",
            location: "later"
        };
        const res = await http(BASE + "/save/", {
            method: "POST",
            headers: authHeaders(token),
            body: JSON.stringify(payload)
        });
        noteRateLimit(token, res.status);
        if (res.status === 200 || res.status === 201) {
            const data = await res.json();
            if (data?.id) {
                cachedPool = null; // Invalidate pool cache so the newly saved item is discovered
                return {
                    externalId: data.id,
                    confidence: 1,
                    queryUsed: ta.title,
                    title: ta.title,
                    author: ta.author || null,
                };
            }
        }
    } catch (err) {
        console.error(JSON.stringify({ msg: "createBook in Readwise Reader failed", error: err instanceof Error ? err.message : String(err) }));
    }
    return null;
}

export const readwiseReaderConnector = {
    id: 'readwise-reader',
    displayName: 'Readwise Reader',
    tier: 1,
    capabilities: { read: true, write: true },
    carries: ['finished', 'progress'],
    credentialKind: 'token',
    beta: false,
    matchBy: 'metadata',
    validate,
    shouldPush,
    match,
    push,
    pullProgress,
    listCurrentlyReading,
    createBook,
};
