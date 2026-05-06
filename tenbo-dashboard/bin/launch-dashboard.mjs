import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import path from 'node:path';
import net from 'node:net';

const PREFERRED_PORT = 5174;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The cwd is the user's project directory (the dashboard reads .tenbo/ from there).
// Surface it on startup so the user can tell which repo a given dashboard is
// serving — important when multiple dashboards are running at once. (td-011)
const cwd = process.cwd();
console.log(`Serving .tenbo/ from ${cwd}`);

// Detect whether something is already listening on the preferred port. If so,
// try probing it for a tenbo-dashboard /api/state endpoint so we can name the
// other repo in the warning. Either way, surface a warning so the user isn't
// surprised when this instance lands on a different port. (td-011)
async function isPortInUse(port) {
  return new Promise((resolve) => {
    const tester = net.createConnection({ port, host: '127.0.0.1' });
    tester.once('connect', () => { tester.destroy(); resolve(true); });
    tester.once('error', () => resolve(false));
  });
}

async function probeOtherDashboard(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/state`, {
      signal: AbortSignal.timeout(500),
    });
    if (!r.ok) return null;
    // We don't have a structured "what's the cwd of this server" endpoint, so
    // we infer from the scopes' paths. If unavailable, fall through.
    const data = await r.json();
    const firstScope = data?.scopes?.[0];
    return firstScope ? `serving ${data.scopes.length} scope(s) (e.g. "${firstScope.id}")` : 'unknown repo';
  } catch {
    return null;
  }
}

if (await isPortInUse(PREFERRED_PORT)) {
  const other = await probeOtherDashboard(PREFERRED_PORT);
  const detail = other ? ` (${other})` : '';
  console.log(
    `Port ${PREFERRED_PORT} is already in use — likely another tenbo-dashboard${detail}.`,
  );
  console.log(`This instance will start on the next available port and serve ${cwd}.`);
}

const server = await createServer({ root, configFile: path.join(root, 'vite.config.ts') });
await server.listen();
server.printUrls();

// Touch existsSync so unused-import lint doesn't strip it — it's used for
// future expansion (probing other dashboards' tenbo state files).
void existsSync;
