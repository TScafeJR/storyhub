#!/usr/bin/env node
// Regenerates the README screenshots in docs/images from a small demo design system with three
// branches, rendered by a real Storybook with storyhub. Run `pnpm build` first.
//
//   node scripts/screenshots.mjs [--keep]
//
// --keep leaves the demo repo and Storybook running for a look around.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createFixture, runGit } from '../test/fixtures/create-fixture.mjs';

const libRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(libRoot, 'docs/images');
const keep = process.argv.includes('--keep');

const write = (root, files) => {
    for (const [rel, content] of Object.entries(files)) {
        mkdirSync(dirname(join(root, rel)), { recursive: true });
        writeFileSync(join(root, rel), content);
    }
};

const tokens = `export const color = {
    ink: '#18181b',
    muted: '#52525b',
    subtle: '#a1a1aa',
    line: '#e4e4e7',
    surface: '#ffffff',
    canvas: '#fafafa',
    accent: '#2563eb',
    accentSoft: '#eff6ff'
};
export const font = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";
`;

const button = `import React from 'react';
import { color, font } from '../tokens';

export interface ButtonProps {
    label: string;
    variant?: 'primary' | 'secondary';
    size?: 'md' | 'sm';
}

export const Button = ({ label, variant = 'primary', size = 'md' }: ButtonProps) => (
    <button
        style={{
            fontFamily: font,
            fontSize: size === 'sm' ? 13 : 14,
            fontWeight: 600,
            lineHeight: 1,
            padding: size === 'sm' ? '8px 12px' : '11px 18px',
            borderRadius: 6,
            border: \`1px solid \${variant === 'primary' ? color.accent : color.line}\`,
            background: variant === 'primary' ? color.accent : color.surface,
            color: variant === 'primary' ? '#fff' : color.ink,
            cursor: 'pointer'
        }}
    >
        {label}
    </button>
);
`;

const pillButton = `import React from 'react';
import { color, font } from '../tokens';

export interface ButtonProps {
    label: string;
    variant?: 'primary' | 'secondary';
    size?: 'md' | 'sm';
}

const teal = '#0f766e';

export const Button = ({ label, variant = 'primary', size = 'md' }: ButtonProps) => (
    <button
        style={{
            fontFamily: font,
            fontSize: size === 'sm' ? 13 : 15,
            fontWeight: 600,
            lineHeight: 1,
            padding: size === 'sm' ? '8px 14px' : '12px 22px',
            borderRadius: 999,
            border: \`1.5px solid \${variant === 'primary' ? teal : color.ink}\`,
            background: variant === 'primary' ? teal : 'transparent',
            color: variant === 'primary' ? '#fff' : color.ink,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
            cursor: 'pointer'
        }}
    >
        {label}
        <span aria-hidden>→</span>
    </button>
);
`;

const badge = `import React from 'react';
import { color, font } from '../tokens';

const tones = {
    neutral: { bg: '#f4f4f5', fg: color.muted },
    accent: { bg: color.accentSoft, fg: color.accent },
    success: { bg: '#ecfdf5', fg: '#047857' },
    warning: { bg: '#fffbeb', fg: '#b45309' }
};

export const Badge = ({ children, tone = 'neutral' }: { children: React.ReactNode; tone?: keyof typeof tones }) => (
    <span style={{ fontFamily: font, fontSize: 12, fontWeight: 600, padding: '4px 8px', borderRadius: 999, background: tones[tone].bg, color: tones[tone].fg }}>{children}</span>
);
`;

const planCard = `import React from 'react';
import { color, font } from '../tokens';
import { Badge } from './Badge';
import { Button } from './Button';

export interface PlanCardProps {
    name: string;
    price: string;
    features: string[];
    featured?: boolean;
}

export const PlanCard = ({ name, price, features, featured = false }: PlanCardProps) => (
    <div
        style={{
            fontFamily: font,
            width: 280,
            padding: 24,
            borderRadius: 12,
            background: color.surface,
            border: \`1px solid \${featured ? color.ink : color.line}\`,
            boxShadow: featured ? '0 12px 32px rgba(24, 24, 27, 0.10)' : 'none',
            display: 'flex',
            flexDirection: 'column',
            gap: 18
        }}
    >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: 15, fontWeight: 600, color: color.ink }}>{name}</span>
            {featured && <Badge tone="accent">Popular</Badge>}
        </div>
        <div>
            <span style={{ fontSize: 34, fontWeight: 700, color: color.ink, letterSpacing: -0.5 }}>{price}</span>
            <span style={{ fontSize: 14, color: color.muted }}> / month</span>
        </div>
        <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: 10, fontSize: 14, color: color.muted }}>
            {features.map(f => (
                <li key={f}>✓&nbsp;&nbsp;{f}</li>
            ))}
        </ul>
        <Button label={featured ? 'Start free trial' : 'Choose plan'} variant={featured ? 'primary' : 'secondary'} />
    </div>
);
`;

