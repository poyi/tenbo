/**
 * Browser `window.fetch` requires its Window receiver in some runtimes. Keep the
 * default behind a wrapper so transports can safely retain and call it later.
 */
export const defaultFetch: typeof fetch = (input, init) => globalThis.fetch(input, init);
