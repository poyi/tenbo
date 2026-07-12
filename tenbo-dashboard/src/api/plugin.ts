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
import { hubHealthRoute } from './routes/hubHealth';
import { hubMutateRoute } from './routes/hubMutate';
import { writeHubLockfile, removeHubLockfile } from './lib/hub/lockfile';

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

      // td-029: promote this server into the single-writer hub for .tenbo/.
      // Health/mutate endpoints are always mounted; the lockfile that makes
      // them discoverable is only written once the HTTP server actually
      // binds a port, and removed on clean shutdown (a dead/stale lockfile
      // is treated as absent by discoverHub's liveness check either way).
      server.middlewares.use(hubHealthRoute(repoRoot));
      server.middlewares.use(hubMutateRoute(repoRoot));
      const httpServer = server.httpServer;
      if (httpServer) {
        httpServer.once('listening', () => {
          const address = httpServer.address();
          const port = typeof address === 'object' && address ? address.port : undefined;
          if (port) writeHubLockfile(repoRoot, port);
        });
        httpServer.on('close', () => removeHubLockfile(repoRoot));
      }
    },
  };
}
