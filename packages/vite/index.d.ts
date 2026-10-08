import type { Plugin } from "vite";

export type InkanViteOptions = {
  /** The file that exports the app, as `export const app` or `export default`. Default `src/server/app.ts`. */
  entry?: string;
  /** The paths that belong to the API; everything else stays Vite's. Default `/api`. */
  prefix?: string | string[];
  /**
   * The file `vite preview` loads the app from, with Node's own import, or false to leave
   * the API out of the preview. Default: the entry.
   */
  preview?: string | false;
  /** The links to the docs and the inspector, under Vite's own when it starts. Default true. */
  banner?: boolean;
};

/**
 * Serves the inkan app inside `vite dev` and `vite preview`, on Vite's port, reloaded when
 * its files change.
 */
export default function inkan(options?: InkanViteOptions): Plugin;
