# pi-extensions

A collection of Pi extensions, one directory per extension. This repository root holds the
Git history; each extension is self-contained inside its own folder with its own
`package.json`, tests, and README.

## Extensions

| Extension | What it does |
| --- | --- |
| [`pi-failover-router`](./pi-failover-router) | Registers **virtual models** that fail over across channels when the failure is owned by the provider rather than by the request. Reads the raw error message instead of Pi's category, so channel defects such as a 400 `invalid_request_error` on tool calls or a `499 stream read failed` still rotate the chain. |

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
└── pi-failover-router/       one extension
    ├── index.js              entry file registered in settings.json
    ├── lib/                  classification and config loading
    ├── test/                 node --test suites
    └── README.md             behaviour, configuration, install
```

## Development

Run a given extension's suite from its own directory; every extension here uses the
built-in Node test runner and no dependencies:

```bash
cd pi-failover-router && npm test
```
