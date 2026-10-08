// An inkan app inside a Next.js project. The App Router hands every method of a route file
// a web Request and wants a Response back, which is exactly app.fetch: handlers() only
// names the methods. The Pages Router hands an API route Node's own request and response,
// which is what app.listener takes. And direct() is the typed client for Server
// Components and Server Actions, which calls the app without going over the network.
//
//   // app/api/[...path]/route.ts
//   import { app } from "@/server/app";
//   import { handlers } from "@inkanjs/next";
//   export const { GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS } = handlers(app);

import { client } from "@vxnsin/inkan/client";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
const development = () => (process.env.NODE_ENV === "development" ? "127.0.0.1" : undefined);

/**
 * One handler for every method, all of them the app. Next does not tell a route handler
 * who is asking; `remote` does, for the inspector, which only answers a loopback address.
 * By default that is "127.0.0.1" while `next dev` runs and nobody in production.
 */
export function handlers(app, { remote = development } = {}) {
  const handle = (req) => app.fetch(req, { remote: remote(req) });
  return Object.fromEntries(METHODS.map((m) => [m, handle]));
}

/**
 * The app as a Pages Router API route, `export default pages(app)` in
 * `pages/api/[...path].ts`. Next's own body parser should be off for it (see the README);
 * when it is not, the body it parsed is written back, so the contract still sees it.
 */
export function pages(app) {
  return async (req, res) => {
    if (req.body === undefined) return app.listener(req, res);
    const headers = { ...req.headers };
    delete headers["content-length"];
    delete headers["transfer-encoding"];
    const answer = await app.exchange({ method: req.method, url: req.url, headers, body: reencode(req.body, headers["content-type"]), remote: req.socket?.remoteAddress });
    res.writeHead(answer.status, answer.headers);
    if (!answer.stream) res.end(req.method === "HEAD" ? undefined : answer.body);
    else {
      req.on("close", () => answer.abort?.abort());
      for await (const chunk of answer.stream) if (!res.write(chunk)) await new Promise((r) => res.once("drain", r));
      res.end();
    }
    answer.done?.();
  };
}

// Next's body parser leaves JSON as a value, a form as an object and text as a string
function reencode(body, type = "") {
  if (body === "" || body === null) return undefined;
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === "string") return Buffer.from(body);
  if (/application\/x-www-form-urlencoded/.test(type)) return Buffer.from(new URLSearchParams(body).toString());
  return Buffer.from(JSON.stringify(body));
}

/**
 * The typed client, talking to the app in the same process: for Server Components, Server
 * Actions and route handlers of your own. No port and no network, but the same contracts,
 * hooks and problems as a request from outside.
 */
export function direct(app, { headers } = {}) {
  return client("http://inkan.internal", { headers, fetch: (url, init) => app.fetch(new Request(url, init)) });
}
