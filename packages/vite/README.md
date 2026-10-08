# @inkanjs/vite

Your [inkan](https://github.com/inkanjs/inkan) API inside the Vite dev server: the frontend
and the API on one port, no proxy and no CORS, and the API reloaded on every save. Works
for every Vite project: Vue, React, Svelte, Solid, plain TypeScript.

```sh
npm install @vxnsin/inkan
npm install -D @inkanjs/vite
```

```ts
// vite.config.ts
import { defineConfig } from "vite";
import inkan from "@inkanjs/vite";

export default defineConfig({
  plugins: [inkan({ entry: "src/server/app.ts" })], // prefix: "/api" by default
});
```

The app keeps its routes, and its docs, document and inspector, under the prefix:

```ts
// src/server/app.ts
import { inkan, routes } from "@vxnsin/inkan";

const teas = routes().get("/teas", () => listTeas());

export const app = inkan({ docs: "/api/docs", openapi: "/api/openapi.json", inspector: "/api/_inkan" })
  .mount("/api", teas);

app.listen(); // for production; under Vite it stays quiet
```

`npm run dev` and the frontend calls `fetch("/api/teas")` on its own origin. Vite's start
says where the rest is:

```
  ➜  Local:   http://localhost:5173/
  ➜  API docs:  http://localhost:5173/api/docs
  ➜  Inspector: http://localhost:5173/api/_inkan
```

Change anything the app imports and the next request runs on the new code. The app that is
replaced gets its onClose hooks and the fresh one its onListen hooks, as with a restart, so
a database pool or a timer does not pile up with every save. An app that does not load (a
syntax error, a plugin that fails) shows in Vite's overlay in the browser, not only in the
terminal.

## vite preview

`vite preview` serves the API next to the built frontend, so the build is tried as a whole.
Node loads the entry itself there, without Vite's module graph (TypeScript works, Node
22.18+ strips the types). For a server you build on its own, point `preview` at its output:

```ts
inkan({ entry: "src/server/app.ts", preview: "dist-server/app.js" }); // or preview: false
```

| option | default | |
| --- | --- | --- |
| `entry` | `"src/server/app.ts"` | the file that exports the app, `export const app` or `export default` |
| `prefix` | `"/api"` | the paths that belong to the API, one or a list |
| `preview` | the entry | the file `vite preview` loads, or `false` |
| `banner` | `true` | the docs and inspector links when Vite starts |

In production the app runs as itself: `app.listen()`, `app.fetch` on Bun, Deno or
serverless, or an adapter.

Pair it with the typed client and every call in the frontend is checked against the API
by the compiler (it sees the routes of a chain and of `mount`):

```ts
import { client } from "@vxnsin/inkan/client";
import type { app } from "../server/app";

const api = client<typeof app>(location.origin);
```
