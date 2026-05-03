import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { tenboApiPlugin } from './src/api/plugin';

export default defineConfig({
  plugins: [react(), tenboApiPlugin()],
  server: { port: 5174 },
  test: { environment: 'jsdom', globals: true, setupFiles: ['./src/test-setup.ts'] },
});
