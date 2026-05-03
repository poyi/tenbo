import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { SIGNAL_WEIGHTS_DEFAULT, type Signal } from './types';

export interface HealthConfig {
  thresholds: {
    hotspot_loc: { critical: number; warning: number; info: number };
    hotspot_function_loc: number;
    todo_age_months: { critical: number; warning: number; info: number };
    redundancy_min_lines: number;
  };
  ignore: {
    /** Repo-relative file paths exempted from hotspot-files signal. */
    hotspot_files: string[];
    /** Map of layer id -> array of signal ids to skip for that layer. */
    layer_signals: Record<string, Signal[]>;
  };
  signal_weights: Signal[];
}

export const DEFAULT_HEALTH_CONFIG: HealthConfig = {
  thresholds: {
    hotspot_loc: { critical: 1000, warning: 500, info: 300 },
    hotspot_function_loc: 150,
    todo_age_months: { critical: 12, warning: 6, info: 3 },
    redundancy_min_lines: 30,
  },
  ignore: {
    hotspot_files: [],
    layer_signals: {},
  },
  signal_weights: SIGNAL_WEIGHTS_DEFAULT,
};

export function loadHealthConfig(repoRoot: string): HealthConfig {
  const p = path.join(repoRoot, '.tenbo', 'health.config.yaml');
  if (!existsSync(p)) return DEFAULT_HEALTH_CONFIG;
  const raw = parseYaml(readFileSync(p, 'utf8')) as Partial<HealthConfig> | null;
  if (!raw) return DEFAULT_HEALTH_CONFIG;
  return {
    thresholds: {
      hotspot_loc: { ...DEFAULT_HEALTH_CONFIG.thresholds.hotspot_loc, ...(raw.thresholds?.hotspot_loc ?? {}) },
      hotspot_function_loc: raw.thresholds?.hotspot_function_loc ?? DEFAULT_HEALTH_CONFIG.thresholds.hotspot_function_loc,
      todo_age_months: { ...DEFAULT_HEALTH_CONFIG.thresholds.todo_age_months, ...(raw.thresholds?.todo_age_months ?? {}) },
      redundancy_min_lines: raw.thresholds?.redundancy_min_lines ?? DEFAULT_HEALTH_CONFIG.thresholds.redundancy_min_lines,
    },
    ignore: {
      hotspot_files: raw.ignore?.hotspot_files ?? DEFAULT_HEALTH_CONFIG.ignore.hotspot_files,
      layer_signals: raw.ignore?.layer_signals ?? DEFAULT_HEALTH_CONFIG.ignore.layer_signals,
    },
    signal_weights: raw.signal_weights ?? SIGNAL_WEIGHTS_DEFAULT,
  };
}
