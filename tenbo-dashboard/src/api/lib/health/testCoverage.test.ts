import { describe, it, expect } from 'vitest';
import { analyzeTestCoverage } from './testCoverage';
import { writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

describe('analyzeTestCoverage', () => {
  it('flags use case files without sibling tests', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'cov-'));
    mkdirSync(path.join(root, 'src/domains/x/application'), { recursive: true });
    const a = 'src/domains/x/application/RunFooUseCase.ts';
    const b = 'src/domains/x/application/RunBarUseCase.ts';
    writeFileSync(path.join(root, a), 'export class RunFooUseCase {}');
    writeFileSync(path.join(root, b), 'export class RunBarUseCase {}');
    writeFileSync(path.join(root, 'src/domains/x/application/RunFooUseCase.test.ts'), 'test("x", () => {});');

    const findings = analyzeTestCoverage(root, 'lyr', [a, b]);
    expect(findings).toHaveLength(1);
    expect(findings[0].target).toBe(b);
    expect(findings[0].severity).toBe('warning');
    rmSync(root, { recursive: true, force: true });
  });

  it('flags non-use-case infrastructure files at info severity when missing tests', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'cov-'));
    mkdirSync(path.join(root, 'src/domains/x/infrastructure'), { recursive: true });
    const a = 'src/domains/x/infrastructure/SupabaseRepo.ts';
    writeFileSync(path.join(root, a), 'export class SupabaseRepo {}');
    const findings = analyzeTestCoverage(root, 'lyr', [a]);
    expect(findings.find(f => f.target === a)?.severity).toBe('info');
    rmSync(root, { recursive: true, force: true });
  });
});
