# Recipes

Frameworks that hand their server routes a web `Request` and want a `Response` need no
package: that is what `app.fetch` does. Keep the app's routes, docs, document and inspector
under the prefix the framework routes to it, so every link on the docs page points there:

```ts
// server/app.ts, the same in every recipe
import { inkan, plugin, t } from "@vxnsin/inkan";

const api = plugin((app) => {
  app.get("/teas/:id", { params: t.object({ id: t.int() }) }, ({ params }) => findTea(params.id));
});

export const app = inkan({ docs: "/api/docs", openapi: "/api/openapi.json", inspector: "/api/_inkan" })
  .register(api, { prefix: "/api" });
```

The inspector only answers a loopback address. Pass `{ remote }` where the framework
knows who is asking, or leave it out and the inspector stays shut.

## Nuxt

```ts
// server/routes/api/[...path].ts
import { app } from "~/server/app";

export default defineEventHandler((event) => app.fetch(toWebRequest(event), { remote: getRequestIP(event) }));
```

## SvelteKit

```ts
// src/routes/api/[...path]/+server.ts
import { app } from "$lib/server/app";
import type { RequestHandler } from "./$types";

const handle: RequestHandler = ({ request, getClientAddress }) => app.fetch(request, { remote: getClientAddress() });
export const GET = handle, POST = handle, PUT = handle, PATCH = handle, DELETE = handle, OPTIONS = handle;
```

## Astro

```ts
// src/pages/api/[...path].ts   (with an adapter, in server or hybrid output)
import type { APIRoute } from "astro";
import { app } from "../../server/app";

export const prerender = false;
export const ALL: APIRoute = ({ request, clientAddress }) => app.fetch(request, { remote: clientAddress });
```

## Remix / React Router

```ts
// app/routes/api.$.ts
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { app } from "~/server/app";

export const loader = ({ request }: LoaderFunctionArgs) => app.fetch(request);
export const action = ({ request }: ActionFunctionArgs) => app.fetch(request);
```

## Next.js

Use [`@inkanjs/next`](../packages/next): one line for every method.
