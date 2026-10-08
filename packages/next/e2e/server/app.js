import { inkan, plugin, t } from "@vxnsin/inkan";

const teas = plugin((p) => {
  p.get("/teas/:id", { params: t.object({ id: t.int() }), response: { 200: t.object({ id: t.int(), name: t.string() }) } }, ({ params }) => ({
    id: params.id,
    name: "Sencha",
    secret: "kept back",
  }));
  p.post("/teas", { body: t.object({ name: t.string().min(1) }), response: { 201: t.object({ name: t.string() }) } }, ({ body }) => body);
});

// the same routes twice: under /app-api for the App Router, under /api for the Pages Router
export const app = inkan({ log: false, docs: "/app-api/docs", openapi: "/app-api/openapi.json" })
  .register(teas, { prefix: "/app-api" })
  .register(teas, { prefix: "/api" });
