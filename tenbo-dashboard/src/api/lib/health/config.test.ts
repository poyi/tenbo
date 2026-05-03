import { describe, it, expect } from 'vitest';
import { loadHealthConfig, DEFAULT_HEALTH_CONFIG } from './config';
import { writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

function makeRepo(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'tenbo-health-'));
  mkdirSync(path.join(root, '.tenbo'), { recursive: true });
  return root;
}

describe('loadHealthConfig', () => {
  it('returns defaults when no config file exists', () => {
    const root = makeRepo();
    const cfg = loadHealthConfig(root);
    expect(cfg).toEqual(DEFAULT_HEALTH_CONFIG);
    rmSync(root, { recursive: true, force: true });
  });

  it('merges file values over defaults', () => {
    const root = makeRepo();
    writeFileSync(path.join(root, '.tenbo/health.config.yaml'), `
thresholds:
  hotspot_loc:
    critical: 2000
`);
    const cfg = loadHealthConfig(root);
    expect(cfg.thresholds.hotspot_loc.critical).toBe(2000);
    expect(cfg.thresholds.hotspot_loc.warning).toBe(DEFAULT_HEALTH_CONFIG.thresholds.hotspot_loc.warning);
    rmSync(root, { recursive: true, force: true });
  });

  it('preserves signal_weights override order', () => {
    const root = makeRepo();
    writeFileSync(path.join(root, '.tenbo/health.config.yaml'), `
signal_weights:
  - aging-todos
  - dead-code
`);
    const cfg = loadHealthConfig(root);
    expect(cfg.signal_weights[0]).toBe('aging-todos');
    rmSync(root, { recursive: true, force: true });
  });
});
