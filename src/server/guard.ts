import type { IncomingMessage } from 'node:http';
import { isIP } from 'node:net';

/**
 * Keeps storyhub's dev-server routes (the MCP endpoint and /__storyhub/*) for local use.
 *
 * A web page can make a browser talk to localhost in two ways: DNS rebinding (a hostname the
 * attacker controls starts resolving to 127.0.0.1, so the page counts as same-origin) and plain
 * cross-site requests. The first is stopped by checking the Host header, the second by checking
 * Origin. The rules match Vite's `server.allowedHosts`: IP addresses, localhost and *.localhost
 * are always fine (rebinding needs a hostname), anything else must be listed.
 */
export type AllowedHosts = readonly string[] | true;

/** The hostname part of a Host header or URL host ("[::1]:6006" → "::1"). */
export function hostnameOf(host: string): string {
    const h = host.trim().toLowerCase();
    if (h.startsWith('[')) return h.slice(1, h.indexOf(']') === -1 ? undefined : h.indexOf(']'));
    const colon = h.indexOf(':');
    return colon === -1 || h.indexOf(':', colon + 1) !== -1 ? h : h.slice(0, colon);
}

export function isAllowedHostname(hostname: string, allowed: AllowedHosts = []): boolean {
    if (allowed === true) return true;
    const h = hostname.toLowerCase().replace(/\.$/, '');
    if (!h) return false;
    if (isIP(h) !== 0 || h === 'localhost' || h.endsWith('.localhost')) return true;
    return allowed.some(entry => {
        const e = entry.toLowerCase();
        // ".example.com" allows example.com and its subdomains, as in Vite
        return e.startsWith('.') ? h === e.slice(1) || h.endsWith(e) : h === e;
    });
}

/** Why a request must be refused, or null when it may go on. */
export function refusal(req: IncomingMessage, allowed: AllowedHosts = []): string | null {
    if (allowed === true) return null;
    const host = req.headers.host;
    // browsers always send Host; a request without one did not come from a web page
    if (host !== undefined && !isAllowedHostname(hostnameOf(host), allowed)) {
        return `Host "${host}" is not allowed. Add it to storyhub's allowedHosts option if you open Storybook under that name.`;
    }
    const origin = req.headers.origin;
    if (origin !== undefined) {
        let hostname: string;
        try {
            hostname = new URL(origin).hostname;
        } catch {
            return `Origin "${origin}" is not allowed.`;
        }
        if (!isAllowedHostname(hostnameOf(hostname), allowed)) return `Origin "${origin}" is not allowed.`;
    }
    return null;
}
