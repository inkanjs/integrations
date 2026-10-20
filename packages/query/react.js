// Live data for React: follow() and connect() as hooks. The source is opened again when its
// key (path and input) changes, and closed when the component unmounts.
//
//   const job = useEvents(q.events("/exports/:id/events", { params: { id } }));
//   job.byName.progress; // typed from the route's events
//
//   const room = useSocket(q.ws("/rooms/:room", { params: { room } }));
//   room.send({ type: "say", text: "hello" });
import { useCallback, useEffect, useRef, useState } from "react";
import { connect, follow } from "./index.js";

const idleEvents = { last: undefined, byName: {}, status: "idle", error: undefined };
const idleSocket = { last: undefined, status: "idle", error: undefined, socket: undefined };

/** The latest options, for callbacks that should not open the source again when they change. */
function useLatest(value) {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  });
  return ref;
}

/** Follows an event stream while mounted and `enabled`: the last event, the latest of each, the status. */
export function useEvents(source, options = {}) {
  const enabled = options.enabled ?? true;
  const latest = useLatest(options);
  const [state, setState] = useState(enabled ? { ...idleEvents, status: "connecting" } : idleEvents);
  const id = JSON.stringify(source.key);
  useEffect(() => {
    if (!enabled) return setState(idleEvents);
    const { retry, retryDelay } = latest.current;
    return follow(source, { retry, retryDelay, onEvent: (event) => latest.current.onEvent?.(event), onChange: setState });
    // the key is what tells one source from another; a new object for the same one opens nothing
  }, [id, enabled]); // eslint-disable-line react-hooks/exhaustive-deps
  return state;
}

/** Opens a WebSocket while mounted and `enabled`: `send`, the last message, the status, the socket. */
export function useSocket(source, options = {}) {
  const enabled = options.enabled ?? true;
  const latest = useLatest(options);
  const [state, setState] = useState(enabled ? { ...idleSocket, status: "connecting" } : idleSocket);
  const connection = useRef(undefined);
  const id = JSON.stringify(source.key);
  useEffect(() => {
    if (!enabled) return setState(idleSocket);
    const open = connect(source, { onMessage: (message) => latest.current.onMessage?.(message), onChange: setState });
    connection.current = open;
    return () => {
      open.close();
      if (connection.current === open) connection.current = undefined;
    };
  }, [id, enabled]); // eslint-disable-line react-hooks/exhaustive-deps
  const send = useCallback((value) => connection.current?.send(value), []);
  return { ...state, send };
}