const alert = (strong) => `import React from 'react';
import { font } from '../tokens';

const tones = {
    info: { bg: '#eff6ff', border: '${strong ? '#1d4ed8' : '#bfdbfe'}', fg: '${strong ? '#1e3a8a' : '#3b82f6'}', icon: 'i' },
    success: { bg: '#ecfdf5', border: '${strong ? '#047857' : '#a7f3d0'}', fg: '${strong ? '#064e3b' : '#10b981'}', icon: '✓' },
    warning: { bg: '#fffbeb', border: '${strong ? '#b45309' : '#fde68a'}', fg: '${strong ? '#78350f' : '#f59e0b'}', icon: '!' }
};

export const Alert = ({ tone = 'info', title, children }: { tone?: keyof typeof tones; title: string; children: React.ReactNode }) => (
    <div
        role="status"
        style={{
            fontFamily: font,
            width: 380,
            display: 'flex',
            gap: 12,
            padding: '14px 16px',
            borderRadius: 8,
            background: tones[tone].bg,
            border: \`1px solid \${tones[tone].border}\`,${strong ? "\n            borderLeftWidth: 4," : ''}
            color: tones[tone].fg
        }}
    >
        <span style={{ width: 20, height: 20, flex: 'none', borderRadius: 999, border: '1.5px solid currentColor', display: 'grid', placeItems: 'center', fontSize: 12, fontWeight: 700 }}>{tones[tone].icon}</span>
        <div style={{ display: 'grid', gap: 4 }}>
            <strong style={{ fontSize: 14 }}>{title}</strong>
            <span style={{ fontSize: 14, opacity: ${strong ? 1 : 0.85} }}>{children}</span>
        </div>
    </div>
);
`;

const avatar = `import React from 'react';
import { font } from '../tokens';

const palette = ['#2563eb', '#db2777', '#059669', '#d97706', '#7c3aed'];

export const Avatar = ({ name, size = 40 }: { name: string; size?: number }) => {
    const initials = name.split(' ').map(p => p[0]).join('').slice(0, 2);
    const bg = palette[name.length % palette.length];
    return (
        <span style={{ fontFamily: font, width: size, height: size, borderRadius: 999, background: bg, color: '#fff', display: 'inline-grid', placeItems: 'center', fontSize: size * 0.38, fontWeight: 600, border: '2px solid #fff' }}>{initials}</span>
    );
};
`;

const textField = `import React from 'react';
import { color, font } from '../tokens';

export const TextField = ({ label, placeholder, error }: { label: string; placeholder?: string; error?: string }) => (
    <label style={{ fontFamily: font, display: 'grid', gap: 6, width: 300, fontSize: 14, color: color.ink }}>
        <span style={{ fontWeight: 600 }}>{label}</span>
        <input placeholder={placeholder} style={{ font: 'inherit', padding: '10px 12px', borderRadius: 6, border: \`1px solid \${error ? '#dc2626' : color.line}\` }} />
        {error && <span style={{ color: '#dc2626', fontSize: 13 }}>{error}</span>}
    </label>
);
`;

const stories = {
    'src/components/Button.stories.tsx': `import { Button } from './Button';
export default { title: 'Components/Button', component: Button };
export const Primary = { args: { label: 'Save changes' } };
export const Secondary = { args: { label: 'Cancel', variant: 'secondary' } };
export const Small = { args: { label: 'Edit', size: 'sm' } };
`,
    'src/components/Badge.stories.tsx': `import { Badge } from './Badge';
export default { title: 'Components/Badge', component: Badge };
export const Neutral = { args: { children: 'Draft' } };
export const Success = { args: { children: 'Active', tone: 'success' } };
export const Warning = { args: { children: 'Expiring', tone: 'warning' } };
`,
    'src/components/PlanCard.stories.tsx': `import { PlanCard } from './PlanCard';
export default { title: 'Components/Plan Card', component: PlanCard };
const features = ['Unlimited projects', 'Branch previews', 'Priority support'];
export const Featured = { args: { name: 'Team', price: '$24', features, featured: true } };
export const Basic = { args: { name: 'Starter', price: '$0', features: features.slice(0, 2) } };
`,
    'src/components/Alert.stories.tsx': `import { Alert } from './Alert';
export default { title: 'Components/Alert', component: Alert };
export const Info = { args: { title: 'New version available', children: 'Reload to get the latest changes.' } };
export const Success = { args: { tone: 'success', title: 'Saved', children: 'Your settings were updated.' } };
export const Warning = { args: { tone: 'warning', title: 'Trial ends soon', children: 'Add a payment method to keep your projects.' } };
`,
    'src/components/Avatar.stories.tsx': `import { Avatar } from './Avatar';
export default { title: 'Components/Avatar', component: Avatar };
export const Default = { args: { name: 'Ada Lovelace' } };
export const Large = { args: { name: 'Grace Hopper', size: 64 } };
`,
    'src/components/TextField.stories.tsx': `import { TextField } from './TextField';
export default { title: 'Components/Text Field', component: TextField };
export const Default = { args: { label: 'Email', placeholder: 'you@example.com' } };
export const WithError = { args: { label: 'Email', placeholder: 'you@example.com', error: 'Enter a valid email address.' } };
`
};

