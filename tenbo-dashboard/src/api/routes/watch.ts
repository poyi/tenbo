import type { Connect } from 'vite';
import watcher, { type AsyncSubscription, type Event as WatcherEvent } from '@parcel/watcher';
import path from 'node:path';
import fs from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { getRecentOrigin } from '../lib/recentWrites';
import { invalidate as invalidateParseCache } from '../lib/parseCache';
import type { Item } from '../../types';

/**
 * SSE channel — server-pushed events the dashboard subscribes to.
 *
 * Two event kinds (td-006, item-level events — Q2=b):
 *
 *   {kind: 'roadmap-change', scopeId, items, origin?}
 *     Fires when a `.tenbo/scopes/<scope>/roadmap.yaml` changes. The full
 *     post-change items list for that scope is included in the payload —
 *     the client replaces its local items[] for that scope without a full
 *     state refetch. Lightest payload that still scales beyond ~100 items.
 *
 *   {kind: 'file-change', event, path, origin?}
 *     Fires for non-roadmap changes (architecture.yaml, narratives,
 *     workspace files, principles.md, glossary.md, /docs/superpowers/, etc).
 *     Client triggers its existing debounced full reload — these are rare
 *     and structural; per-file diffs aren't worth the protocol surface yet.
 *
 * Both event types include `origin` when the write was made by a known
 * client (set via X-Tenbo-Origin header on the originating PATCH); the
 * client filters echoes of its own writes — see useTenboState.
 *
 * File watching uses @parcel/watcher (native FSEvents/inotify directly) —
 * faster and more reliable than chokidar at scale, with proper atomic-write
 * handling. Editor swap files are filtered via the ignore globs below.
 */

// Editor swap-file patterns that should never trigger SSE events.
const IGNORE_GLOBS = [
  '**/*.swp',     // vim
  '**/*.swo',     // vim
  '**/*.swx',     // vim
  '**/*~',        // many editors' backup
  '**/4913',      // vim's pre-write probe
  '**/*.tmp',     // simple atomic-rename staging
  '**/*.tmp.*',   // tenboFs.ts atomic writes use `<file>.tmp.<PID>.<ts>` suffix
  '**/.DS_Store', // macOS
  '**/.git/**',
  '**/node_modules/**',
];

interface RoadmapSnapshot {
  // Per-scope items snapshot keyed by absolute roadmap.yaml path. Used to
  // serve the latest items[] in `roadmap-change` events without re-reading
  // on every SSE client subscribe.
  itemsByPath: Map<string, Item[]>;
}

function isRoadmapFile(absPath: string, repoRoot: string): { isRoadmap: true; scopeId: string } | { isRoadmap: false } {
  const tenboScopes = path.join(repoRoot, '.tenbo', 'scopes');
  if (!absPath.startsWith(tenboScopes + path.sep)) return { isRoadmap: false };
  if (path.basename(absPath) !== 'roadmap.yaml') return { isRoadmap: false };
  const rel = absPath.slice(tenboScopes.length + 1);
  const parts = rel.split(path.sep);
  if (parts.length !== 2) return { isRoadmap: false }; // expect <scope>/roadmap.yaml
  return { isRoadmap: true, scopeId: parts[0] };
}

function readRoadmapItems(absPath: string): Item[] {
  try {
    const text = fs.readFileSync(absPath, 'utf8');
    const doc = parseYaml(text);
    const items = (doc?.items as Item[]) ?? [];
    return items;
  } catch {
    // Partial-write race or YAML error — skip emitting; client falls back
    // to debounced full reload via the file-change path.
    return [];
  }
}

export function watchRoute(repoRoot: string): { handler: Connect.NextHandleFunction; close: () => Promise<void> } {
  const tenboPath = path.join(repoRoot, '.tenbo');
  const docsPath = path.join(repoRoot, 'docs/superpowers');

  const snapshot: RoadmapSnapshot = { itemsByPath: new Map() };

  type Client = { write: (data: string) => void; end: () => void };
  const clients = new Set<Client>();

  function broadcast(payload: object) {
    const line = `data: ${JSON.stringify(payload)}\n\n`;
    for (const c of clients) c.write(line);
  }

  function emitRoadmapChange(absPath: string, scopeId: string, originHint: string | null) {
    const items = readRoadmapItems(absPath);
    snapshot.itemsByPath.set(absPath, items);
    broadcast({
      kind: 'roadmap-change',
      scopeId,
      items,
      origin: originHint,
    });
  }

  function emitFileChange(absPath: string, type: WatcherEvent['type'], originHint: string | null) {
    broadcast({
      kind: 'file-change',
      event: type, // 'create' | 'update' | 'delete'
      path: path.relative(repoRoot, absPath),
      origin: originHint,
    });
  }

  function handleEvent(absPath: string, type: WatcherEvent['type']) {
    // External writes (and our own atomic-rename writes) invalidate the
    // parsed-file cache so the next read picks up the change.
    invalidateParseCache(absPath);
    const origin = getRecentOrigin(absPath);
    const cls = isRoadmapFile(absPath, repoRoot);
    if (cls.isRoadmap) {
      // For deletions, the file may be gone; still emit so the client knows
      // to clear (or the next full reload picks it up).
      if (type === 'delete') {
        snapshot.itemsByPath.delete(absPath);
        broadcast({ kind: 'roadmap-change', scopeId: cls.scopeId, items: [], origin });
        return;
      }
      emitRoadmapChange(absPath, cls.scopeId, origin);
    } else {
      emitFileChange(absPath, type, origin);
    }
  }

  // Subscribe to each watch root. @parcel/watcher takes one path per call.
  const subscriptions: AsyncSubscription[] = [];
  async function subscribeIfExists(p: string) {
    try {
      if (!fs.existsSync(p)) return;
      const sub = await watcher.subscribe(p, (err, events) => {
        if (err) return; // best-effort — file watcher errors shouldn't crash the dev server
        for (const ev of events) handleEvent(ev.path, ev.type);
      }, { ignore: IGNORE_GLOBS });
      subscriptions.push(sub);
    } catch {
      // Native binary not available for this platform / permissions — degrade gracefully.
      // (Calls fall through; SSE just won't fire on file changes.)
    }
  }
  // Fire-and-forget; subscribe happens async at startup.
  void subscribeIfExists(tenboPath);
  void subscribeIfExists(docsPath);

  const handler: Connect.NextHandleFunction = (req, res, next) => {
    if (req.method !== 'GET' || req.url !== '/api/watch') return next();
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.write(': connected\n\n');
    const client: Client = { write: (d) => res.write(d), end: () => res.end() };
    clients.add(client);
    req.on('close', () => clients.delete(client));
  };

  async function close() {
    await Promise.all(subscriptions.map((s) => s.unsubscribe().catch(() => {})));
  }

  return { handler, close };
}
