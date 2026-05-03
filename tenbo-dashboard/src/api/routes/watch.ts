import type { Connect } from 'vite';
import chokidar from 'chokidar';
import path from 'node:path';

export function watchRoute(repoRoot: string): Connect.NextHandleFunction {
  // One watcher per process; multiple SSE clients share it.
  const watchPath = path.join(repoRoot, '.tenbo');
  const docsPath = path.join(repoRoot, 'docs/superpowers');
  const watcher = chokidar.watch([watchPath, docsPath], {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
  });

  type Client = { write: (data: string) => void; end: () => void };
  const clients = new Set<Client>();
  watcher.on('all', (event, file) => {
    const payload = `data: ${JSON.stringify({ event, path: path.relative(repoRoot, file) })}\n\n`;
    for (const c of clients) c.write(payload);
  });

  return (req, res, next) => {
    if (req.method !== 'GET' || req.url !== '/api/watch') return next();
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.write(': connected\n\n');
    const client: Client = { write: (d) => res.write(d), end: () => res.end() };
    clients.add(client);
    req.on('close', () => clients.delete(client));
  };
}
