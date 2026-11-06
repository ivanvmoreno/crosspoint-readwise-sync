import { pollConnector } from './fanin.js';
import { fetchTransport } from './registry.js';
import { resolveMatch } from './runner.js';
import { getAccount, getMatch } from './store.js';
import { importBookorbitStats } from './bookorbit-stats.js';
import { scheduleMicroblogClippings } from './microblog-clippings.js';

/**
 * Per-book fan-in pullers consulted when a device asks for progress.
 * 
 * Includes `readwise-reader` with on-demand matching enabled so that
 * when a book is opened on CrossInk / CrossPoint, reading position is
 * pulled forward from Readwise Reader.
 */
const PER_BOOK_PULLERS = [
    { id: 'bookfusion', strict: true, sidecarOnly: true },
    { id: 'kindle', strict: false, sidecarOnly: false, matchOnDemand: true },
    { id: 'bookorbit', strict: false, sidecarOnly: false, matchOnDemand: true },
    { id: 'readwise-reader', strict: false, sidecarOnly: false, matchOnDemand: true },
    { id: 'jellyfin', strict: false, sidecarOnly: false, matchOnDemand: true },
    { id: 'spotify', strict: false, sidecarOnly: false, matchOnDemand: true },
    { id: 'audiobookshelf', strict: false, sidecarOnly: false, matchOnDemand: true },
    { id: 'seekquel', strict: false, sidecarOnly: false, matchOnDemand: true },
    { id: 'readest', strict: false, sidecarOnly: false, matchOnDemand: true },
];

/** Shared by both progress endpoints; only overlapping requests share a refresh. */
export function createProgressRefresh(db, http = fetchTransport) {
    const pending = new Map();
    return async (userId, document) => {
        try {
            scheduleMicroblogClippings(db, userId, document);
        }
        catch (err) {
            console.error(JSON.stringify({ msg: 'microblog schedule failed', user_id: userId, document,
                error: err instanceof Error ? err.message : String(err) }));
        }
        const pullers = [];
        for (const p of PER_BOOK_PULLERS) {
            const account = getAccount(db, userId, p.id);
            if (!account?.enabled)
                continue;
            let match = getMatch(db, userId, p.id, document);
            if (!match?.external_id && p.matchOnDemand && match?.source !== 'manual' &&
                (!match || match.updated_at < account.updated_at)) {
                await resolveMatch(db, p.id, userId, document, http).catch(() => null);
                match = getMatch(db, userId, p.id, document);
            }
            if (!match?.external_id)
                continue;
            if (p.sidecarOnly && match.source !== 'sidecar')
                continue;
            pullers.push(p);
        }
        if (pullers.length === 0)
            return;
        for (const p of pullers) {
            if (!p.strict)
                continue;
            const account = getAccount(db, userId, p.id);
            if (account && account.status !== 'ok') {
                throw new Error(`${p.id} account needs attention`);
            }
        }
        const key = JSON.stringify([userId, document]);
        const existing = pending.get(key);
        if (existing)
            return existing;
        const controller = new AbortController();
        let timer;
        const deadline = new Promise((_, reject) => {
            timer = setTimeout(() => {
                const error = new DOMException('Progress refresh timed out', 'TimeoutError');
                controller.abort(error);
                reject(error);
            }, 10_000);
        });
        const bounded = (url, init) => {
            controller.signal.throwIfAborted();
            return http(url, {
                ...init, signal: init.signal ? AbortSignal.any([controller.signal, init.signal]) : controller.signal,
            });
        };
        const refresh = Promise.race([
            Promise.all(pullers.map((p) => pollConnector(db, userId, p.id, bounded, {
                document,
                signal: controller.signal,
                throwOnError: p.strict,
            }))),
            deadline,
        ]).then(() => {
            if (pullers.some((p) => p.id === 'bookorbit')) {
                void importBookorbitStats(db, userId, http, { document }).catch(() => { });
            }
        }, (error) => {
            if (pullers.some((p) => p.strict))
                throw error;
        }).finally(() => {
            clearTimeout(timer);
            pending.delete(key);
        });
        pending.set(key, refresh);
        return refresh;
    };
}
