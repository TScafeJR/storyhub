import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import { hostnameOf, isAllowedHostname, refusal } from '../../src/server/guard.js';

const req = (headers: Record<string, string>) => ({ headers }) as unknown as IncomingMessage;

describe('request guard', () => {
    it('reads hostnames out of Host headers and URL hosts', () => {
        expect(hostnameOf('localhost:6006')).toBe('localhost');
        expect(hostnameOf('[::1]:6006')).toBe('::1');
        expect(hostnameOf('[::1]')).toBe('::1');
        expect(hostnameOf('Example.COM')).toBe('example.com');
    });

    it('allows IPs, localhost and *.localhost, and listed names only', () => {
        for (const h of ['127.0.0.1', '192.168.1.20', '::1', 'localhost', 'app.localhost', 'localhost.']) expect(isAllowedHostname(h)).toBe(true);
        for (const h of ['evil.example', 'localhost.evil.example', '127.0.0.1.nip.io', '']) expect(isAllowedHostname(h)).toBe(false);
        expect(isAllowedHostname('dev.box', ['dev.box'])).toBe(true);
        expect(isAllowedHostname('a.team.dev', ['.team.dev'])).toBe(true);
        expect(isAllowedHostname('team.dev', ['.team.dev'])).toBe(true);
        expect(isAllowedHostname('notteam.dev', ['.team.dev'])).toBe(false);
        expect(isAllowedHostname('anything', true)).toBe(true);
    });

    it('refuses DNS rebinding even when Origin matches Host', () => {
        expect(refusal(req({ host: 'evil.example:6006', origin: 'http://evil.example:6006' }))).toMatch(/Host/);
    });

    it('refuses cross-site origins and opaque ones', () => {
        expect(refusal(req({ host: 'localhost:6006', origin: 'https://evil.example' }))).toMatch(/Origin/);
        expect(refusal(req({ host: 'localhost:6006', origin: 'null' }))).toMatch(/Origin/);
    });

    it('lets local and tool requests through', () => {
        expect(refusal(req({ host: 'localhost:6006' }))).toBeNull();
        expect(refusal(req({ host: '127.0.0.1:6006', origin: 'http://127.0.0.1:6006' }))).toBeNull();
        expect(refusal(req({ host: '[::1]:6006', origin: 'http://localhost:6274' }))).toBeNull();
        expect(refusal(req({}))).toBeNull();
        expect(refusal(req({ host: 'dev.box:6006' }), ['dev.box'])).toBeNull();
    });
});
