// The inkan API inside the Vite dev server. Requests under the prefix go to the app, the
// rest to Vite as before: one port for the frontend and the API, so no CORS and no proxy.
// Vite loads the app through its own module graph, so a save to the app or anything it
// imports gives the next request a fresh app. Only for `vite dev`: in production the app
// runs as itself, with app.listen(), app.fetch or an adapter.
//
//   // vite.config.ts
//   import inkan from "@inkanjs/vite";
//   export default { plugins: [inkan({ entry: "src/server/app.ts" })] };

/**
 * @param {{ entry?: string; prefix?: string | string[] }} [options]
 *   entry: the file that exports the app, `export const app` or `export default`.
 *   prefix: the paths that belong to the API. Default `/api`.
 */
export default function inkan({ entry = "src/server/app.ts", prefix = "/api" } = {}) {
  const prefixes = [prefix].flat();
  const ours = (url = "") => prefixes.some((p) => url === p || url.startsWith(p + "/") || url.startsWith(p + "?"));
  return {
    name: "inkan",
    apply: "serve",
    configureServer(server) {
      process.env.INKAN_NO_LISTEN = "1"; // an app.listen() in the entry stays quiet: Vite serves it
      server.middlewares.use(async (req, res, next) => {
        if (!ours(req.url)) return next();
        try {
          const mod = await server.ssrLoadModule(entry); // the same app until something it imports changes
          const app = mod.app ?? mod.default;
          if (!app || typeof app.listener !== "function") throw new Error(`${entry} has to export the app: export const app = inkan(…)`);
          await app.ready();
          app.listener(req, res);
        } catch (err) {
          if (err instanceof Error) server.ssrFixStacktrace(err);
          next(err);
        }
      });
    },
  };
}
