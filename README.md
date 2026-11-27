# ai-extensions

Extensions for Pi and OpenCode, with shared logic where the two runtimes have equivalent behavior.

| Component | Pi | OpenCode |
| --- | --- | --- |
| [Failover Router](./failover-router) | [Native extension](./failover-router/pi) | [Local provider gateway](./failover-router/opencode) |
| [Telegram notifier](./pi-telegram-notifier) | Native extension | Not included |
| [Channels card](./patches/gentle-pi-channels) | Gentle Shell patch | Not included |

## Failover Router layout

- [`failover-router/pi/`](./failover-router/pi): native virtual models, session hooks, and Pi documentation. Pi does not connect to the gateway.
- [`failover-router/opencode/`](./failover-router/opencode): loopback gateway, OpenCode examples, and integration tests. OpenCode does not load the Pi extension.
- [`failover-router/common/`](./failover-router/common): routing rules and recovery, reasoning levels, price and speed caches.

## Installation

See the [installation guide](./failover-router/opencode/INSTALL.md) for the Pi router, OpenCode provider gateway, and Pi-only Telegram notifier.

### Pi installation after the rename

Set the extension entry in `~/.pi/agent/settings.json` to:

```json
{
  "extensions": ["/home/<you>/Apps/ai-extensions/failover-router/pi/index.js"]
}
```

Restart Pi after editing extension code: `/reload` recreates extension instances, but the Node ESM loader can keep the old module. The router's decision log announces a build hash on load. Pi router configuration and caches still live in their existing locations. Don't register the new and legacy entrypoints together: `pi-failover-router/index.js` is a compatibility re-export only. If you move an existing checkout, update other absolute extension paths (such as the notifier) or keep a symlink from the old checkout path to the new one.

## Tests

```sh
npm --prefix failover-router test
npm --prefix pi-telegram-notifier test
node patches/gentle-pi-channels/verify.mjs
```

The OpenCode runtime smoke is separate; see the [gateway guide](./failover-router/opencode). The gateway also writes private per-attempt cost estimates to its state directory; missing usage or tariff data is marked unknown/partial.
