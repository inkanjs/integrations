# @inkanjs/next

An [inkan](https://github.com/inkanjs/inkan) app inside a Next.js project: as App Router
route handlers, as a Pages Router API route, and as a typed client for Server Components.
Contracts, validation, problems, `/docs` and the inspector all come along.

```sh
npm install @vxnsin/inkan @inkanjs/next
```

The app keeps its routes under `/api`, and its docs, document and inspector too, so every
link on the docs page points where Next will route it:

```ts
// server/app.ts
import { inkan, routes, t } from "@vxnsin/inkan";

const teas = routes().get("/teas/:id", { params: t.object({ id: t.int() }) }, ({ params }) => findTea(params.id));

export const app = inkan({ docs: "/api/docs", openapi: "/api/openapi.json", inspector: "/api/_inkan" })
  .mount("/api", teas);
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

## Pages Router

`pages/api/[...path].ts` does the same for the Pages Router. Next reads the body itself
unless told not to, so the route says so; the contract then sees the bytes that came:

```ts
// pages/api/[...path].ts
import { app } from "@/server/app";
import { pages } from "@inkanjs/next";

export const config = { api: { bodyParser: false, externalResolver: true } };
export default pages(app);
```

Next only reads `config` when it is written out in the file, which is why it is not exported
from here. Left out, the route still works: the body Next parsed is written back for the app.

## Server Components

`direct(app)` is the typed client, talking to the app in the same process: no port, no
network, and still the same contracts, hooks and problems as a request from outside.

```tsx
// app/teas/[id]/page.tsx
import { cookies } from "next/headers";
import { direct } from "@inkanjs/next";
import { app } from "@/server/app";

export default async function Tea({ params }: { params: Promise<{ id: string }> }) {
  const api = direct(app, { headers: async () => ({ cookie: (await cookies()).toString() }) });
  const tea = await api.get("/api/teas/:id", { params: { id: Number((await params).id) } });
  if (!tea.ok) return <p>{tea.problem.detail}</p>;
  return <h1>{tea.data.name}</h1>; // typed from the contract
}
```

The paths are the app's, prefix and all. The type sees the routes of a chain and of `mount`;
those a plugin adds with `register` work, but are not typed.

All three run in CI inside a real Next.js: `next build`, `next start`, then requests.

`inkan check` and `inkan diff` work on `server/app.ts` as they do anywhere.
