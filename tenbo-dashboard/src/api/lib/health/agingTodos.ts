import { readFileSync } from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import type { Finding, Severity } from './types';
import type { HealthConfig } from './config';

interface TodoMatch { line: number; text: string }

/**
 * Find TODO|FIXME markers in single-line and block comments. Crude but
 * sufficient: we strip string literals before scanning to avoid false positives.
 */
export function parseTodoLines(source: string): TodoMatch[] {
  const stripped = source.replace(/(["'`])(?:\\.|(?!\1).)*\1/g, (m) => ' '.repeat(m.length));
  const lines = stripped.split('\n');
  const out: TodoMatch[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /(?:\/\/|\/\*|\*)\s*(TODO|FIXME)\b[^\n]*/i.exec(lines[i]);
    if (!m) continue;
    out.push({ line: i + 1, text: m[0].replace(/^[/*\s]+/, '') });
  }
  return out;
}

interface BlameInfo { author: string; commitHash: string; ageDays: number }

function gitBlameLine(repoRoot: string, relPath: string, line: number): BlameInfo | null {
  try {
    const out = execSync(`git blame --line-porcelain -L ${line},${line} -- "${relPath}"`, {
      cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    const commitHash = out.split('\n')[0]?.split(' ')[0] ?? '';
    const authorMatch = /^author (.+)$/m.exec(out);
    const timeMatch = /^author-time (\d+)$/m.exec(out);
    if (!commitHash || !timeMatch) return null;
    const ts = Number(timeMatch[1]) * 1000;
    const ageDays = Math.floor((Date.now() - ts) / (24 * 3600 * 1000));
    return { author: authorMatch?.[1] ?? 'unknown', commitHash, ageDays };
  } catch {
    return null;
  }
}

function severityForAge(ageDays: number, thresholds: HealthConfig['thresholds']['todo_age_months']): Severity | null {
  const months = ageDays / 30;
  if (months >= thresholds.critical) return 'critical';
  if (months >= thresholds.warning) return 'warning';
  if (months >= thresholds.info) return 'info';
  return null;
}

export function analyzeAgingTodos(
  repoRoot: string,
  layerId: string,
  files: string[],
  config: HealthConfig,
): Finding[] {
  const findings: Finding[] = [];
  for (const rel of files) {
    let src: string;
    try { src = readFileSync(path.resolve(repoRoot, rel), 'utf8'); } catch { continue; }
    const todos = parseTodoLines(src);
    if (todos.length === 0) continue;
    const lines = src.split('\n');
    for (const t of todos) {
      const blame = gitBlameLine(repoRoot, rel, t.line);
      if (!blame) continue;
      const severity = severityForAge(blame.ageDays, config.thresholds.todo_age_months);
      if (!severity) continue;
      const ctx = lines.slice(Math.max(0, t.line - 2), t.line + 1).join('\n');
      findings.push({
        id: `${layerId}.aging-todos.${rel.replace(/\W/g, '_')}_${t.line}`,
        signal: 'aging-todos',
        severity,
        confidence: 'high',
        layer: layerId,
        target: rel,
        headline: `${path.basename(rel)}:${t.line} — ${blame.ageDays}d old`,
        suggestion: {
          summary: 'Resolve or remove this TODO',
          rationale: `Created ${blame.ageDays} days ago by ${blame.author} (${blame.commitHash.slice(0, 7)}). Aging markers tend to outlive their relevance.`,
          action_kind: 'resolve-todo',
        },
        details: {
          kind: 'aging-todos',
          line: t.line,
          age_days: blame.ageDays,
          commit_hash: blame.commitHash,
          author: blame.author,
          text: t.text,
          context: ctx,
        },
      });
    }
  }
  return findings;
}
