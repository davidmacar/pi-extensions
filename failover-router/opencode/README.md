# Failover Router for OpenCode

OpenCode treats a local gateway as one or more OpenAI-compatible providers. The gateway routes each generation to real channels using its own credentials; it does not patch OpenCode or change Pi. No OpenCode UI plugin is required.

## Start

1. Copy [`gateway.example.json`](gateway.example.json) to a private config path. Replace the example channel URLs and model IDs. Use a separate profile for each API protocol: `chat/completions` or `responses`.
2. Make the environment variables named by `apiKeyEnv` available to the gateway process. Use a distinct strong local `FAILOVER_ROUTER_KEY`; only that key needs to be available to OpenCode. Supply keys through your private environment, not through a committed config or shell history.
3. From the checkout, run:

   ```sh
   npm --prefix failover-router run gateway -- /absolute/path/to/gateway.json
   ```

4. Merge the providers from [`opencode.example.jsonc`](opencode.example.jsonc) into your OpenCode config. Match each provider model ID to a gateway profile ID. With the gateway running, start OpenCode or run `opencode run --standalone --model failover-chat/chat-cheap "Say hello"`.

The gateway accepts the local Bearer key on `/v1/models`, `/v1/chat/completions`, and `/v1/responses`. `GET /health` only reports liveness. The listener is loopback-only. See the [installation guide](INSTALL.md) for credentials and setup.

## Per-attempt cost ledger

Each dispatched generation adds one line to the private `cost-ledger.ndjson` (mode `0600`). Attempts from the same HTTP request share a request ID. Records contain the physical channel and model, outcome, reported usage, and the cached tariff used for the estimate in CNY. The gateway does not query SubRouter for each generation or persist prompts, responses, credentials or raw provider diagnostics in this file.

`estimated` is calculated from reported usage and cached tariffs, not from an invoice. `partial` and `unknown` have a null total; `knownSubtotal` on a partial row covers only calculable components. Failed or aborted attempts can include usage when the provider reported it. If a cache-write tier cannot be identified, the gateway does not guess the rate. The ledger is local and does not update OpenCode’s native cost display or Pi’s session accounting.

## Routing and limits

| Setting | Behavior |
| --- | --- |
| `order: "configured"` | Follow the listed order. This is the default. |
| `order: "cost"` | Prefer known input tariffs; fall back to listed order. The [shared SubRouter tariff feed](../docs/shared-subrouter-prices.md) identifies channels by `subrouter-<marketplace-slug>`. |
| `order: "speed"` | Prefer recently measured throughput. `probeSpeed: true` enables short, billable probes on speed-profile candidates; it is off by default. |
| `recovery: "chain"` | Try each candidate once per pass, with up to four passes per gateway request. Channel failures trigger shared backoff; malformed requests and unknown failures do not rotate. |
| `recovery: "physical"` | Keep one configured candidate and allow three groups of three attempts, with a five-minute pause between groups. It never switches to another model. |
| `reasoningLevels` / `reasoningEffort` | Declare supported levels per candidate or pin a level. Use `[]` for a non-reasoning candidate. Unsupported requested levels are clamped or omitted. |
| `attemptTimeoutMs` | Maximum time for one physical dispatch, including its body. Default: 300,000 ms. Cooldown waits are separate and cancel when the client disconnects. |

Speed probes, the private cost ledger and legacy public prices use the gateway state directory (`$XDG_STATE_HOME/ai-extensions/failover-router`, falling back to `~/.local/state/ai-extensions/failover-router`). Override it with `FAILOVER_ROUTER_STATE_DIR`. Set `SUBROUTER_API_KEY` in the gateway environment to refresh shared tariffs at startup and hourly; no change to `refreshMarketplace` is required. That setting still enables the legacy public opt-in when shared pricing is not explicitly configured.

**Streaming trade-off:** the gateway buffers one full response (up to 16 MiB) before forwarding it. A broken attempt cannot expose its partial text or tool instructions to OpenCode, but this increases time to first output. OpenCode, not the gateway, executes tools. Completed tool results are forwarded as normal conversation input; the gateway does not rerun tools. A new model can still request another tool call.

**Protocol boundary:** all candidates in a profile must speak the same API. The gateway does not translate Chat into Responses, migrate provider-side response IDs, or route background Responses jobs. Responses use `store: false` and reject an explicit `store: true`; encrypted or provider-bound history may not be portable between providers. OpenCode still owns session state, model metadata, and estimates based on its catalog; the gateway does not preserve Pi's turn-level affinity or replace the client's native cost display. The gateway's attempt budget is per request, not across new HTTP requests OpenCode may initiate. Client timeouts can end recovery before all waits finish; the example uses loopback-specific timeout settings to allow long cooldowns.

## Verify

```sh
npm --prefix failover-router test
npm --prefix failover-router run test:opencode:smoke
```

The smoke targets OpenCode v2.0.32 and uses `opencode` from `PATH` (override with `OPENCODE_BIN`). On Linux it needs Bubblewrap and network namespaces. It runs with temporary client state and loopback-only fake upstreams. Chat recovers from an HTTP 429; Responses recovers from a truncated stream and discards its tool call. Both verify a single successful tool execution and the corresponding cost ledger rows. The Node regression suite also exercises the historical Pi error cases through both gateway protocol paths. No provider account is required.
