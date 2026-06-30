import type { SourceIndex, SourceIndexFile } from './types';

export interface SourceEvidenceFile {
  path: string;
  scope?: string;
  layers: string[];
  score: number;
  reason: string;
}

export interface SourceIndexQueryResult {
  scopeScores: Map<string, number>;
  layerScores: Map<string, number>;
  files: SourceEvidenceFile[];
}

const STOP_WORDS = new Set(['the', 'and', 'for', 'with', 'from', 'into', 'this', 'that', 'work', 'feature']);

function queryTokens(query: string): Set<string> {
  return new Set(query
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 2 && !STOP_WORDS.has(token)));
}

function overlap(tokens: Set<string>, values: string[]): number {
  let score = 0;
  const valueSet = new Set(values.map((value) => value.toLowerCase()));
  for (const token of tokens) {
    if (valueSet.has(token)) score += 1;
  }
  return score;
}

function addScore(map: Map<string, number>, key: string | undefined, score: number) {
  if (!key || score <= 0) return;
  map.set(key, (map.get(key) ?? 0) + score);
}

function fileScore(file: SourceIndexFile, tokens: Set<string>): number {
  return overlap(tokens, [
    ...file.tokens,
    ...file.symbols,
    ...file.exports,
    ...file.path.split(/[\/._-]+/),
  ]);
}

export function querySourceIndex(index: SourceIndex, query: string): SourceIndexQueryResult {
  const tokens = queryTokens(query);
  const scopeScores = new Map<string, number>();
  const layerScores = new Map<string, number>();
  const files: SourceEvidenceFile[] = [];

  for (const layer of index.layers) {
    const score = overlap(tokens, [...layer.tokens, layer.scope, layer.layer]) * 20;
    addScore(scopeScores, layer.scope, score);
    addScore(layerScores, `${layer.scope}:${layer.layer}`, score);
  }

  for (const file of index.files) {
    const score = fileScore(file, tokens);
    if (score <= 0) continue;
    addScore(scopeScores, file.scope, score * 2);
    for (const layer of file.layers) addScore(layerScores, file.scope ? `${file.scope}:${layer}` : layer, score * 2);
    files.push({
      path: file.path,
      scope: file.scope,
      layers: file.layers,
      score,
      reason: `Matched indexed source evidence (${score} token${score === 1 ? '' : 's'})`,
    });
  }

  files.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return { scopeScores, layerScores, files: files.slice(0, 12) };
}
