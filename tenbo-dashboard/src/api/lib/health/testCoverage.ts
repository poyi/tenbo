import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Finding, Severity } from './types';

const USE_CASE_RE = /\/application\/[^/]*UseCase\.ts$/;
const INFRA_RE = /\/infrastructure\/[^/]+\.ts$/;
const TEST_SIBLING_PATTERNS = ['.test.ts', '.test.tsx'];

function siblingTestPath(repoRoot: string, file: string): string | null {
  const dir = path.dirname(file);
  const base = path.basename(file).replace(/\.tsx?$/, '');
  for (const suffix of TEST_SIBLING_PATTERNS) {
    const candidate = path.join(dir, base + suffix);
    if (existsSync(path.resolve(repoRoot, candidate))) return candidate;
    const inFolder = path.join(dir, '__tests__', base + suffix);
    if (existsSync(path.resolve(repoRoot, inFolder))) return inFolder;
  }
  return null;
}

export function analyzeTestCoverage(
  repoRoot: string,
  layerId: string,
  files: string[],
): Finding[] {
  const findings: Finding[] = [];
  for (const rel of files) {
    if (rel.endsWith('.test.ts') || rel.endsWith('.test.tsx')) continue;
    const isUseCase = USE_CASE_RE.test(rel);
    const isInfra = INFRA_RE.test(rel);
    if (!isUseCase && !isInfra) continue;
    if (siblingTestPath(repoRoot, rel)) continue;
    const severity: Severity = isUseCase ? 'warning' : 'info';
    const filename = path.basename(rel);
    const suggestedTestPath = rel.replace(/\.tsx?$/, '.test.ts');
    findings.push({
      id: `${layerId}.test-coverage.${filename.replace(/\W/g, '_')}`,
      signal: 'test-coverage',
      severity,
      confidence: 'high',
      layer: layerId,
      target: rel,
      headline: `${filename} has no test`,
      suggestion: {
        summary: `Add test at ${suggestedTestPath}`,
        rationale: isUseCase
          ? 'Application-layer use cases are core behavior and should have unit tests.'
          : 'Infrastructure adapters benefit from a focused test against their interface.',
        action_kind: 'add-test',
      },
      details: { kind: 'test-coverage', suggested_test_path: suggestedTestPath },
    });
  }
  return findings;
}
