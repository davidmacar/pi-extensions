# Install the failover extensions

This guide installs the existing Pi extension and the OpenCode gateway. The two runtimes do not load the same entrypoint: Pi loads its native adapter, while OpenCode connects to the local gateway.

## Prerequisites

- Node.js `>=22.19.0`.
- This checkout at `/home/<you>/Apps/ai-extensions`.
- OpenCode with the OpenAI-compatible provider packages available. The verified local release was `v2.0.32`.
- A SubRouter relay key only if you want shared live tariffs: keep it in `SUBROUTER_API_KEY`; never commit it or put it in either JSON configuration.

## Pi extension

1. Add this path to the existing `extensions` array in `~/.pi/agent/settings.json`:

   ```json
   "/home/<you>/Apps/ai-extensions/failover-router/pi/index.js"
   ```

2. Keep physical provider credentials in Pi's private `~/.pi/agent/models.json` and the router profile in `~/.pi/agent/failover-router.json` (or set `PI_FAILOVER_ROUTER_CONFIG`). Merge the [model examples](../pi/models-sol.example.json) and adapt the [router profile examples](../failover-router.example.json) without replacing existing settings.
3. If using shared SubRouter tariffs, export `SUBROUTER_API_KEY` before launching Pi. Optionally set `SUBROUTER_PRICE_CACHE_DIR` to a shared absolute state path used by the gateway.
4. Restart Pi after code changes. `/reload` recreates instances but does not necessarily reload cached ESM modules.
5. Confirm the startup log and select the virtual model with `/model`, for example `router/sol-barato`.

Pi continues to use the native route, retry and session-cost behavior. It does not pass through the OpenCode gateway. The old `/home/<you>/Apps/pi-extensions` symlink is only a compatibility path for existing absolute references.

## OpenCode gateway

1. Copy and edit the private gateway configuration:

   ```sh
   cp failover-router/opencode/gateway.example.json /secure/path/failover-router.json
   chmod 600 /secure/path/failover-router.json
   ```

   Use `127.0.0.1` as the listener, set channel `baseURL` and model IDs, and use environment-variable names for all keys. A channel named `subrouter-<marketplace-slug>` participates in the shared tariff feed.

2. Supply `FAILOVER_ROUTER_KEY` to both the gateway and OpenCode. Supply each channel’s `apiKeyEnv` variable (for example, `FAILOVER_PRIMARY_KEY` and `FAILOVER_BACKUP_KEY`) **only** to the gateway. To refresh live tariffs, also supply `SUBROUTER_API_KEY` to either process that runs the tariff feed: Pi or the gateway, not the OpenCode client. Use a private environment or a secret manager; do not paste real keys into the examples or your shell history. Set `SUBROUTER_PRICE_CACHE_DIR` to the same absolute path on Pi and the gateway if their default state paths differ.

3. Start the gateway:

   ```sh
   FAILOVER_ROUTER_CONFIG=/secure/path/failover-router.json \
     npm --prefix failover-router run gateway
   ```

   Or pass the config path directly:

   ```sh
   npm --prefix failover-router run gateway -- /secure/path/failover-router.json
   ```

4. Merge the providers from [`opencode.example.jsonc`](./opencode.example.jsonc) into `~/.config/opencode/opencode.jsonc` (or the project `opencode.jsonc`). Keep the local `{env:FAILOVER_ROUTER_KEY}` reference and match each OpenCode model ID to a gateway profile ID.
5. Start OpenCode and select the gateway provider model, or try `opencode run --standalone --model failover-chat/chat-cheap "Say hello"` with the example model ID.

The gateway's private state is normally under `$XDG_STATE_HOME/ai-extensions/failover-router` or `~/.local/state/ai-extensions/failover-router`. It contains speed/legacy caches and `cost-ledger.ndjson`. The ledger records only bounded request metadata, provider usage, tariffs and cost status; it does not record prompts, responses, request bodies, credentials or raw provider diagnostics. `estimated` means all required usage and tariffs were present; `partial` or `unknown` means the result must not be treated as zero spend.

## Verify

```sh
npm --prefix failover-router test
npm --prefix pi-telegram-notifier test
node patches/gentle-pi-channels/verify.mjs
npm --prefix failover-router run test:opencode:smoke
```

The historical OpenCode matrix is included in the router suite. It exercises the channel-capability 400, incomplete 499 streams, historical 524 and missing Responses terminal events, both gateway envelopes, moderation and its false positives, outage, rate-limit, quota, auth, timeout, network, context overflow, malformed or missing fields, unknown errors, four chain passes, physical nine-attempt recovery, cooldown and cancellation. The isolated native OpenCode smoke also checks tool execution and ledger writes.

## Telegram notifier for Pi

The notifier remains a separate Pi-only extension. Follow [`pi-telegram-notifier/README.md`](../../pi-telegram-notifier/README.md), add its `index.js` to the Pi settings array, create its private local config, and restart Pi. It is not loaded by the OpenCode gateway in this change.