const pricingTable = {
    'src/patterns/PricingTable.tsx': `import React from 'react';
import { PlanCard } from '../components/PlanCard';
import { font } from '../tokens';

const features = ['Unlimited projects', 'Branch previews', 'Priority support', 'SSO'];

export const PricingTable = () => (
    <section style={{ fontFamily: font, display: 'grid', gap: 24, justifyItems: 'center' }}>
        <h2 style={{ margin: 0, fontSize: 28 }}>Simple pricing</h2>
        <div style={{ display: 'flex', gap: 16 }}>
            <PlanCard name="Starter" price="$0" features={features.slice(0, 2)} />
            <PlanCard name="Team" price="$24" features={features.slice(0, 3)} featured />
            <PlanCard name="Enterprise" price="$99" features={features} />
        </div>
    </section>
);
`,
    'src/patterns/PricingTable.stories.tsx': `import { PricingTable } from './PricingTable';
export default { title: 'Patterns/Pricing Table', component: PricingTable };
export const Default = {};
`
};

const hubFiles = {
    '.storybook/main.ts': `import type { StorybookConfig } from '@storybook/react-vite';

const config: StorybookConfig = {
    stories: ['../src/**/*.stories.tsx'],
    addons: ['@storybook/addon-mcp', 'storyhub'],
    framework: '@storybook/react-vite',
    core: { disableTelemetry: true, disableWhatsNewNotifications: true },
    features: { sidebarOnboardingChecklist: false }
};
export default config;
`,
    '.storybook/preview.tsx': `import type { Preview } from '@storybook/react-vite';

const preview: Preview = {
    parameters: { layout: 'centered' }
};
export default preview;
`,
    'src/tokens.ts': tokens,
    'src/components/Button.tsx': button,
    'src/components/Badge.tsx': badge,
    'src/components/PlanCard.tsx': planCard,
    'src/components/Alert.tsx': alert(false),
    'src/components/Avatar.tsx': avatar,
    'src/components/TextField.tsx': textField,
    ...stories
};

const branches = {
    'feat/pill-buttons': { dir: 'pill-buttons', files: { 'src/components/Button.tsx': pillButton } },
    'fix/alert-contrast': { dir: 'alert-contrast', files: { 'src/components/Alert.tsx': alert(true) } },
    'feat/pricing-table': { dir: 'pricing-table', files: pricingTable }
};

const panel = (label, sub, img, accent) => `
  <figure>
    <figcaption><span class="dot" style="background:${accent}"></span><b>${label}</b><span class="sub">${sub}</span></figcaption>
    <img src="data:image/png;base64,${img}">
  </figure>`;

const freePort = () =>
    new Promise((res, rej) => {
        const srv = createServer();
        srv.listen(0, '127.0.0.1', () => {
            const { port } = srv.address();
            srv.close(() => res(port));
        });
        srv.on('error', rej);
    });

const until = async (fn, what, timeout = 120_000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
        try {
            const v = await fn();
            if (v) return v;
        } catch {
            // not yet
        }
        await new Promise(r => setTimeout(r, 300));
    }
    throw new Error(`timed out waiting for ${what}`);
};

// 1. demo repo: the fixture's installed dependencies, with the demo design system as its source
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'storyhub-demo-')));
const { hub } = createFixture({ dir, scenarios: [], builder: 'vite' });
rmSync(join(hub, 'src'), { recursive: true, force: true });
rmSync(join(hub, 'packages'), { recursive: true, force: true });
write(hub, hubFiles);
runGit(hub, 'add', '-A');
runGit(hub, 'commit', '-q', '-m', 'demo design system');
for (const [branch, { dir: name, files }] of Object.entries(branches)) {
    const wt = join(dir, name);
    runGit(hub, 'worktree', 'add', '-q', '-b', branch, wt);
    write(wt, files);
    runGit(wt, 'add', '-A');
    runGit(wt, 'commit', '-q', '-m', branch);
    runGit(hub, 'config', '--add', 'storyhub.include', branch);
}

