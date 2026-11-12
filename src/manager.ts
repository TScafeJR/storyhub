import { addons } from 'storybook/manager-api';

const EVENT = 'storyhub/branches-changed';
const REF_BASE = '/__storyhub/';

interface BranchSummary {
    id: string;
    branch: string | null;
    path: string;
    drift: string[];
    affectedStories: number;
    refUrl: string;
    error?: string;
}

interface RefLike {
    id: string;
    url: string;
    title?: string;
    expanded?: boolean;
}

const DRIFT_LABEL: Record<string, string> = {
    'deps-drift': 'deps changed',
    'config-drift': '.storybook changed',
    diverged: 'diverged',
    behind: 'behind main',
    'missing-dep': 'missing deps'
};

export function titleFor(b: BranchSummary): string {
    const name = b.branch ?? b.path.split(/[\\/]/).pop() ?? b.id;
    const notes: string[] = [];
    if (b.error) notes.push('error');
    else if (b.affectedStories === 0) notes.push('no story changes');
    for (const d of b.drift) notes.push(DRIFT_LABEL[d] ?? d);
    return `⎇ ${name}${notes.length ? ` · ${notes.join(', ')}` : ''}`;
}

const globalRefs = (): Record<string, RefLike> => {
    const g = globalThis as unknown as { REFS?: Record<string, RefLike> };
    return (g.REFS ??= {});
};

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

addons.register('storyhub', api => {
    const stored = () => api.getRefs() as Record<string, RefLike & { type?: string }>;

    /*
     * Storybook's updateRef rebuilds the ref list from the keys of the startup REFS object, reading
     * each ref from a store that only updates on React's next render. A key that is in REFS before
     * its ref reaches the store therefore rebuilds as undefined and crashes the sidebar. Two rules
     * keep that from happening:
     *  1. Change nothing until Storybook has finished its own startup checks (every startup ref is
     *     in the store with a resolved type), since those run updateRef concurrently.
     *  2. A new key stays non-enumerable (invisible to that rebuild) except during our own
     *     synchronous setRef, and becomes visible only once the store holds its ref.
     */
    const startupSettled = async () => {
        for (let i = 0; i < 300; i++) {
            const current = stored();
            if (Object.keys(globalRefs()).every(k => current[k] && current[k].type !== 'unknown')) return;
            await sleep(50);
        }
    };

    const insertRef = async (ref: RefLike) => {
        const REFS = globalRefs();
        for (let attempt = 0; attempt < 40; attempt++) {
            Object.defineProperty(REFS, ref.id, { value: ref, enumerable: true, configurable: true, writable: true });
            void api.setRef(ref.id, { ...ref, type: 'unknown' } as never); // reaches updateRef synchronously
            Object.defineProperty(REFS, ref.id, { value: ref, enumerable: false, configurable: true, writable: true });
            for (let wait = 0; wait < 10 && !stored()[ref.id]; wait++) await sleep(20);
            if (stored()[ref.id]) {
                Object.defineProperty(REFS, ref.id, { value: ref, enumerable: true, configurable: true, writable: true });
                return;
            }
            // another update rebuilt the list while the key was hidden and dropped it; try again
        }
    };

    let syncing = Promise.resolve();
    const sync = (branches: BranchSummary[]) => {
        syncing = syncing.then(async () => {
            await startupSettled();
            const REFS = globalRefs();
            const current = stored();
            const wanted = new Set(branches.map(b => b.id));
            for (const b of branches) {
                const title = titleFor(b);
                if (!current[b.id]) await insertRef({ id: b.id, title, url: b.refUrl, expanded: true });
                await api.checkRef({ id: b.id, url: b.refUrl, title, expanded: current[b.id]?.expanded ?? true, type: 'unknown' } as never);
                await api.updateRef(b.id, { title } as never);
            }
            for (const [id, ref] of Object.entries(REFS)) {
                if (typeof ref?.url === 'string' && ref.url.startsWith(REF_BASE) && !wanted.has(id)) {
                    delete REFS[id];
                    await api.updateRef(id, {} as never); // re-orders refs, dropping the removed one
                }
            }
        }).catch(err => console.warn('[storyhub] failed to sync branches', err));
    };

    addons.getChannel().on(EVENT, sync);
    fetch(`${REF_BASE}branches.json`, { cache: 'no-store' })
        .then(r => (r.ok ? r.json() : null))
        .then(data => data?.branches && sync(data.branches))
        .catch(() => {});
});
