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
import { inkan, plugin, t } from "@vxnsin/inkan";

const api = plugin((app) => {
  app.get("/teas", () => listTeas());
});

export const app = inkan({ docs: "/api/docs", openapi: "/api/openapi.json", inspector: "/api/_inkan" })
  .register(api, { prefix: "/api" });

app.listen(); // for production; under Vite it stays quiet
```

`npm run dev` and the frontend calls `fetch("/api/teas")` on its own origin, `/api/docs` is
the docs page and `/api/_inkan` the inspector. Change anything the app imports and the next
request runs on the new code. An error in the app shows in Vite's overlay.

This is for `vite dev`. In production the app runs as itself: `app.listen()`, `app.fetch`
on Bun, Deno or serverless, or an adapter.

Pair it with the typed client and every call in the frontend is checked against the API
by the compiler:

```ts
import { client } from "@vxnsin/inkan/client";
import type { app } from "../server/app";

const api = client<typeof app>(location.origin);
```
