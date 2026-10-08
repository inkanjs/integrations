import type { IncomingMessage, ServerResponse } from "node:http";
import type { App, Routes } from "@vxnsin/inkan";
import type { Client, ClientOptions } from "@vxnsin/inkan/client";

type Handler = (request: Request) => Promise<Response>;

export type Handlers = { GET: Handler; POST: Handler; PUT: Handler; PATCH: Handler; DELETE: Handler; HEAD: Handler; OPTIONS: Handler };

/**
 * Next.js route handlers for an inkan app. `remote` says who is asking, for the inspector,
 * which only answers a loopback address; by default "127.0.0.1" under `next dev`.
 */
export function handlers(app: App, options?: { remote?: (request: Request) => string | undefined }): Handlers;

/**
 * The app as a Pages Router API route: `export default pages(app)` in `pages/api/[...path].ts`,
 * with `export const config = { api: { bodyParser: false, externalResolver: true } }` next to it.
 */
export function pages(app: App): (req: IncomingMessage & { body?: unknown }, res: ServerResponse) => Promise<void>;

/**
 * The typed client, talking to the app in the same process: for Server Components and Server
 * Actions. No port and no network, the same contracts, hooks and problems.
 */
export function direct<A extends Routes<any>>(app: A, options?: { headers?: ClientOptions["headers"] }): Client<A>;
