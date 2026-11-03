import type { App } from "@vxnsin/inkan";

export type Served = {
  /** The port it listens on, also when it was asked for 0. */
  readonly port: number;
  /** Where it listens, as a URL: `http://localhost:3000`, or https with `tls`. */
  readonly url: string;
  /** Bun's server (`Bun.Server` in bun-types), for what this package does not cover: publish, subscribe, reload. */
  readonly server: unknown;
  /** Stops taking requests, closes the WebSockets with 1001, lets the open requests finish, then runs the app's onClose hooks. */
  close(): Promise<void>;
};

export type ServeOptions = {
  /** Default $PORT, then 3000. 0 takes any free port; `port` on the result says which. */
  port?: number;
  /** Default "0.0.0.0". */
  hostname?: string;
  /** HTTPS: handed to Bun.serve as its `tls` (`{ key: Bun.file("key.pem"), cert: Bun.file("cert.pem") }`). */
  tls?: Record<string, unknown>;
  /** On SIGINT and SIGTERM, close and exit; a second signal exits at once. Default: the app's `gracefulShutdown`. */
  signals?: boolean;
  /** How long close() waits for open requests and WebSockets, in ms. Default 10 000. */
  drain?: number;
};

/**
 * Serves an inkan app on Bun.serve. Resolves once it listens, after the app's plugins and onListen hooks.
 * HTTP goes through `app.fetch()`; WebSocket routes (`app.ws()`) run on Bun's websockets through
 * `app.upgrade()`; `close()` ends them with 1001. Throws when not running under Bun.
 */
export function serve(app: App, options?: ServeOptions): Promise<Served>;
