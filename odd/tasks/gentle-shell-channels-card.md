# Gentle Shell Channels card

One new rail card in Gentle Shell, fed by `pi-failover-router`, showing the state of the
chosen channels and the three fastest channels of each model with the tokens per second of
the last measurement.

## Specs

S1 — quote: "incorporar una nueva caja para reflejar el estado de los canales elegidos y los
3 primeros canales para cada uno de los modelos con sus tokens por segundo obtenidos en la
última medición".
The card lists, per physical model, the channels the router would use (chosen channel first)
limited to three, each with the newest measured tokens per second and its state: in use,
available, in cooldown with the remaining time, or never measured.

S2 — quote: "Esta caja deberá actualizarse cuando se dispare la extensión y la medición de
velocidad".
The router publishes a snapshot when it loads, after every speed measurement settles, and
after every rotation that starts a cooldown; Gentle Shell repaints the card on each snapshot
without waiting for the next keystroke.

S3 — quote: "debe estar integrada con la misma estética que las demás".
The card is a normal rail section: same header with count, same indent, same collapse
control, same gap, same position in the section order, and it disappears when no snapshot
has ever arrived.

## Tasks

| ID | Spec | Route | State |
| --- | --- | --- | --- |
| T1 | S1 | Inline: `pi-failover-router/lib/channels-snapshot.js` + `test/channels-snapshot.test.js` | done — 14 tests |
| T2 | S2 | Inline: publish from `pi-failover-router/index.js` on load, first request, measurement settle and rotation | done — suite 149/149 |
| T3 | S1, S3 | Inline: `patches/gentle-pi-channels/files/lib/channels-sidebar-state.ts` and `shell-channels.ts` | done |
| T4 | S2, S3 | Inline: wire the section into the installed `gentle-pi` (`lib/shell-bar.ts`, `extensions/gentle-shell.ts`, `docs/gentle-shell.md`) | done — `apply.mjs --check` clean |
| T5 | S2, S3 | Inline: `apply.mjs`, `verify.mjs`, README | done — render + syntax pass |
| T6 | S2 | Inline: `pi-failover-router/lib/patch-guard.js` + 4 tests, wired at `session_start` | done — self-heal proven end to end |
| T7 | S2 | Inline: durability routes documented with Pi doc citations [L7] | done |

Committed work units are pending the human: the tree already carried unrelated in-progress work
when this feature started (L2), so nothing here was staged on top of it.

## Log

L1 — original request, verbatim:

> En mi Instalación de PI tengo unas cajas con información en la pantalla, estas cajas son
> Agents, Changes, Stats e Integrations. Todas estas muestran información relevante de mi
> sesión actual. Me gustaría incorporar una nueva caja para reflejar el estado de los canales
> elegidos y los 3 primeros canales para cada uno de los modelos con sus tokens por segundo
> obtenidos en la última medición. Esta caja deberá actualizarse cuando se dispare la
> extensión y la medición de velocidad y debe estar integrada con la misma estética que las
> demás.

L2 — constraint found while exploring: Gentle Shell has no extension seam for cards. The rail's
section list is closed (`lib/shell-bar.ts` `StatusSection`, `lib/shell-sidebar-layout.ts` part
keys), so a new card necessarily edits the installed package. `~/.pi/agent/npm/node_modules/gentle-pi`
is a published tarball, not a checkout, and the working tree here already carries unrelated
in-progress work (`index.js`, `lib/speed-cache.js`, `docs/`, `lib/decision-log.js`, …). Commits
are therefore left to the human; the durable artifact is a re-appliable patch directory, not a
commit that hides the node_modules dependency.

L3 — decision: the router owns the data (it measures, it knows cooldowns and the chosen
channel) and publishes one validated snapshot over `gentle-pi:channels-sidebar/v1`. Gentle
Shell only paints it, so the card never reads the router's files and a second producer would
need no shell change.

L4 — contract chosen: `gentle-pi:channels-sidebar/v1` on `pi.events`, carrying per physical model
the chosen channel and at most three channels with `state` (`active`/`ready`/`cooldown`/`failed`/
`unmeasured`), the newest `tokensPerSecond`, `cooldownMs` and the probe error as `note`. Ranking is
`orderBySpeed`, the same function routing uses, so the card cannot disagree with the router.

L5 — evidence: `npm test` in `pi-failover-router` → 149/149 (14 new). `node
patches/gentle-pi-channels/verify.mjs --print` renders the real `renderShellStatusSections` through
jiti and asserts header count, chosen channel, speed column, every mark, section order, collapse and
the hidden-without-data case; it also transpiles the four patched `.ts` files with bun. `node
apply.mjs --check` reports the installed package still carries the patch, and correctly reported
`lib/shell-channels.ts: out of date` when only the repo copy changed.

