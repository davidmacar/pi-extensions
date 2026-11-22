# Configure GPT 6.2 Sol channels

The router's `sol-barato` and `sol-rapido` routes use `gpt-6.2-sol` on six SubRouter connections. The
provider entries now exist in `~/.pi/agent/models.json`; **three of them still carry placeholder keys**.

## Finish the local setup

1. Open `~/.pi/agent/models.json` locally. Keep this credential-bearing file private; do not paste it
   into chat.
2. Replace the placeholder `apiKey` of the three channels marked *pending* in the table below.
   `fxpayback`, `XCGX AI` and `LingAI` already hold their rotated keys and were left untouched.
3. Keep DeepSeek's entitlement on `subrouter-lingai` working. If the rotated LingAI key no longer
   permits DeepSeek, give DeepSeek a separate connection/key and point its route there locally.
4. Review the router file `~/.pi/agent/failover-router.json`: both Sol chains must list the same six
   providers. The router configuration never contains keys.
5. When credentials are ready, request live verification. A fresh session is the simplest way to load
   the extension and the provider file together. Avoid reloading before that: `sol-rapido` starts
   measuring channels at session start and those probes are paid requests.

A backup of the previous provider file was taken before the edit:
`~/.pi/agent/models.json.bak-gpt-6.2-sol-<timestamp>`.

## Where each key goes

All paths are inside `~/.pi/agent/models.json`. Provider IDs are local labels: each channel's own key
selects the SubRouter upstream, the shared URL does not.

| Channel | JSON field | Key state |
|---|---|---|
| fxpayback | `providers.subrouter-fxpayback.apiKey` | rotated key already present |
| XCGX AI | `providers.subrouter-xcgx.apiKey` | rotated key already present |
| fate86api | `providers.subrouter-fate86api.apiKey` | **placeholder** |
| a6aa | `providers.subrouter-a6aa.apiKey` | **placeholder** |
| OpenAI Pro | `providers.subrouter-openai-pro.apiKey` | **placeholder** |
| LingAI | `providers.subrouter-lingai.apiKey` | rotated key already present |

[`models-sol.example.json`](../models-sol.example.json) documents the same shape without secrets.

## Preserved behavior and pending validation

- Old Sol entries were replaced in every provider that carried them; `subrouter-lingai` received the
  model without losing its DeepSeek entries. Unrelated providers were not touched.
- `router/sol-barato` keeps `order: "cost"`. The router uses the configured order and does not query
  prices. The order follows the supplied channel list; reorder the six steps once current prices are
  known.
- `router/sol-rapido` keeps `order: "speed"` over the same channels. Old-model samples cannot measure
  the new model, so its first measurement uses the new references.
- Context/output limits and thinking-level labels carry forward the previous Sol configuration. They
  are assumptions pending provider validation.
- The maintained per-channel prices are still the old model's rates, so cost estimates are
  approximate until real `gpt-6.2-sol` prices replace them. The three new providers have no `cost`
  block yet.
- Historical troubleshooting examples were version-normalized; they do not prove a live request
  succeeded. No transcripts, logs or measurement caches were erased.

## Offline verification

`node --test test/sol-example.test.js` checks both routes, the six physical entries, placeholder shape
and the preserved DeepSeek example routes. It reads repository fixtures only: no credentials, no
network. Live tests remain deferred until requested.
