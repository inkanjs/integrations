import { test } from "node:test";
import assert from "node:assert/strict";
import { QueryClient, MutationObserver } from "@tanstack/query-core";
import { inkan, problem, t } from "@vxnsin/inkan";
import { client } from "@vxnsin/inkan/client";
import { isProblem, mutation, ProblemError, queries, query, retry } from "./index.js";

const Tea = t.object({ id: t.int(), name: t.string(), brewed: t.date() });
const teas = [{ id: 1, name: "Sencha", brewed: new Date("2026-01-02T03:04:05.000Z") }];
const app = inkan({ log: false })
  .get("/teas/:id", { params: t.object({ id: t.int() }), response: { 200: Tea, 404: t.problem() } }, ({ params }) => {
    const tea = teas.find((x) => x.id === params.id);
    if (!tea) throw problem(404, "tea-not-found", `There is no tea ${params.id}`);
    return tea;
  })
  .post("/teas", { body: t.object({ name: t.string().min(1) }), response: { 201: Tea } }, ({ body }) => {
    const tea = { id: teas.length + 1, name: body.name, brewed: new Date() };
    teas.push(tea);
    return tea;
  });

// the typed client, talking to the app through app.fetch: no port needed
const shop = client<typeof app>("http://shop.test", { fetch: (url, init) => app.fetch(new Request(url, init)) });

test("a query has the contract's data, typed, as JSON brings it", async () => {
  const qc = new QueryClient();
  const tea = await qc.fetchQuery(query(["tea", 1], () => shop.get("/teas/:id", { params: { id: 1 } })));
  assert.deepEqual(tea, { id: 1, name: "Sencha", brewed: "2026-01-02T03:04:05.000Z" });
  const name: string = tea.name;
  const brewed: string = tea.brewed; // a Date arrives as a string, and the type says so
  assert.ok(name && brewed);
  // @ts-expect-error the contract has no price
  void tea.price;
});

test("a failed answer is the query's error, with the problem document", async () => {
  const qc = new QueryClient();
  await assert.rejects(
    qc.fetchQuery({ ...query(["tea", 99], () => shop.get("/teas/:id", { params: { id: 99 } })), retry: false }),
    (err: unknown) => err instanceof ProblemError && err.status === 404 && err.type === "tea-not-found" && /no tea 99/.test(err.message),
  );
});

test("a mutation takes typed variables and throws problems too", async () => {
  const qc = new QueryClient();
  const add = new MutationObserver(qc, mutation((tea: { name: string }) => shop.post("/teas", { body: tea })));
  const made = await add.mutate({ name: "Bancha" });
  assert.equal(made.name, "Bancha");
  await assert.rejects(add.mutate({ name: "" }), (err: unknown) => err instanceof ProblemError && err.status === 400 && err.type === "validation");
});

test("queries() keys and types everything from the path", async () => {
  const qc = new QueryClient();
  const q = queries(shop);
  const options = q.get("/teas/:id", { params: { id: 1 } });
  assert.deepEqual(options.queryKey, ["/teas/:id", { params: { id: 1 } }]);
  const tea = await qc.fetchQuery(options);
  const name: string = tea.name;
  assert.equal(name, "Sencha");
  // @ts-expect-error the contract has no price
  void tea.price;
  // @ts-expect-error the path needs its params
  void (() => q.get("/teas/:id"));
  // @ts-expect-error there is no such GET
  void (() => q.get("/coffee"));

  const add = new MutationObserver(qc, q.post("/teas"));
  const made = await add.mutate({ body: { name: "Gyokuro" } });
  assert.equal(made.name, "Gyokuro");
  // @ts-expect-error the body needs a name
  void (() => add.mutate({ body: {} }));

  await qc.invalidateQueries({ queryKey: q.key("/teas/:id") });
  assert.equal(qc.getQueryState(options.queryKey)?.isInvalidated, true, "the path's key reaches every query of it");
});

test("isProblem and retry tell problems that pass from those that stay", async () => {
  const notFound = new ProblemError({ status: 404, problem: { type: "tea-not-found", title: "Not Found", status: 404 } });
  const down = new ProblemError({ status: 503, problem: { type: "unavailable", title: "Service Unavailable", status: 503 } });
  assert.ok(isProblem(notFound) && isProblem(notFound, "tea-not-found"));
  assert.ok(!isProblem(notFound, "validation") && !isProblem(new Error("x")));
  const again = retry(2);
  assert.equal(again(0, notFound), false, "a 404 stays a 404");
  assert.equal(again(0, down), true);
  assert.equal(again(0, new TypeError("fetch failed")), true);
  assert.equal(again(0, new ProblemError({ status: 429, problem: {} })), true);
  assert.equal(again(2, down), false, "and only so often");
});
