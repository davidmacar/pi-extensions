# Shared SubRouter tariffs
Keep this work on the existing feature branch. Price snapshots are not invoices or a usage ledger.
Risk: items 2 (credential boundary), 3 (both pricing adapters), and 4 (cross-process publication).

## Specs
- S1: “El precio debe ser algo compartido y calculado para ambas extensiones, este precio debe consultarse utilizando la clave de acceso a subrouter y consultando el coste de estos modelos.”
- S2: “Esta consulta debe hacerse periódicamente y de esta manera debe estar en el módulo compartido para que pi y opencode puedan ver el precio cuando esta llamada se realiza y obtiene los resultados.”

## Tasks
- T1 — S1, S2 — Inline: add authenticated, durable shared tariff publication and deterministic tests — implemented and locally verified (8623517).
- T2 — S1, S2 — Inline: connect both adapters, retain legacy behavior and run regression and smoke checks — implemented and locally verified in the integration commit containing this record.
- T3 — S1, S2 — Independent verifier for credential handling and cross-process publication — blocked: session Git identity no longer matches the renamed checkout.

## Log
L1. El precio debe ser algo compartido y calculado para ambas extensiones, este precio debe consultarse utilizando la clave de acceso a subrouter y consultando el coste de estos modelos. Esta consulta debe hacerse periódicamente y de esta manera debe estar en el módulo compartido para que pi y opencode puedan ver el precio cuando esta llamada se realiza y obtiene los resultados.
L2. Existing marketplace documents show a first-party endpoint with per-offer native currency. Use the relay key from the environment, never a management token. Actual account billing and model spend are outside this tariff change. Explorer could not register the renamed checkout: session Git identity changed. No live credentials read or used.
L3. RED: shared module absent, cross-adapter test chose the configured channel instead of the cheapest, and the pagination test observed only one unpaginated request. GREEN: `node --test --test-timeout=5000 failover-router/common/shared-prices.test.js failover-router/opencode/test/shared-prices.test.js` exited 0 (6/6). Both Pi and the gateway published authenticated fixtures in separate cases, and the other adapter selected the same least-cost channel without issuing another query. The scheduler test advanced the clock by one hour.
L4. Full regression: router 269/269, notifier 32/32, installed OpenCode v2.0.32 Chat and Responses smoke, and Pi Channels card checks all passed. The legacy Pi startup and OpenCode public-cache tests had the same exit code, assertions and stderr on base 1663ae7 and the integration change. The independent verifier failed before running checks because the session Git identity changed on rename; independent verification remains pending. No push or merge.
