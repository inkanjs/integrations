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
import { mutation, query, ProblemError } from "@inkanjs/query";
import type { app } from "../server/app";

const shop = client<typeof app>(location.origin);

// React: useQuery, Vue: useQuery, Svelte: createQuery, Solid: createQuery
const tea = useQuery(query(["tea", id], () => shop.get("/teas/:id", { params: { id } })));
tea.data?.name; // typed from the contract

const add = useMutation(mutation((tea: { name: string }) => shop.post("/teas", { body: tea })));
```

A failed answer (a 400 for bad input, a 404, a 500) is thrown as a `ProblemError`, so the
query shows it as its error instead of caching it as data:

```ts
if (tea.error instanceof ProblemError) {
  tea.error.status;  // 404
  tea.error.type;    // "tea-not-found", the stable code to switch on
  tea.error.problem; // the whole RFC 9457 document, `errors` and all
}
```

`unwrap(answer)` does the same for one answer anywhere else: its data, or a `ProblemError`.
This package needs no TanStack package itself; bring the adapter for your framework.
