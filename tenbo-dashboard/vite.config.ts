import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { tenboApiPlugin } from './src/api/plugin';

export default defineConfig({
  plugins: [react(), tenboApiPlugin()],
  server: { port: 5174 },
  // Force pre-bundling of the markdown chain. When the dashboard is installed as a
  // consumer dependency, Vite's optimizer fails to walk into transitive CJS deps
  // like `style-to-js`, and serving them raw via `/@fs/` produces a silent
  // "module does not provide an export named 'default'" SyntaxError that aborts
  // React mounting. Listing them here makes Vite pre-bundle them with proper
  // ESM interop.
  optimizeDeps: {
    include: [
      // React subpath — the optimizer auto-handles `react-dom` root but NOT
      // `react-dom/client`, so the subpath gets served raw via `/@fs/` and
      // breaks default-import interop in consumer installs.
      'react-dom/client',
      // Markdown chain — transitive CJS deps (style-to-js, hast-util-to-jsx-runtime)
      // also need explicit pre-bundling for consumer installs. Without this,
      // they're served raw and produce silent SyntaxError aborting React mount.
      'react-markdown',
      'remark-gfm',
      'style-to-js',
      'hast-util-to-jsx-runtime',
      // lucide-react ships ~1500 individual icon files in dist/esm/icons/.
      // Without pre-bundling, the dev server serves each icon as a separate
      // ESM module the browser fetches one-by-one — first launch sits on
      // 'Loading...' for 10+ seconds. Forcing pre-bundle collapses them
      // into a single chunk served from .vite/deps. (td-010)
      'lucide-react',
    ],
  },
});
