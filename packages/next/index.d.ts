import type { App } from "@vxnsin/inkan";

type Handler = (request: Request) => Promise<Response>;

export type Handlers = { GET: Handler; POST: Handler; PUT: Handler; PATCH: Handler; DELETE: Handler; HEAD: Handler; OPTIONS: Handler };

/**
 * Next.js route handlers for an inkan app. `remote` says who is asking, for the inspector,
 * which only answers a loopback address; by default "127.0.0.1" under `next dev`.
 */
export function handlers(app: App, options?: { remote?: (request: Request) => string | undefined }): Handlers;
