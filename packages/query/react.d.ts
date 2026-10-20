import type { Jsonify } from "@vxnsin/inkan/client";
import type { AnyEvent, EventsState, FollowOptions, LiveEvents, LiveSocket, SocketState } from "./index.js";

export type UseEventsOptions<E extends AnyEvent> = FollowOptions<E> & {
  /** Whether to follow the stream at all; while false the status is `idle`. Default true. */
  enabled?: boolean;
};

/**
 * Follows an event stream (`q.events(path, input)`) while the component is mounted: opened
 * again when the key (path and input) changes, closed on unmount. Every event is typed by
 * its name: `last.event === "progress"` narrows `last.data`, `byName.progress` is the latest.
 */
export function useEvents<E extends AnyEvent>(source: LiveEvents<E>, options?: UseEventsOptions<E>): EventsState<E>;

export type UseSocketOptions<Out> = {
  /** Called with every message the server sends. */
  onMessage?: (message: Jsonify<Out>) => void;
  /** Whether to open the socket at all; while false the status is `idle`. Default true. */
  enabled?: boolean;
};

/**
 * Opens a WebSocket (`q.ws(path, input)`) while the component is mounted: opened again when
 * the key changes, closed on unmount. `send` takes what the route's `message` asks for, and
 * `last` is the last of what its `send` promises.
 */
export function useSocket<In, Out>(
  source: LiveSocket<In, Out>,
  options?: UseSocketOptions<Out>,
): SocketState<In, Out> & {
  /** Sends a message as JSON; one sent while the socket is still opening goes once it is open. */
  send(value: In): void;
};
