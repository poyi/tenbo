import type { IncomingMessage, ServerResponse } from 'node:http';

export function readBody<T = unknown>(req: IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (c: Buffer) => (buf += c));
    req.on('end', () => {
      try { resolve(JSON.parse(buf || '{}') as T); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

export function json(res: ServerResponse, body: unknown, status = 200): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

export function error(res: ServerResponse, status: number, message: string): void {
  json(res, { error: message }, status);
}

/** Wraps a handler so any thrown error becomes a 500 JSON response. */
export function withErrorHandling<T extends (...args: any[]) => any>(handler: T): T {
  return (async (...args: Parameters<T>) => {
    const [, res] = args as unknown as [IncomingMessage, ServerResponse];
    try {
      return await handler(...args);
    } catch (err) {
      error(res, 500, String(err));
    }
  }) as T;
}
