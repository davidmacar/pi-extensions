# Hourly model price and speed refresh
Feature: keep configured router channels free of obsolete cache data and refresh model speed/pricing while Pi is active.
Scope: `pi-failover-router` plus its documented SubRouter marketplace integration; no credential reads or delivery actions.
Risk: item 3 (dynamic cost ordering changes shared chain routing), item 5 (external marketplace integration and active-session timers).

## Specs

S1. User request: "1. Elimina las entradas antiguas de gpt-6.1.sol" Remove stale `gpt-6.1-sol` entries from the active router speed cache and prevent old/unconfigured refs from being retained on subsequent writes.

S2. User request: "2. En caso de que un canal falle, su calculo de velocidad debe de ser inexistente, nulo, o el valor que haga que no se tenga en cuenta y deba volver a ser calculado y posicionado al final de la chain." A failed speed probe invalidates its prior speed, causes that channel to be unranked, eligible for the next probe, and placed at the end of the configured chain until a successful measurement.

S3. User request: "3. Haz que las respuestas sean algo más largas, de 50 tokens para que pueda medirse mejor los tokens por segundo." Speed probes request up to 50 output tokens.

S4. User request: "4. La extensión debe hacer cálculos de precios obteniendo el precio de los modelos que hay configurados, para esto pueden usarse las operaciones que ya están configuradas en otros proyectos como Apps/ai-model-tester. Accediendo a Subrouter para obtener la información de precio de cada modelo y canal que lo proveee." Fetch marketplace prices for each physical model/channel in configured router chains. User-selected ranking rule: order `*-barato` by lowest input price, preserving configured order for ties. Cache prices and publish derived prices to the router's visible configuration/diagnostics; use no credentials if public API suffices, and never read credential files.

S5. User request: "Esta comprobación debe realizazrse cada hora y solo si se está usando alguna sesión de PI, si no se está usando ninguna sesión de PI no es necesario que se actualice en segundo plano. De esta forma, se haría un cálculo al inicio de la sesión, otro cálculo pasada 1h de sesión, el siguiente a la siguiente hora, etc. Si se cierra la sesión, se deja de hacer cálculos." Refresh prices immediately at session start, then once per hour while the Pi extension runtime/session remains active. Do not run background refresh when no active Pi runtime/session remains; stop timers on `session_shutdown`. No interval is required for speed measurement unless specified by existing behavior.

## Allowed edit surfaces

pi-failover-router/lib/speed-cache.js
pi-failover-router/lib/speed-probe.js
pi-failover-router/lib/speed-order.js
pi-failover-router/lib/channels-snapshot.js
pi-failover-router/test/channels-snapshot.test.js
pi-failover-router/test/speed.test.js
pi-failover-router/test/router.test.js
pi-failover-router/README.md
pi-failover-router/lib/price-cache.js
pi-failover-router/lib/subrouter-prices.js
pi-failover-router/index.js
pi-failover-router/test/prices.test.js
pi-failover-router/docs/sol-setup.md

## Tasks

T1 | S1-S3 | gentle-ai-worker | done | Speed-cache pruning, failure invalidation/reorder, 50-token probe, tests/docs. RED/GREEN recorded; parent full suite passes. No commit (task mwse7sbu-3-7t11).
T2 | S4-S5 | gentle-ai-worker | done | Public SubRouter price fetch/cache, cost-chain input-price ordering, hourly session lifecycle, tests/docs. Parent added 10s abortable fetch timeout. No commit (task mwsem3jr-4-e9hd).
T3 | S1-S5 | gentle-ai-verify + parent | blocked | Parent fixed initial findings; first cost-route selection now waits for session-start price refresh and fetches concurrently with per-request 10s timeout. Focused first-route test 1/1; sequential router+prices 56/56 before final wait change. Latest full `npm test`: 234/234; `git diff --check` passes. Independent recheck ended `provider_unavailable`; no retry per limit, so independent proof after final fixes unavailable. No commit.

## Log

L1. Original request: "Para los detalles que me has comentado: \n1. Elimina las entradas antiguas de gpt-6.1.sol\n2. En caso de que un canal falle, su calculo de velocidad debe de ser inexistente, nulo, o el valor que haga que no se tenga en cuenta y deba volver a ser calculado y posicionado al final de la chain. \n3. Haz que las respuestas sean algo más largas, de 50 tokens para que pueda medirse mejor los tokens por segundo. \n4. La extensión debe hacer cálculos de precios obteniendo el precio de los modelos que hay configurados, para esto pueden usarse las operaciones que ya están configuradas en otros proyectos como Apps/ai-model-tester. Accediendo a Subrouter para obtener la información de precio de cada modelo y canal que lo proveee. Esta comprobación debe realizazrse cada hora y solo si se está usando alguna sesión de PI, si no se está usando ninguna sesión de PI no es necesario que se actualice en segundo plano. De esta forma, se haría un cálculo al inicio de la sesión, otro cálculo pasada 1h de sesión, el siguiente a la siguiente hora, etc. Si se cierra la sesión, se deja de hacer cálculos."
L2. Decision: User selected "Menor precio de entrada". Sort cost-ordered chains by current input price ascending, stable configured-order ties. Price API confirmed public through GET `https://subrouter.ai/api/marketplace/models?model=<model-id>&sort=price_asc`; the API data is per channel/provider. Do not read `models.json` or token files.
L3. Evidence from explorer: speed cache is loaded at `index.js:217` and persisted wholesale at `index.js:729-736`; speed refs are available at `index.js:717-721`; failures retain samples in `lib/speed-cache.js:180-195`; probes cap is `lib/speed-probe.js:18`; session hooks at `index.js:789-802`, current timer is speed-only and reset at shutdown. Price API is public, wraps results in `{success,data}`, includes `model_name`, `provider_slug`, `input_price`, `output_price`, `price_currency`; currency conversion must be explicit. Pi extension runtime emits `session_start` and `session_shutdown`; no external credential needed.
