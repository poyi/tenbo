import type { Connect } from 'vite';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { readBody, json, error, withErrorHandling } from '../lib/http';

export function openRoute(repoRoot: string): Connect.NextHandleFunction {
  return withErrorHandling(async (req, res, next) => {
    if (req.method !== 'POST' || req.url !== '/api/open') return next();
    const { path: rel } = await readBody<{ path?: unknown }>(req);
    if (typeof rel !== 'string') {
      return error(res, 400, 'path required');
    }
    const abs = path.resolve(repoRoot, rel);
    // VS Code / Cursor; if `code` not on PATH, this just fails silently in spawn
    spawn('code', ['-g', abs], { detached: true, stdio: 'ignore' }).unref();
    json(res, { ok: true });
  });
}
