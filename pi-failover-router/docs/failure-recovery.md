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
| Provider | `subrouter-fxpayback`, model `gpt-6.2-sol` |

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
notice.

Established from `~/.pi/agent/failover-router.log` for the same session at
22:08:40, where the failure was a `400 ... "code":"bad_response_status_code"`
on `subrouter-xcgx`:

```
22:08:40.965 router/sol-barato annotating subrouter-xcgx/gpt-6.2-sol for Pi's retry — channel_capability ...; next subrouter-fxpayback/gpt-6.2-sol
22:08:40.983 router/sol-rapido taking over subrouter-xcgx/gpt-6.2-sol — channel_capability ...; next subrouter-best/gpt-6.2-sol; 2 min cooldown (attempt 1)
22:08:41.427 rotation recorded; Pi will not continue automatically
```

Established: the classifier recognised the failure as channel-owned, the
`agent_end` takeover picked the next channel, and the takeover then declined to
continue because of the pre-entry `canContinue` flag (see §4). The decision log
is persisted, so this is not an unknown.

## 4. The settle boundary checks `canContinue` twice, from different states

Established from the shipped Pi runtime, `dist/core/agent-session.js`
(`_runBeforeSettleBoundary`):

```js
const result = await this._extensionRunner.emitBoundary(
  { type: "agent_before_settle", outcome },
  (entries) => this._buildBoundaryContext(entries, "agent_before_settle"),
);
this._commitBoundaryDrafts(result.entries);
this._flushPendingCustomMessages();
let finalContext = this._buildBoundaryContext([], "agent_before_settle");
let shouldContinue = result.continue || this.agent.hasQueuedMessages();
return shouldContinue && !finalContext.canContinue
  ? (result.continue && this._reportInvalidBoundaryContinuation("agent_before_settle"), !1)
  : shouldContinue
```

Two different contexts are built, and only the second one decides:

1. the `context` a handler receives is built from the entries that exist **before**
   that handler runs, so after an assistant error it always reports
   `canContinue: false` (last LLM role is `assistant`, nothing queued);
2. the check after `_commitBoundaryDrafts` rebuilds the context from the **session
   branch**, which now holds the committed entries. A `custom_message` entry
   becomes `{ role: "user" }` in `convertToLlm`, so the last role is no longer
   `assistant` and `canContinue` is true.

Established: a handler's returned entries DO raise `canContinue` in the decisive
check; what cannot raise it is the pre-entry context handed to the handler.

Consequence for the router: gating the continuation on `event.context.canContinue`
disabled the takeover in the only case it exists for — a terminal error — and the
rotation was recorded while the human kept the raw error on screen. `index.js`
now ignores that pre-entry flag and asks for the continuation; Pi's post-commit
check is the authority. Calling it the other way round was the defect.

## 5. Both boundary events exist in this Pi version

Established from `dist/core/extensions/types.d.ts:1251-1252`:

```ts
on(event: "agent_end", handler: ExtensionHandler<AgentEndEvent>): () => void;
on(event: "agent_before_settle", handler: ExtensionHandler<AgentBeforeSettleEvent, AgentBeforeSettleEventResult>): () => void;
```

Established: the handlers are registered; the failure is not a misspelled event
name.

## 6. Test coverage

Established: `test/router.test.js` exercises the takeover against a local fake
`pi` object built by `harness()`. That fake accepts any `entries`/`continue`
shape, so the suite proves the router's own logic, not that a real Pi build
accepts the continuation. The decisive evidence for §4 is the Pi source quoted
above, not a passing test.

## Open questions (not established, do not act on)

- Whether an extension can start a new turn after a run ends, and from which
  event.
- Whether `noteFailure` can count one failure twice when both paths fire (Pi
  retries after the annotation and `agent_end` also takes over). The 22:08
  incident logged `attempt 1`, consistent with a single count.
- Why the `message_end` annotation (`lib/retry-bridge.js`) never reaches Pi's retry
  allow-list in a live run: the modified message is returned and the handler's log
  line appears, yet no persisted `errorMessage` carries the marker and no retry
  followed it. The takeover (§4) is the path that must work.

## 7. A reload does not load new code

Established: `/reload` re-creates the extension instances but re-imports the same
module URLs, and for a package with `"type": "module"` Node caches a module by URL
for the life of the process. Two consecutive imports of one URL, with the file
edited in between, both return the pre-edit value; a fresh `jiti` instance
(`moduleCache: false`) does not help either, because the module is handed to
Node's native ESM loader.

Evidence from the live process: after a reload at 22:36:49 the decision log shows
`registered router/...` lines but none of the strings the loaded file contains at
that moment (`build <hash> loaded`, `asking Pi for one more request`). At 22:20:27,
after an earlier reload, it still wrote `making ... retryable` and `will not
continue automatically`, both removed by commit `ea9c7ee` at 22:16:46.

Consequence: a change to this extension takes effect only in a new `pi` process.
The router announces `failover-router: build <8 hex> loaded (pid <n>)` once per
load so the question "is this process running the fix?" is answered from the log
instead of from assumption.