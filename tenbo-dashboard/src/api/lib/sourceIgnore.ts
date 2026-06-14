export const DEFAULT_SOURCE_SCAN_IGNORES = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'target',
  '.vite',
  'coverage',
  'playwright-report',
  'test-results',
  'screenshots',
  'screenshot',
  '__screenshots__',
  'artifacts',
  '.next',
  'out',
  '.turbo',
  '.cache',
]);

export function shouldIgnoreSourceDir(name: string): boolean {
  return DEFAULT_SOURCE_SCAN_IGNORES.has(name);
}
