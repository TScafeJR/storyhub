import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export async function git(cwd: string, args: string[]): Promise<string> {
    const { stdout } = await run('git', args, { cwd, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' });
    return stdout;
}

export async function gitTry(cwd: string, args: string[]): Promise<string | null> {
    try {
        return await git(cwd, args);
    } catch {
        return null;
    }
}