L6 — limit, stated for the reviewer: `verify.mjs` stubs `nan-provider` and `background-jobs-tools`,
because those two modules reach for the live Pi host. Neither can influence a channel row. The card
is proven by that render plus `apply.mjs --check`; the last step is a `/reload` in the human's own
session, which is the only place the live rail exists.

L7 — durability research (Pi's own docs). No sidebar/panel API and no cross-extension renderer
composition (`docs/extensions.md` widgets/footer/header; `docs/tui.md:9-16`), so an in-rail card can
only be package code. No checksum or modified-file check for installed npm packages, so a clobbered
card is invisible. Three documented routes: self-heal in the running extension (implemented —
`patch-guard.js`, one contained child process per session, notifies on repair and on anchor drift);
pin `npm:gentle-pi@4.8.0` (`docs/packages.md:31,42` — an exact version is not checked); or replace
the npm package with a local path package (`docs/packages.md:40,112` — "not installed or modified"),
which needs its own clone at upstream tag `v4.8.0`, its own `npm install --omit=dev`, and no
`npm:gentle-pi` entry (precedence between same-name sources is undocumented). No dev mode exists;
`pi -e` packages are cached and re-checked, so they are not a durability route.

L8 — evidence for the guard: with `lib/shell-channels.ts` deleted from the installed package, a
simulated `session_start` notified "the Channels card was missing after an update and has been
re-applied; /reload to paint it" and the file came back byte-identical. Suite 153/153.

L9 — decision (human): keep the npm package unpinned so every Pi update lands; no local-path package
and no exact-version pin. Accept that an upstream release may move an anchor, detect it loudly (the
guard's "no longer applies" notification), and repair it when it happens. Route 1 of L7 is therefore
the only durability mechanism in use; settings keeps `npm:gentle-pi` without a version.

L10 — notification contract for a broken card (human request: "cuando falle salte una notificación
en PI ligera al arranque indicando que no se ha podido cargar la caja"). One line at session start,
`info` when the patch re-applied itself, `warning` when it could not, always mirrored to the
router's log file; never blocking, never affecting routing. The guard now registers before the
`refs.length === 0` early return, so a cost-only configuration still repairs the card. Messages
lead with `failover-router: the Channels card is not loaded`, name the moving anchor as
`file: reason`, and point at `apply.mjs`.

L11 — evidence: simulated the four startup outcomes against the installed package — healthy
(`0` notifications), card wiped (`info` re-applied, file restored byte-identical), upstream
rewrote the channels import (`info` re-applied), anchor gone (`warning` naming
`lib/shell-bar.ts: expected exactly one anchor for "make channels a collapsible section key",
found 0`), patch script renamed (`warning`, "the patch script is missing"). Suite 153/153 after
adding 2 guard cases; `apply.mjs --check` clean at the end of every scenario.

L12 — delivery record and the reviewer-model blocker found on the way. The work was published as
`fb6afa8` + `53b30f3` (origin/master). The native review could not run: reviewer lens models come
from the saved agent-model routing store `~/.pi/gentle-ai/models.json` (read by the Pi host relay
through `lib/model-routing-authority.ts` `modelConfigPaths`), and that store mapped every lens to a
**router virtual model** (`router/sol-rapido`, `router/deepseek-rapido`). The relay completes a
reviewer with `modelRegistry.complete`, so a virtual model fails with
`Virtual model router/sol-rapido must be routed before streaming` — `route()` is what turns a
virtual model into a channel, and the relay never calls it. `prepared_reviewers`/`submitted_reviewers`
stay at 0 and `mutation_outcome` is `none`, so the attempts cost no authority but can never succeed.

What was fixed and what stayed blocked: the three other layers (`~/.pi/agent/agents/review-*.md`
frontmatter, `~/.pi/agent/subagents.json`, `~/.pi/agent/profiles.router.json`) were repointed to
physical channels with `.bak-<timestamp>` backups. `~/.pi/gentle-ai/models.json` is refused to model
tools by design ("Permission configuration is human-controlled"), so it must be changed through the
mode settings UI; until then a review whose lenses name `router/*` cannot complete. Delivering this
work therefore required `gentle-ai review mode disable --scope clone` (global stayed on). To restore
reviews: set the four `review-*` entries to physical channels in that store, then
`gentle-ai review mode enable --scope clone`.

L13 — verification at delivery: `npm test` 155/155, `apply.mjs --check` reports the card installed,
`verify.mjs` renders and asserts the card, and `origin/master` matched local `master` at `53b30f3`.
