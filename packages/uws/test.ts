// The same requests every way of serving inkan has to answer alike, on uWebSockets.js.
// uWebSockets.js is installed on purpose, from GitHub (see README); without it this test is
// skipped, unless REQUIRE_UWS says it has to run, as it does in CI.
import { test } from "node:test";
import { createRequire } from "node:module";
import { conformance } from "./conformance.ts";

let installed = true;
try {
  createRequire(import.meta.url).resolve("uWebSockets.js");
} catch {
  installed = false;
}

if (installed) {
  const { serve } = await import("./index.js");
  conformance("uWebSockets.js (@inkanjs/uws)", async (app) => {
    const server = await serve(app, { port: 0, host: "127.0.0.1" });
    return { url: `http://127.0.0.1:${server.port}`, close: () => server.close() };
  });
} else if (process.env.REQUIRE_UWS) {
  throw new Error("uWebSockets.js is not installed, and REQUIRE_UWS says this test has to run");
} else {
  test("uWebSockets.js (@inkanjs/uws)", { skip: "uWebSockets.js is not installed: see packages/uws/README.md" }, () => {});
}
