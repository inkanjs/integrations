import type { Plugin } from "vite";

export type InkanViteOptions = {
  /** The file that exports the app, as `export const app` or `export default`. Default `src/server/app.ts`. */
  entry?: string;
  /** The paths that belong to the API; everything else stays Vite's. Default `/api`. */
  prefix?: string | string[];
};

/** Serves the inkan app inside `vite dev`, on Vite's port, reloaded when its files change. */
export default function inkan(options?: InkanViteOptions): Plugin;
