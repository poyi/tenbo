import type { Plugin } from 'vite';
import { findRepoRoot } from './lib/repoRoot';
import { stateRoute } from './routes/state';
import { itemsRoute } from './routes/items';
import { reorderRoute } from './routes/reorder';
import { relatedRoute } from './routes/related';
import { openRoute } from './routes/open';
import { watchRoute } from './routes/watch';
import { layerDocsRoute } from './routes/layerDocs';
import { layerContentRoute } from './routes/layerContent';
import { archiveRoute } from './routes/archive';
import { refreshMetricsRoute } from './routes/refreshMetrics';

export function tenboApiPlugin(): Plugin {
  return {
    name: 'tenbo-api',
    configureServer(server) {
      const repoRoot = findRepoRoot(process.cwd());
      if (!repoRoot) {
        console.error('[tenbo-dashboard] no git repo root found from cwd');
        return;
      }
      server.middlewares.use(stateRoute(repoRoot));
      server.middlewares.use(itemsRoute(repoRoot));
      server.middlewares.use(reorderRoute(repoRoot));
      server.middlewares.use(relatedRoute(repoRoot));
      server.middlewares.use(openRoute(repoRoot));
      const watch = watchRoute(repoRoot);
      server.middlewares.use(watch.handler);
      server.httpServer?.on('close', () => { void watch.close(); });
      server.middlewares.use(refreshMetricsRoute(repoRoot));
      server.middlewares.use(layerDocsRoute(repoRoot));
      server.middlewares.use(layerContentRoute(repoRoot));
      server.middlewares.use(archiveRoute(repoRoot));
    },
  };
}
