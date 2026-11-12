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

addons.register('storyhub', api => {
    const globalRefs = (): Record<string, RefLike> => {
        const g = globalThis as unknown as { REFS?: Record<string, RefLike> };
        return (g.REFS ??= {});
    };

    let syncing = Promise.resolve();
    const sync = (branches: BranchSummary[]) => {
        syncing = syncing.then(async () => {
            const REFS = globalRefs();
            const current = api.getRefs() as Record<string, RefLike>;
            const wanted = new Set(branches.map(b => b.id));
            for (const b of branches) {
                const title = titleFor(b);
                // the manager only keeps refs whose ids exist in the startup REFS object
                REFS[b.id] ??= { id: b.id, title, url: b.refUrl, expanded: true };
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
