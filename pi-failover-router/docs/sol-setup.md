# Configure GPT 6.2 Sol channels

The router's `sol-barato` and `sol-rapido` routes use `gpt-6.2-sol` on six SubRouter connections. The provider template contains placeholders only. Do not reload or start a new session until the real provider configuration is ready: speed routes make measurement requests at session start.

## Finish the local setup

1. Open `~/.pi/agent/models.json` locally. Keep this credential-bearing file private. Do not paste it into chat.
2. Use [`models-sol.example.json`](../models-sol.example.json), also staged at `~/.pi/agent/models-sol.placeholders.json`, as a **merge reference**, not a replacement for the entire file. Pi does not load the placeholder file automatically.
3. Under `providers`, update existing `subrouter-fxpayback`, `subrouter-xcgx` and `subrouter-lingai` entries, and add any missing providers from the table below. Keep unrelated models, endpoints, compatibility settings and fields. In each affected provider's `models` array add/update the `gpt-6.2-sol` entry. Remove obsolete Sol model entries from every provider (including channels that no longer belong to the Sol chains), without removing other models.
4. Put each rotated channel-specific key in that provider's `apiKey` field, replacing its placeholder. Preserve the separate DeepSeek model on `subrouter-lingai`. Ensure the rotated LingAI key permits both models if it is shared with DeepSeek; otherwise use a separate connection/key for DeepSeek and update its route locally.
5. Review `~/.pi/agent/failover-router.json`: both Sol chains should list the same six providers. The router configuration never contains keys.
6. When credentials are ready, request live verification. Do not run `/reload` yet if measurement requests are not desired. `/reload` reloads the extension; `/model` reloads custom provider configuration. A fresh session is the simplest way to load both after setup.

## Where to put each key

All paths below are inside `~/.pi/agent/models.json`:

| Channel | JSON field |
|---|---|
| fxpayback | `providers.subrouter-fxpayback.apiKey` |
| XCGX AI | `providers.subrouter-xcgx.apiKey` |
| fate86api | `providers.subrouter-fate86api.apiKey` |
| a6aa | `providers.subrouter-a6aa.apiKey` |
| OpenAI Pro | `providers.subrouter-openai-pro.apiKey` |
| LingAI | `providers.subrouter-lingai.apiKey` |

Provider IDs are local labels. Each channel's key determines the SubRouter upstream; the common URL alone does not pin a channel. The template uses `https://subrouter.ai/v1` with `openai-completions` as an **unverified starting configuration**, based on the tester's documented Chat Completions support. It was not copied from your private provider file. If an existing provider uses a verified different API/compatibility configuration, preserve that configuration rather than blindly replacing it with the template.

## Preserved behavior and pending validation

- `router/sol-barato` retains `order: "cost"`. The router uses the configured order; it does not query prices or sort them automatically. The initial order follows the supplied channel list. Reorder the six steps once current prices are known.
- `router/sol-rapido` retains `order: "speed"` and the same channels. Old-model samples cannot measure the new model; its first measurement uses the new references.
- DeepSeek routes are unchanged in the router file. Provider edits must preserve their models and authentication locally.
- Context/output limits and thinking-level labels carry forward the previous Sol configuration. They are assumptions pending provider validation. Prices are omitted from the physical template rather than inventing rates. Do not trust billing estimates until actual per-channel costs are configured.
- Repository model references were updated, including test fixtures. Historical troubleshooting examples are version-normalized to the new ID; they do not prove a live request to the new model succeeded.
- The active router syntax typo was fixed. The active credential-bearing `models.json` and ai-model-tester credential storage were **not opened or modified**. Obsolete entries can remain there until you finish the local merge. No historical session transcripts, logs or measurement caches were erased.

## Offline verification

`node --test test/sol-example.test.js` verifies both routes, the six physical model entries/placeholders, and preservation of the DeepSeek example routes. These tests use repository fixtures only; they do not load credentials or send network requests. Live tests are deferred until requested.
