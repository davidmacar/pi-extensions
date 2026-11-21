# pi-extensions

A collection of Pi extensions, one directory per extension. This repository root holds the
Git history; each extension is self-contained inside its own folder with its own
`package.json`, tests, and README.

## Extensions

| Extension | What it does |
| --- | --- |
| [`pi-failover-router`](./pi-failover-router) | Registers **virtual models** that fail over across channels when the failure is owned by the provider rather than by the request. Reads the raw error message instead of Pi's category, so channel defects such as a 400 `invalid_request_error` on tool calls or a `499 stream read failed` still rotate the chain. |
| [`pi-telegram-notifier`](./pi-telegram-notifier) | Sends private Telegram notifications when Pi opens a UI prompt or settles awaiting user input. |

## Install an extension

Each extension's README carries its own install steps. The common shape is a single entry
in `~/.pi/agent/settings.json` pointing at the extension's entry file:

```json
{
  "extensions": ["/home/<you>/Apps/pi-extensions/pi-failover-router/index.js"]
}
```

Then `/reload`.

## Layout

```
pi-extensions/
├── README.md                 this file
├── pi-failover-router/       one extension
│   ├── index.js              entry file registered in settings.json
│   ├── lib/                  classification and config loading
│   ├── test/                 node --test suites
│   └── README.md             behaviour, configuration, install
└── patches/
    └── gentle-pi-channels/   the Channels card Gentle Shell cannot take as an extension
        ├── apply.mjs         re-applies the card to an installed gentle-pi (idempotent)
        ├── verify.mjs        renders the card outside Pi and checks what it paints
        └── files/lib/        the modules the patch adds
```

## Patches

Gentle Shell renders a closed list of rail sections, so a new card has no extension seam. A
change that belongs inside the package lives under `patches/<package>-<feature>/` — the durable
copy that puts it back after an upgrade, with its own `apply.mjs` and `verify.mjs`.

## Development

Run a given extension's suite from its own directory; every extension here uses the
built-in Node test runner and no dependencies:

```bash
cd pi-failover-router && npm test
```

### A reload does not reload the code

`/reload` re-creates the extension instances but not the modules they come from. Both
`pi-failover-router/package.json` files here declare `"type": "module"`, so the loader hands
the files to Node's native ESM loader, and Node caches a module by URL for the life of the
process:

```js
// two imports of the same URL, file edited in between
const a = await import("file:///x/mod.js"); // v = 1
const b = await import("file:///x/mod.js"); // v = 1  <- stale
```

Measured 2026-11-17 with Pi 1.5.2: a session that had reloaded kept executing pre-fix code,
including log strings that no longer exist on disk. The decision log then read like a failed
fix rather than a stale process.

**So: restart `pi` to load changed extension code**, and check the build stamp it announces
before judging a fix:

```bash
grep 'build .* loaded' ~/.pi/agent/failover-router.log | tail -1
```
