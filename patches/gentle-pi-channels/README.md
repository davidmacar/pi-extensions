# gentle-pi-channels patch

Adds the **Channels** card to Gentle Shell: separate **RÁPIDO** and **BARATO** sections for each
virtual model, with the selected channel. Fast sections show the three fastest channels and their
latest throughput; cheap sections show the three lowest current marketplace input prices. Each row
also carries one mark — `●` in use, `⏱ 4m` cooling down, `✕` probe failed, `—` never measured.

```text
▾ CHANNELS                                   4
  deepseek-v4.1-flash-1017 · RÁPIDO      → znu
  1 znu                            ● 7.1 tok/s
  2 stableai                         4.2 tok/s
  3 relai                       ⏱ 4m 3.7 tok/s
  deepseek-v4.1-flash-1017 · BARATO  → stableai
  1 stableai                       ● ¥0.07/M in
  2 znu                               ¥0.14/M in
  3 relai                             ¥0.27/M in
  gpt-6.2-sol · RÁPIDO                 → best
  1 best                           ● 1.2 tok/s
  2 fxpayback                                ✕
  3 000                                      —
  gpt-6.2-sol · BARATO             → fxpayback
  1 fxpayback                      ● ¥0.20/M in
  2 best                             ¥0.34/M in
  3 000                              ¥0.54/M in
```

## Why a patch and not an extension

Gentle Shell has no seam for a card: the rail renders a closed list of sections
(`lib/shell-bar.ts` `StatusSection`, `lib/shell-sidebar-layout.ts` part keys) and every card is
registered from inside the package. The install at
`~/.pi/agent/npm/node_modules/gentle-pi` is a published tarball, not a checkout, so this
directory is the durable copy. `π update` replaces the package and takes the card with it:
run `node apply.mjs` and the card is back.

The data belongs to the router, not to the shell. `pi-failover-router` measures throughput,
knows cooldowns and knows which channel a request would use; it publishes one validated
snapshot on `pi.events` and the shell only paints it. Any other extension can publish the same
event — the card is not wired to the router in particular.

## The contract

`gentle-pi:channels-sidebar/v2`, payload:

```json
{
  "schema": "gentle-pi.channels-sidebar/v2",
  "measuredAt": 1794938790229,
  "models": [
    {
      "model": "deepseek-v4.1-flash-1017",
      "virtualId": "deepseek-rapido",
      "order": "speed",
      "active": "znu",
      "total": 4,
      "hidden": 1,
      "channels": [
        { "ref": "subrouter-znu/deepseek-v4.1-flash-1017", "channel": "znu", "state": "active", "tokensPerSecond": 7.2, "measuredAt": 1794938790229 }
      ]
    }
  ]
}
```

Each model entry is one virtual route and includes `virtualId` plus `order` (`speed` or `cost`).
Cheap rows carry normalized CNY `price: { input_price, price_currency: "CNY" }`; the router refreshes those values
dynamically and republishes the snapshot. The card labels them `¥…/M in` (input price per million tokens). `state` is one of `active`, `ready`, `cooldown`, `failed`, `unmeasured`; `cooldownMs` carries
the remaining wait and `note` the reason behind a failure. At most three channels per model and
sixteen models are painted; anything else is refused instead of painted. It is display data
only: it grants no review, permission or delivery authority, and a malformed payload is ignored
rather than crashing the shell.

## Surviving Pi updates

`pi update` reinstalls the npm package and Pi documents **no checksum or modified-file check** for
installed packages (`docs/packages.md` installs npm packages under the Pi npm directory;
`docs/settings.md` only exposes `npmCommand`). A wiped card is therefore invisible: the rail just
paints one section fewer. There are four ways to make that durable, weakest to strongest.

**Chosen route: 1, self-heal.** The install stays `npm:gentle-pi`, unpinned, so every Pi update
arrives normally; the card repairs itself and says so when an anchor moved. A frozen package is
not an acceptable trade here — routes 2 and 3 below buy immunity by giving up updates and are kept
only as reference. When an upstream release moves an anchor, fix the anchor then: that is a known,
bounded repair, not a reason to freeze the harness.

