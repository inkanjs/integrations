# Changelog

## 0.2.0

- Vite's start shows where the API docs and the inspector are, under its own links.
- `vite preview` serves the API next to the built frontend; `preview` names another file to
  load it from, or turns it off.
- A reload is a restart for the app: the one that is replaced gets its onClose hooks, the
  fresh one its onListen hooks, so a pool or a timer does not pile up with every save.
- An app that does not load shows in Vite's error overlay in the browser.

## 0.1.0

- The app inside `vite dev`, on Vite's port, under a prefix, reloaded on every save.
