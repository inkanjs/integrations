# @inkanjs/query

The typed [inkan](https://github.com/inkanjs/inkan) client, for
[TanStack Query](https://tanstack.com/query): data typed from the API's contracts, and every
failed answer an error that carries the problem document. One package for React, Vue,
Svelte and Solid, because it only builds the options all of them take.

```sh
npm install @inkanjs/query
```

```ts
import { client } from "@vxnsin/inkan/client";
import { queries } from "@inkanjs/query";
import type { app } from "../server/app";

const shop = client<typeof app>(location.origin);
const q = queries(shop);

// React: useQuery, Vue: useQuery, Svelte: createQuery, Solid: createQuery
const tea = useQuery(q.get("/teas/:id", { params: { id } }));
tea.data?.name; // typed from the contract

const add = useMutation(q.post("/teas"));
add.mutate({ body: { name: "Gyokuro" } }); // the input, checked against the contract

// every query of a path, for after a change
queryClient.invalidateQueries({ queryKey: q.key("/teas/:id") });
```

`q.get` keys a query by its path and input (`["/teas/:id", { params: { id: 1 } }]`), so
two components asking for the same tea share one request, and `q.key(path)` reaches all of
them. A path the API does not have, or a missing param, is a type error.

## Problems are errors

A failed answer (a 400 for bad input, a 404, a 500) is thrown as a `ProblemError`, so the
query shows it as its error instead of caching it as data:

```ts
import { isProblem, retry } from "@inkanjs/query";

if (isProblem(tea.error, "tea-not-found")) {
  tea.error.status;  // 404
  tea.error.problem; // the whole RFC 9457 document, `errors` and all
}

// tries again for a dropped connection, a 5xx or a 429, never for a 400 or a 404
new QueryClient({ defaultOptions: { queries: { retry: retry(3) } } });
```

## By hand

`query(key, call)` and `mutation(call)` take any call of the typed client, for a key of
your own or a call that does more than one request:

```ts
import { mutation, query } from "@inkanjs/query";

useQuery(query(["tea", id], () => shop.get("/teas/:id", { params: { id } })));
useMutation(mutation((tea: { name: string }) => shop.post("/teas", { body: tea })));
```

`unwrap(answer)` does the same for one answer anywhere else: its data, or a `ProblemError`.
This package needs no TanStack package itself; bring the adapter for your framework.

## Live data: events and WebSockets

A stream of server-sent events and a WebSocket are no queries: they do not answer once, and
there is nothing to refetch. `q.events` and `q.ws` make live sources of them, typed from the
route like everything else, and `@inkanjs/query/react` follows them in a component:

```tsx
import { useEvents, useSocket } from "@inkanjs/query/react";

// a GET that answers with t.events({ ... })
const feed = useEvents(q.events("/teas/:id/events", { params: { id } }));
feed.status;          // "connecting" | "open" | "closed" | "error" ("idle" while not enabled)
feed.last;            // the last event: feed.last?.event === "brewed" narrows feed.last.data
feed.byName.brewed;   // the latest data of each event, by name
feed.error;           // a stream that did not open: a ProblemError, isProblem(feed.error, "tea-not-found")

// an app.ws route: send takes its `message`, last is the last of its `send`
const room = useSocket(q.ws("/rooms/:room", { params: { room } }), { onMessage: (m) => log(m) });
room.send({ type: "say", text: "hello" }); // sent while opening, it goes once the socket is open
room.status; room.last; room.socket;       // the TypedSocket underneath: on, ready, raw
```

Both open when the component mounts, open again when the path or input changes, and close
when it unmounts. `enabled: false` keeps them closed. A stream that ends stays closed, and
one that fails is not opened again unless `retry` says so: `true`, a number of times, or a
function as for TanStack, so `retry: retry(3)` tries again after a dropped connection or a
503, not after a 404. `retryDelay` is 1 s, doubling, at most 30 s.

The hooks need `react` (18 or later); nothing else here does. For Vue, Svelte or Solid,
`follow(source, { onChange, onEvent, retry, signal })` and
`connect(source, { onChange, onMessage })` are what the hooks run: the same state, handed to
`onChange` after every change, for a ref or a store of your own.

### Events are not written to the cache

The hooks keep their state themselves and write nothing to the QueryClient: which query an
event belongs to is the app's to say, and `onEvent` says it in a line. A job's `status` and
`end` events carry the job as `GET /exports/:id` answers with it, so they can keep that
query fresh:

```ts
const queryClient = useQueryClient();
const job = q.get("/exports/:id", { params: { id } });
useEvents(q.events("/exports/:id/events", { params: { id } }), {
  onEvent: (e) => e.event !== "progress" && queryClient.setQueryData(job.queryKey, e.data),
});
```

## Recipe: following a job

An `app.job("/exports", ...)` on the server gives `POST /exports` to start one,
`GET /exports/:id/events` to follow it (`status`, then `progress`, then `end`) and
`GET /exports/:id/result` for what it made. Start it with a mutation, follow it while it
runs, and fetch the result once it is done:

```tsx
import { useMutation, useQuery } from "@tanstack/react-query";
import { queries } from "@inkanjs/query";
import { useEvents } from "@inkanjs/query/react";

const q = queries(api);

function Export() {
  const start = useMutation(q.post("/exports"));
  const id = start.data?.id; // the job, as the 202 answered with it

  const job = useEvents(q.events("/exports/:id/events", { params: { id: id! } }), { enabled: !!id });
  const state = job.byName.end?.state ?? job.byName.status?.state;

  const result = useQuery({
    ...q.get("/exports/:id/result", { params: { id: id! } }),
    enabled: state === "done",
  });

  if (!id) return <button onClick={() => start.mutate({ body: { rows: 1000 } })}>Export</button>;
  if (job.error) return <p>{job.error.message}</p>;
  if (state === "failed") return <p>{job.byName.end?.error?.detail}</p>;
  if (result.data) return <a href={result.data.url}>Download</a>;
  const p = job.byName.progress; // typed from the job's `progress` schema
  return <progress value={p?.done ?? 0} max={p?.total ?? 1} />;
}
```

The stream ends with `end`, so `job.status` turns `closed` by itself; nothing reconnects.
