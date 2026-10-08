import { test } from "node:test";
import assert from "node:assert/strict";
import { QueryClient, MutationObserver } from "@tanstack/query-core";
import { inkan, problem, t } from "@vxnsin/inkan";
import { client } from "@vxnsin/inkan/client";
import { mutation, ProblemError, query } from "./index.js";

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
