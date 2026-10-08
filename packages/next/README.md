# @inkanjs/next

An [inkan](https://github.com/inkanjs/inkan) app inside a Next.js project, as route
handlers. Contracts, validation, problems, `/docs` and the inspector all come along.

```sh
npm install @vxnsin/inkan @inkanjs/next
```

The app keeps its routes under `/api`, and its docs, document and inspector too, so every
link on the docs page points where Next will route it:

```ts
// server/app.ts
import { inkan, plugin, t } from "@vxnsin/inkan";

const api = plugin((app) => {
  app.get("/teas/:id", { params: t.object({ id: t.int() }) }, ({ params }) => findTea(params.id));
});

export const app = inkan({ docs: "/api/docs", openapi: "/api/openapi.json", inspector: "/api/_inkan" })
  .register(api, { prefix: "/api" });
```

One catch-all route hands every method to it:

```ts
// app/api/[...path]/route.ts
import { app } from "@/server/app";
import { handlers } from "@inkanjs/next";

export const { GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS } = handlers(app);
```

`/api/docs` is the docs page, `/api/_inkan` the inspector while `next dev` runs. Next does
not tell a route handler who is asking, so the inspector, which only answers a loopback
address, gets `127.0.0.1` in development and nothing in production. Pass
`handlers(app, { remote: (req) => … })` to decide yourself.

`inkan check` and `inkan diff` work on `server/app.ts` as they do anywhere.
