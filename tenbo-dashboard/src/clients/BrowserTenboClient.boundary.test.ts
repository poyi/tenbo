import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

describe('browser transport boundary', () => {
  it('does not import Node or server storage implementations', () => {
    const browserClient = readFileSync(path.join(process.cwd(), 'src/clients/BrowserTenboClient.ts'), 'utf8');
    const browserFacade = readFileSync(path.join(process.cwd(), 'src/api/client.ts'), 'utf8');
    const source = `${browserClient}\n${browserFacade}`;
    expect(source).not.toMatch(/from ['"]node:/);
    expect(source).not.toMatch(/tenboFs|roadmapStore|LocalTenboBackend|CloudTenboBackend/);
    expect(source).toContain("from '../clients/BrowserTenboClient'");
  });
});
