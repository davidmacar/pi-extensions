# pi-failover-router

A Pi extension that registers **virtual models** which fail over across channels when the
failure is owned by the provider, not by the request.

## Why it exists

Pi classifies a terminal error into exactly one category, and only six of them move a
fallback chain:

```
quota · auth · rate_limit · provider_unavailable · timeout · network
```

Everything else stops the run where it is. Two real channel defects land in the dead zone:

| Observed error | Pi category | Chain moves? |
| --- | --- | --- |
| `<model> requires Responses for tool calls; this account only supports Chat Completions` (400, `invalid_request_error`) | `invalid_request` | **no** |
| `status_code=499, upstream stream read failed before completion: http2: response body closed` | generic `unavailable` (no keyword matches) | **no** |

Both are **channel** problems: the same model on another channel works. The classifier
cannot tell, because it only reads the label. This extension reads the raw message instead.

## What it does

`route(request, ctx)` runs before every request. On `reason: "retry"` it inspects
`request.failed.message.errorMessage`:

- **rotates** to the next candidate when the failure is channel-owned or transient;
- **refuses to rotate** when the failure is request-shaped (context length, malformed
  payload, missing field, unknown), because every model would fail the same way;
- **takes over failures Pi refuses to retry.** Pi decides retryability with an allow-list
  (`isRetryableAssistantError` in `@earendil-works/pi-ai`). A message outside it — precisely
  `upstream stream read failed before completion: http2: response body closed`, which matches
  neither `upstream_stream_read_error` nor `http/?2 stream failed` — ends the run before
  `route()` is ever asked with `reason: "retry"`. On `agent_end` the router picks the next
  channel, and on `agent_before_settle` it appends a marker entry and asks for one more
  request, so the retry happens on the next channel. Bounded by
  `MAX_FORCED_CONTINUATIONS` (3) per session so it can never loop;
- puts the failed model in **cooldown** (30 min for quota/auth, 2 min otherwise);
- keeps the model that failed when it will not rotate, so you see the real error instead
  of a silently different channel.

Other reasons (`user`, `continuation`, `direct`) stick to the model that last answered,
which keeps the prompt cache warm.

## Configuration

Two virtual models per family: a cheap one (`order: "cost"`) and a fast one (`order: "speed"`).

| Virtual | Order | First candidate |
| --- | --- | --- |
| `router/sol-barato` — GPT 6.1 Sol — barato | configured order, cheapest channel first | `subrouter-fxpayback` |
| `router/deepseek-barato` — Deepseek 4.1 Flash — barato | configured order, cheapest channel first | `subrouter-znu` |
| `router/sol-rapido` | measured throughput, fastest first | whatever probed fastest |
| `router/deepseek-rapido` | measured throughput, fastest first | whatever probed fastest |

`order: "speed"` reorders the same chain by measured output tokens per second. A channel that
has never been measured keeps its configured position, so a fresh install behaves exactly like
the cheap list until a probe says otherwise.

### Throughput measurement

- A measurement session starts with each Pi session and runs **before** the first request: the
  first request waits for it, every later one is synchronous.
- The result is cached in `~/.pi/agent/failover-router-speed.json` for **15 minutes**, so a run of
  consecutive sessions pays for one measurement, not one per session.
- While a session stays active the measurement is refreshed every 15 minutes. When the session
  ends the timer is cleared, so an idle install never probes.
- Each channel is probed sequentially with a 100 token reply and a 20 second timeout. The median of
  the last 5 samples is used, so one hung probe cannot win.
- Only channels of `speed` chains are probed; the cost chains never spend a request.
- A probe is a real request on a real channel: it costs tokens and counts toward session cost.

### Optional fields next to `chain`

| Field | Meaning |
| --- | --- |
| `order` | `"cost"` (default) or `"speed"`. |
| `thinkingLevels` | Levels offered for selection. Set the ones the physical model really supports, from its `thinkingLevelMap` in `models.json` (`"minimal": null` means unsupported). Defaults to `["low", "medium", "high"]`. |
| `contextWindow` / `maxTokens` | Positive integers, shown before the first response. Afterwards Pi uses the limits of the physical model that answered. |
| `input` | Non-empty subset of `["text", "image"]`. |
| `description` | Free text. Kept in the config for humans; Pi's virtual model entry does not surface it. |

Cost is **not** configurable: Pi builds every virtual model with a zero cost
(`createVirtualModel` in the Pi core), so a real average price cannot be declared as cost.
Write it in `name` — the one field the model picker shows — or in `description` for
reference. Session cost accounting is unaffected: assistant messages record the physical
model, so each turn is billed at its real channel price.

A step that omits `thinkingLevel` passes the level the caller selected straight through, so
one virtual model can serve roles that think at different levels. A step that names a level
wins over the caller's selection.

## Install

1. Add the extension path to `~/.pi/agent/settings.json`:

   ```json
   { "extensions": ["/home/<you>/Apps/pi-extensions/pi-failover-router/index.js"] }
   ```

2. Write the config file (see above).
3. `/reload`, then pick the virtual model with `/model` — it appears as `router/sol-barato`.

## Verify it is live

- Startup log carries `failover-router: registered router/sol-barato (N candidates)`.
- `/model` lists the virtual model under provider `router`.
- On a rotation the log reads
  `failover-router: router/sol-barato retry after <model> — <kind>: <reason>`.

## Tests

```bash
npm test
```

30 classification/config cases and 10 router cases, including the two real error bodies
above and the must-not-rotate cases. `node --test`, no dependencies.

## Scope and honest limits

- It routes **models**, not channels. A Pi request cannot pin a channel; a channel can only
  be pinned by using a provider whose API key is bound to that channel.
- It reacts on `retry`, so Pi has already spent its own retries on the failed model before
  a rotation happens.
- A request-shaped failure is never retried elsewhere, by design. If a real channel defect
  ever produces a request-shaped label not covered in `lib/classify.js`, add the marker
  there **with a test** rather than loosening the generic patterns.
