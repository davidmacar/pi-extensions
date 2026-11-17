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
  request, so the retry happens on the next channel. There is no rotation budget:
  what limits it is the cooldown, which always expires;
- puts the failed model in **cooldown**, doubling with each consecutive failure of the same
  channel: 2 → 4 → 8 → 16 → 30 min for transient failures, from 30 min up to 2 hours for
  quota/auth. A channel that answers correctly starts over at the base value. Nothing is
  remembered beyond the cooldown, so a long working session never locks a channel out: it
  comes back by itself;
- **never sends a new request to a channel that is still cooling**, so a manual resend after
  an error goes to the next channel instead of returning to the one that just failed. When
  every channel is cooling the configured first one is used anyway: trying is better than an
  empty router;
- announces the code it loaded, once per load, as
  `failover-router: build <8 hex> loaded (pid <n>)`. The stamp is a hash of `index.js` plus
  every module in `lib/`, so it changes with any edit: `"the fix did not help"` and "the fix
  is not loaded" are no longer the same sentence;
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
  first request waits for it, but never longer than `MEASURE_WAIT_MS` (8 s). If the probes are
  still running after that, the request is routed with whatever measurements already exist. A
  probe can never turn into a hang.
- The result is cached in `~/.pi/agent/failover-router-speed.json` for **15 minutes**, so a run of
  consecutive sessions pays for one measurement, not one per session.
- While a session stays active the measurement is refreshed every 15 minutes. When the session
  ends the timer is cleared, so an idle install never probes.
- Each channel is probed sequentially with a 100 token reply. Timeouts scale per channel: the first
  attempt uses the **15 s** tier, a channel that stays silent moves to the **45 s** tier, and
  the tier that worked is remembered so a slow reasoning model stops paying for the short attempt
  on every run. The **newest sample decides the order**, so a channel that starts to degrade loses
  its place on the next measurement instead of being defended by its history. The last 5 samples
  are kept as history; no average is taken from them.
- **The probe never switches reasoning off.** It asks for the cheapest level the channel declares
  in its `thinkingLevelMap`, and omits the field when the channel declares none. Probing with
  `off` used to cost every reasoning channel a 400 and leave it permanently unmeasured.
- **A wider tier is earned by silence, not by failure.** A channel that stays silent moves up to
  the next tier; one that answers with an error has already said what is wrong, so it is recorded
  with that reason and not asked again. Retrying a hard `400` on a wider tier only spent a second
  request and hid the real error behind a timeout message.
- **Failures are remembered.** A channel that cannot be measured is stored with its reason and
  retried on the next measurement session. Without this, a channel that always times out looks
  exactly like one that was never measured — which is how an entire family silently went unmeasured.
- **Every attempt keeps its message.** Each channel stores the last 5 attempts, each with the time,
  whether it succeeded, and the text that explains it: the throughput and tier for a success, the
  provider or timeout message for a failure. A channel with no measurement can be diagnosed from
  `~/.pi/agent/failover-router-speed.json` alone, without hunting through a session transcript.
  The field is `attempts`; caches written before version 3 carried one `lastError` and are migrated
  to a single failed attempt on read.
- **Only the channels that are due are probed**: never measured, sample older than the window, or
  last attempt failed. A fresh healthy channel is not re-measured to repair its neighbours.
- Only channels of `speed` chains are probed; the cost chains never spend a request.
- A probe is a real request on a real channel: it costs tokens and counts toward session cost.

### The Channels card in Gentle Shell

The same measurements feed the rail's **Channels** card. This extension publishes one read-only
snapshot on `pi.events`, `gentle-pi:channels-sidebar/v1`, at session start, after every
measurement session settles, after the first request of a session, and after every rotation that
starts a cooldown. Per physical model it carries the channel a request would use and the three
fastest, each with the newest tokens per second and its state — `active`, `ready`, `cooldown`,
`failed` or `unmeasured`.

The card itself is a Gentle Shell section: Gentle Shell has no extension seam for a card, so it
needs the patch in [`../patches/gentle-pi-channels`](../patches/gentle-pi-channels). Without it
the extension publishes to no listener and nothing else changes. `node
../patches/gentle-pi-channels/verify.mjs --print` renders the card outside Pi, and `node
../patches/gentle-pi-channels/apply.mjs --check` says whether an upgrade removed it.

### Optional fields next to `chain`

| Field | Meaning |
| --- | --- |
| `order` | `"cost"` (default) or `"speed"`. |
| `thinkingLevels` | Levels offered for selection. Only `low`, `medium`, `high`, `xhigh` and `max` are ever sent: `off` and `minimal` are refused by these providers with a 400 (`does not support reasoning effort "none"`), so listing them is a no-op and the router drops them. Set the levels the physical model really supports, from its `thinkingLevelMap` in `models.json` (`null` means unsupported). Defaults to `["low", "medium", "high"]`, which is also the fallback when nothing admissible is left. |
| `contextWindow` / `maxTokens` | Positive integers, shown before the first response. Afterwards Pi uses the limits of the physical model that answered. |
| `input` | Non-empty subset of `["text", "image"]`. |
| `description` | Free text. Kept in the config for humans; Pi's virtual model entry does not surface it. |

Cost is **not** configurable: Pi builds every virtual model with a zero cost
(`createVirtualModel` in the Pi core), so a real average price cannot be declared as cost.
Write it in `name` — the one field the model picker shows — or in `description` for
reference. Session cost accounting is unaffected: assistant messages record the physical
model, so each turn is billed at its real channel price.

A step that omits `thinkingLevel` passes the level the caller selected through, so one virtual
model can serve roles that think at different levels. A step that names a level wins over the
caller's selection.

Whatever is selected, only a level the resolved channel accepts is sent. `off` and `minimal` are
never sent, and a level the channel marks `null` in its `thinkingLevelMap` is replaced by the
nearest level it does support — `off` lands on `low`, `max` degrades to the highest available.
When a channel supports no level at all, the field is omitted rather than sent. A mapping in
`models.json` that claims a level works is still treated as a hint, not a guarantee: the router
only trusts the five levels these providers accept.

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
