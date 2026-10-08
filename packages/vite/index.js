// The inkan API inside the Vite dev server. Requests under the prefix go to the app, the
// rest to Vite as before: one port for the frontend and the API, so no CORS and no proxy.
// Vite loads the app through its own module graph, so a save to the app or anything it
// imports gives the next request a fresh app. `vite preview` serves it too, next to the
// built frontend. In production the app runs as itself, with app.listen(), app.fetch or an
// adapter.
//
//   // vite.config.ts
//   import inkan from "@inkanjs/vite";
//   export default { plugins: [inkan({ entry: "src/server/app.ts" })] };

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * @param {{ entry?: string; prefix?: string | string[]; preview?: string | false; banner?: boolean }} [options]
 *   entry: the file that exports the app, `export const app` or `export default`.
 *   prefix: the paths that belong to the API. Default `/api`.
 *   preview: the file `vite preview` loads the app from, or false. Default: the entry.
 *   banner: the docs and the inspector under Vite's own links. Default true.
 */
export default function inkan({ entry = "src/server/app.ts", prefix = "/api", preview = entry, banner = true } = {}) {
  const prefixes = [prefix].flat();
  const ours = (url = "") => prefixes.some((p) => url === p || url.startsWith(p + "/") || url.startsWith(p + "?"));

  // One app at a time, with its lifecycle: a fresh app after a save gets its onListen hooks,
  // the one it replaces its onClose hooks, as if the server had been restarted.
  function lifecycle() {
    let current;
    let ready;
    return {
      use(app) {
        if (app !== current) {
          const before = current;
          current = app;
          ready = (async () => {
            await before?.stopped();
            await app.ready();
            await app.started();
          })();
        }
        return ready;
      },
      async close() {
        const app = current;
        current = undefined;
        await ready?.catch(() => {});
        await app?.stopped();
      },
    };
  }

  function appOf(mod, file) {
    const app = mod.app ?? mod.default;
    if (!app || typeof app.listener !== "function") throw new Error(`${file} has to export the app: export const app = inkan(…)`);
    return app;
  }

  function serveWith(server, load, life, onError) {
    process.env.INKAN_NO_LISTEN = "1"; // an app.listen() in the entry stays quiet: Vite serves it
    server.middlewares.use(async (req, res, next) => {
      if (!ours(req.url)) return next();
      let app;
      try {
        app = await load();
        await life.use(app);
      } catch (err) {
        onError?.(err);
        return next(err);
      }
      app.listener(req, res);
    });
    server.httpServer?.once("close", () => void life.close());
  }

  async function links(server, load) {
    const base = server.resolvedUrls?.local[0]?.replace(/\/$/, "");
    if (!base) return;
    const { options } = await load();
    const lines = [];
    if (options.docs) lines.push(["API docs", options.docs]);
    if (options.inspector) lines.push(["Inspector", options.inspector]);
    for (const [name, path] of lines) server.config.logger.info(`  \x1b[32m➜\x1b[0m  \x1b[1m${name}:\x1b[0m ${" ".repeat(9 - name.length)}\x1b[36m${base}${path}\x1b[0m`);
  }

  function withLinks(server, load) {
    if (!banner) return;
    const print = server.printUrls.bind(server);
    server.printUrls = () => {
      print();
      links(server, load).catch((err) => server.config.logger.error(`  inkan: ${err instanceof Error ? err.message : err}`));
    };
  }

  return {
    name: "inkan",
    apply: "serve",

    configureServer(server) {
      const load = async () => appOf(await server.ssrLoadModule(entry), entry); // the same app until something it imports changes
      serveWith(server, load, lifecycle(), (err) => {
        if (!(err instanceof Error)) return;
        server.ssrFixStacktrace(err);
        // the frontend shows it too: a broken API is as loud as a broken component
        server.ws.send({ type: "error", err: { message: err.message, stack: err.stack ?? "", plugin: "inkan", id: entry } });
      });
      withLinks(server, load);
    },

    configurePreviewServer(server) {
      if (preview === false) return;
      // no Vite module graph here: Node loads the file itself, TypeScript and all (Node 22.18+)
      let loaded;
      const load = () => (loaded ??= import(pathToFileURL(resolve(server.config.root, preview)).href).then((mod) => appOf(mod, preview)));
      serveWith(server, load, lifecycle());
      withLinks(server, load);
    },
  };
}
