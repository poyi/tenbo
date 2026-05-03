import { existsSync } from 'node:fs';
import path from 'node:path';

export function findRepoRoot(start: string): string | null {
  let cur = path.resolve(start);
  while (true) {
    if (existsSync(path.join(cur, '.git'))) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}
