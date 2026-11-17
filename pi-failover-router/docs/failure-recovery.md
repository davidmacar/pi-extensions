# Failure recovery: what is established

This document records only claims backed by evidence in this repository's
runtime. Every section states where the claim comes from. Anything not yet
proven is listed at the end as an open question and must not be acted on as if
it were settled.

## 1. The failure being recovered from

Signature, taken from `~/.pi/agent/sessions/--home-admin-toural-Apps-rocky-light--/2026-11-17T09-00-48-333Z_01a1e8bc-c74b-700a-8caa-8ebc48ba06c8.jsonl`:

| Field | Value |
| --- | --- |
| `stopReason` | `error` |
| `errorMessage` | `upstream stream read failed before completion: http2: response body closed` |
| `usage.output` | `0` |
| `durationMs` | `304211` and `304222` (two separate occurrences) |
| Provider | `subrouter-fxpayback`, model `gpt-6.1-sol` |

Established: the two failures lasted ~304 seconds and produced no output
tokens. A ~5 minute ceiling with zero output is a timeout signature, not a
random connection drop. Both failures hit the same channel.

## 2. The router was active in that session

Established from the same log:

- entry 1: `model_change` to `router/deepseek-rapido`
- entry 4: `model_change` to `router/sol-rapido` (the model used for the work)
- assistant messages were produced by `subrouter-fxpayback` (10) and
  `subrouter-best` (11)

`router/sol-rapido` has `order: "speed"` with chain
`fxpayback -> best -> 000 -> xcgx`. Because no sol channel has a speed
measurement yet (see `~/.pi/agent/failover-router-speed.json`, where all four
sol channels carry `lastError`), the chain keeps its configured order. That is
why traffic began on `fxpayback` and moved to `best`.

Established: the router routed and rotated. The problem is not that the router
is absent from the session.

## 3. The run ends on that error

Established: the second failure is the last entry of the session file. No
message follows it, on any channel.

Established: after the first failure the session continued, but the entry that
follows it is a `gentle-jobs.notice` (a background job finishing), not a router
marker. So the continuation that saved the first failure was caused by that
notice, and the log cannot show whether the router's own takeover fired.

## 4. The settle boundary rejects a bare continuation after an error

Established from the shipped Pi runtime,
`dist/bundle/chunks/chunk-VEJDBY3O.js` (`_runBeforeSettleBoundary`):

```js
let finalContext = this._buildBoundaryContext([], "agent_before_settle");
if (this._abortDuringBeforeSettle) return !1;
let shouldContinue = result.continue || this.agent.hasQueuedMessages();
return shouldContinue && !finalContext.canContinue
  ? (result.continue && this._reportInvalidBoundaryContinuation("agent_before_settle"), !1)
  : shouldContinue
```

Two facts follow directly from that code:

1. the context that decides `canContinue` is built from an **empty** entry list,
   so the entries a handler returns cannot raise `canContinue`;
2. when `canContinue` is false and a handler asked to continue, Pi reports an
   invalid boundary continuation and returns `false`.

Established: a takeover that relies on `agent_before_settle` returning
`continue: true` after an assistant error cannot rely on its entries to make the
boundary allow the continuation.

## 5. Both boundary events exist in this Pi version

Established from `dist/core/extensions/types.d.ts:1251-1252`:

```ts
on(event: "agent_end", handler: ExtensionHandler<AgentEndEvent>): () => void;
on(event: "agent_before_settle", handler: ExtensionHandler<AgentBeforeSettleEvent, AgentBeforeSettleEventResult>): () => void;
```

Established: the handlers are registered; the failure is not a misspelled event
name.

## 6. Test coverage does not cover this

Established: `test/router.test.js` exercises the takeover against a local fake
`pi` object built by `harness()`. That fake accepts any `entries`/`continue`
shape. The 103 passing tests therefore prove the router's own logic, not that
Pi accepts the continuation.

Established: this is why a green suite coexisted with a dead session.

## Open questions (not established, do not act on)

- The exact inputs `canContinue` is computed from.
- Whether an extension can start a new turn after a run ends, and from which
  event.
- Whether an extension can influence the retry allow-list that decides
  `isRetryableAssistantError`.
- Whether the router's `agent_end` takeover fired in the affected session. The
  decision log is written with `pi.log`, which this runtime does not persist.