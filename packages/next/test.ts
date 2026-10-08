import { test } from "node:test";
import assert from "node:assert/strict";
import { inkan, plugin, t } from "@vxnsin/inkan";
import { handlers } from "./index.js";

// The app as it would sit behind app/api/[...path]/route.ts: everything under /api.
const api = plugin((p) => {
  p.get("/teas/:id", { params: t.object({ id: t.int() }), response: { 200: t.object({ id: t.int(), name: t.string() }) } }, ({ params }) => ({
    id: params.id,
    name: "Sencha",
    secret: "kept back",
  }));
  p.post("/teas", { body: t.object({ name: t.string().min(1) }), response: { 201: t.object({ name: t.string() }) } }, ({ body }) => body);
});
const app = inkan({ log: false, docs: "/api/docs", openapi: "/api/openapi.json", inspector: "/api/_inkan" }).register(api, { prefix: "/api" });
const route = handlers(app);
const req = (path: string, init?: RequestInit) => new Request(`http://localhost:3000${path}`, init);

test("every method is a route handler, and they are the app", async () => {
  for (const m of ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const) assert.equal(typeof route[m], "function");
  const r = await route.GET(req("/api/teas/7"));
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { id: 7, name: "Sencha" });
});

test("bodies are checked, problems are problems", async () => {
  const ok = await route.POST(req("/api/teas", { method: "POST", headers: { "content-type": "application/json" }, body: '{"name":"Mio"}' }));
  assert.equal(ok.status, 201);
  const bad = await route.POST(req("/api/teas", { method: "POST", headers: { "content-type": "application/json" }, body: '{"name":""}' }));
  assert.equal(bad.status, 400);
  assert.equal(bad.headers.get("content-type"), "application/problem+json");
});

test("the docs and the document live under /api too", async () => {
  assert.equal((await route.GET(req("/api/docs"))).status, 200);
  const doc = (await (await route.GET(req("/api/openapi.json"))).json()) as { paths: Record<string, unknown> };
  assert.ok(doc.paths["/api/teas/{id}"]);
});

test("the inspector answers under next dev, and stays shut in production", async () => {
  const dev = inkan({ log: false, dev: true, inspector: "/api/_inkan" });
  const env = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = "development";
    assert.equal((await handlers(dev).GET(req("/api/_inkan"))).status, 200);
    process.env.NODE_ENV = "production";
    assert.equal((await handlers(dev).GET(req("/api/_inkan"))).status, 404);
  } finally {
    process.env.NODE_ENV = env;
  }
});
