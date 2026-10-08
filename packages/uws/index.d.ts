import type { App } from "@vxnsin/inkan";

export type Served = {
  /** The port it listens on, also when it was asked for 0. */
  readonly port: number;
  /** Where it listens, as a URL: `http://localhost:3000`, or https with `tls`. */
  readonly url: string;
  /** Stops taking requests, lets the open ones finish (ends the event streams), then runs the app's onClose hooks. */
  close(): Promise<void>;
};

export type ServeOptions = {
  /** Default $PORT, then 3000. 0 takes any free port; `port` on the result says which. */
  port?: number;
  /** Default "0.0.0.0". */
  host?: string;
  /** HTTPS: the paths of the key and the certificate, in PEM. */
  tls?: { key: string; cert: string; passphrase?: string };
  /** On SIGINT and SIGTERM, close and exit; a second signal exits at once. Default: the app's `gracefulShutdown`. */
  signals?: boolean;
  /** How long close() waits for open requests, in ms. Default 10 000. */
  drain?: number;
};

/**
 * Serves an inkan app on uWebSockets.js. Resolves once it listens, after the app's plugins and onListen hooks.
 * Bodies are held to each route's limit; a `t.stream()` route gets its body
 * unread.
 */
export function serve(app: App, options?: ServeOptions): Promise<Served>;
