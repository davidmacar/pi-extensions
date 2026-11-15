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
- puts the failed model in **cooldown** (30 min for quota/auth, 2 min otherwise);
- keeps the model that failed when it will not rotate, so you see the real error instead
  of a silently different channel.

Other reasons (`user`, `continuation`, `direct`) stick to the model that last answered,
which keeps the prompt cache warm.

## Configuration

`~/.pi/agent/failover-router.json` (override with `PI_FAILOVER_ROUTER_CONFIG`):

```json
{
  "virtuals": [
    {
      "provider": "router",
      "id": "sol",
      "name": "Sol (failover)",
      "thinkingLevels": ["high", "xhigh"],
      "chain": [
        { "model": "subrouter-best/gpt-6.1-sol", "thinkingLevel": "xhigh" },
        { "model": "subrouter-000/gpt-6.1-sol", "thinkingLevel": "xhigh" },
        { "model": "subrouter-fxpayback/gpt-6.1-sol", "thinkingLevel": "xhigh" }
      ]
    }
  ]
}
```

- `chain` is ordered by preference; the first entry is the default target.
- A step is either an object or the string `"provider/id"` (optionally `provider/id@level`).
- Every referenced `provider/id` must exist in `~/.pi/agent/models.json` with credentials.
- Config errors are reported through `pi.log` and register nothing: a typo never becomes a
  silently dead chain.

## Install

1. Add the extension path to `~/.pi/agent/settings.json`:

   ```json
   { "extensions": ["/home/<you>/Apps/pi-extensions/pi-failover-router/index.js"] }
   ```

2. Write the config file (see above).
3. `/reload`, then pick the virtual model with `/model` — it appears as `router/sol`.

## Verify it is live

- Startup log carries `failover-router: registered router/sol (N candidates)`.
- `/model` lists the virtual model under provider `router`.
- On a rotation the log reads
  `failover-router: router/sol retry after <model> — <kind>: <reason>`.

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