1. **Self-heal, in the running extension (active now).** `pi-failover-router` runs
   `apply.mjs --check` once per session start, in a child process that never blocks routing, and
   re-applies the patch when the check fails. A repair logs and notifies
   `the Channels card was missing after an update and has been re-applied; /reload to paint it`;
   a moved anchor notifies the first problem instead of half-patching (see "What you see when it
   fails" for every line and level). Set
   `PI_FAILOVER_ROUTER_NO_PATCHER=1` to turn it off. This keeps automatic updates working and only
   breaks when upstream moves an anchor — loudly.
2. **Pin the exact version** — `"npm:gentle-pi@4.8.0"` in `packages`. `docs/packages.md:31,42`: a
   version pinned to an exact number is not checked, so Pi stops reconciling the package and your
   patched files stay. You also stop receiving fixes until you bump the pin and re-apply.
3. **Load a local package instead** — `packages: ["/home/<you>/Apps/gentle-shell"]`.
   `docs/packages.md:40`: a local package is "loaded from the resolved path without copying";
   `:112`: "Local packages are not installed or modified". Nothing can clobber it. Cost: you own
   the clone — remove `npm:gentle-pi` from `packages` (no documented precedence when the same name
   arrives twice), keep the patch as a commit rebased onto each upstream tag (`v4.8.0` matches the
   installed build today), and give the clone its own `npm install --omit=dev` because its one real
   dependency, `@heyhuynhgiabuu/pi-pretty`, is not host-provided.
4. **Upstream the card.** Pi documents widgets, footer and header factories, but **no sidebar or
   panel surface** (`docs/extensions.md` "Widgets, Status, and Footer"; `docs/tui.md:9-16`) and no
   way for one extension to add a section to another's rendered output — the only cross-extension
   hooks are the event bus and renderer chains. So the card can only become upstream code: the
   event contract here is already generic (`gentle-pi:channels-sidebar/v2`), which is what a PR to
   `Gentleman-Programming/gentle-shell` would carry.

`pi -e` is not a durability route: `docs/packages.md:31` caches and re-checks those packages.

## What you see when it fails

The guard runs one short child process per session and stays silent when the card is installed.
When it is not, Pi shows one line at session start, and the same line goes to
`~/.pi/agent/failover-router.log`:

| Situation | Level | Line |
| --- | --- | --- |
| An update removed the card, the patch re-applied | `info` | `failover-router: the Channels card was missing after an update and has been re-applied; /reload to paint it` |
| Upstream moved an anchor the patch needs | `warning` | `failover-router: the Channels card is not loaded — the patch no longer applies (lib/shell-bar.ts: expected exactly one anchor for "make channels a collapsible section key", found 0); run node patches/gentle-pi-channels/apply.mjs` |
| The patch directory is not where the extension expects it | `warning` | `failover-router: the Channels card is not loaded — the patch script is missing; see patches/gentle-pi-channels/README.md` |
| The check itself could not run | `warning` | `failover-router: the Channels card could not be verified (<reason>)` |

A notification never blocks a session and never changes routing: `notifyQuietly` catches a host
that refuses it. `PI_FAILOVER_ROUTER_NO_PATCHER=1` turns the guard off entirely, which is the only
case where a broken card is silent. The guard also runs when every configured chain is
cost-ordered, so a settings change that removes the speed chains does not disable the repair.

## Commands

```bash
node apply.mjs            # apply what is missing (idempotent)
node apply.mjs --check    # verify the install still carries the card
node apply.mjs --dry-run  # say what would change, write nothing
node verify.mjs --print   # render the card outside Pi and print it
node apply.mjs --root /path/to/gentle-pi
```

`--check` and `verify.mjs` are the two things to run after an upgrade. `verify.mjs` copies
`lib/` and `scripts/` to a scratch directory, stubs the two modules that need the live host
(`nan-provider`, `background-jobs-tools`), and renders the real `renderShellStatusSections`
through jiti — the same loader Pi uses. It asserts the header count, the chosen channel, the
speed column, every mark, the section order, the collapse and the hidden-without-data case.

## What it changes in the package

| File | Change |
| --- | --- |
| `lib/channels-sidebar-state.ts` | new: the event name, the snapshot types, the validator |
| `lib/shell-channels.ts` | new: the card's rows |
| `lib/shell-bar.ts` | `channels` on the bar model, `"channels"` in `StatusSection`, the section pushed before Integrations |
| `extensions/gentle-shell.ts` | subscribes to the event, stores the snapshot, keys the footer memo on it, repaints on arrival |
| `docs/gentle-shell.md` | the card in the Rail paragraph, the section order, and the event contract |

## When an anchor is gone

`apply.mjs` refuses to guess: if `gentle-pi` moved a line it anchors on, it prints the edit that
failed and exits 1 instead of half-patching a release. Fix the anchor against the new source,
run `verify.mjs`, and the card is back. The two new modules are copied whole, so they cannot
half-apply.

## Uninstall

Delete `lib/channels-sidebar-state.ts` and `lib/shell-channels.ts`, revert the anchors
(`apply.mjs --dry-run` lists them), then `/reload`. Reinstalling `gentle-pi` from npm also
removes every change here.
