import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config';

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: 'jsdom',
      globals: true,
      setupFiles: ['./src/test-setup.ts'],
      // td-038: lazy hub autostart is opt-out via TENBO_NO_AUTOSTART. Set it
      // for the whole suite so the many existing no-hub-fallback tests (that
      // predate autostart and don't expect it) stay side-effect-free instead
      // of each spawning a real detached child process. Dedicated autostart
      // tests (src/api/lib/hub/autostart.test.ts) exercise both branches by
      // passing an explicit `env` override to `maybeAutostartHub` directly,
      // independent of this process-wide default.
      env: { TENBO_NO_AUTOSTART: '1' },
    },
  }),
);
