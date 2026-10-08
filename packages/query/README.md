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
