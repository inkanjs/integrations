// An inkan app as Next.js route handlers. Next hands every method of a route file a web
// Request and wants a Response back, which is exactly app.fetch: this only names the methods.
//
//   // app/api/[...path]/route.ts
//   import { app } from "@/server/app";
//   import { handlers } from "@inkanjs/next";
//   export const { GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS } = handlers(app);

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

/**
 * One handler for every method, all of them the app. Next does not tell a route handler
 * who is asking; `remote` does, for the inspector, which only answers a loopback address.
 * By default that is "127.0.0.1" while `next dev` runs and nobody in production.
 */
export function handlers(app, { remote = (_req) => (process.env.NODE_ENV === "development" ? "127.0.0.1" : undefined) } = {}) {
  const handle = (req) => app.fetch(req, { remote: remote(req) });
  return Object.fromEntries(METHODS.map((m) => [m, handle]));
}