// 2. Storybook
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
let log = '';
const sb = spawn(join(hub, 'node_modules/.bin/storybook'), ['dev', '-p', String(port), '--host', '127.0.0.1', '--ci', '--no-open'], {
    cwd: hub,
    env: { ...process.env, STORYBOOK_DISABLE_TELEMETRY: '1', NO_COLOR: '1' }
});
sb.stdout.on('data', d => (log += d));
sb.stderr.on('data', d => (log += d));
const stop = () => sb.kill('SIGTERM');
process.on('exit', stop);

try {
    const shown = await until(async () => {
        const res = await fetch(`${base}/__storyhub/branches.json`);
        const { branches: list } = await res.json();
        return list.length === 3 && list.every(b => b.affectedStories > 0) ? list : undefined;
    }, 'Storybook with three branches');
    const idOf = branch => shown.find(b => b.branch === branch).id;

    mkdirSync(out, { recursive: true });
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1240, height: 940 }, deviceScaleFactor: 2 });

    // 3. the whole Storybook, on a branch story
    const pill = idOf('feat/pill-buttons');
    await page.goto(`${base}/?path=/story/${pill}_components-plan-card--featured&panel=false`);
    await page.waitForSelector('#storybook-explorer-tree');
    const frame = await until(async () => {
        for (const f of page.frames()) {
            if (f.url().includes(`/__storyhub/${pill}/iframe.html`) && (await f.locator('#storybook-root button').count())) return f;
        }
        return undefined;
    }, 'the branch story to render', 60_000);
    await page.mouse.move(1200, 900);
    await frame.waitForTimeout(800);
    await page.screenshot({ path: join(out, 'storybook.png') });

    // 4. Common next to the branch, for the same story
    const shot = async url => {
        const p = await browser.newPage({ viewport: { width: 900, height: 700 }, deviceScaleFactor: 2 });
        await p.goto(url);
        await p.waitForSelector('#storybook-root button');
        await p.waitForTimeout(400);
        const box = await p.locator('#storybook-root > *').first().boundingBox();
        const pad = 28;
        const buf = await p.screenshot({ clip: { x: box.x - pad, y: box.y - pad, width: box.width + pad * 2, height: box.height + pad * 2 } });
        await p.close();
        return buf.toString('base64');
    };
    const story = 'components-plan-card--featured';
    const common = await shot(`${base}/iframe.html?id=${story}&viewMode=story`);
    const branched = await shot(`${base}/__storyhub/${pill}/iframe.html?id=${story}&viewMode=story`);
    const compare = await browser.newPage({ viewport: { width: 860, height: 520 }, deviceScaleFactor: 2 });
    await compare.setContent(`<!doctype html><html><head><style>
      body { margin: 0; font: 14px -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; color: #18181b; background: #fff; }
      main { display: inline-flex; gap: 20px; padding: 24px; }
      figure { margin: 0; border: 1px solid #e4e4e7; border-radius: 12px; overflow: hidden; background: #fafafa; }
      figcaption { display: flex; align-items: center; gap: 8px; padding: 12px 16px; background: #fff; border-bottom: 1px solid #e4e4e7; }
      .dot { width: 8px; height: 8px; border-radius: 999px; }
      .sub { color: #71717a; margin-left: auto; font-size: 13px; }
      img { display: block; margin: 0 auto; }
    </style></head><body><main>
      ${panel('Common', 'main checkout', common, '#a1a1aa')}
      ${panel('feat/pill-buttons', 'Button.tsx changed', branched, '#0f766e')}
    </main></body></html>`);
    // the shots are 2x; show them at their CSS size so the 2x page keeps them sharp
    await compare.evaluate(() => Promise.all([...document.images].map(async i => {
        await i.decode();
        i.style.width = `${i.naturalWidth / 2}px`;
    })));
    await compare.locator('main').screenshot({ path: join(out, 'compare.png') });

    await browser.close();
    console.log(`wrote ${join(out, 'storybook.png')} and ${join(out, 'compare.png')}`);
    if (keep) {
        console.log(`demo repo: ${hub}\nStorybook: ${base} (Ctrl+C to stop)`);
        await new Promise(() => {});
    }
} catch (err) {
    console.error(`${err.message}\n--- storybook log ---\n${log.slice(-3000)}`);
    process.exitCode = 1;
} finally {
    if (!keep) {
        stop();
        rmSync(dir, { recursive: true, force: true });
    }
}
