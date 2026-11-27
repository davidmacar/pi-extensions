# OpenCode failover gateway
Development branch only; keep Pi as a standalone adapter, without adding a gateway hop.
Risk: item 2 (local listener and upstream credentials); item 4 (shared cooldown and cancellation).

## Specs
- S1: “debe pasar a llamarse de pi-extensions a ai-extensions. El nombre de pi-failover-router pasará a llamarse failover-router.”
- S2: “aplicaremos la opción B para poder crear la mejor versión para OpenCode y que replique el máximo de funcionalidades de las de PI sin contar con la tarjeta de visualización, la cual no es necesaria y se puede prescindir de ella.”
- S3: “es vital que no se modifiquen las funcionalidadesd e PI ni su eficiencia, es decir, pueden modularizarse y extraerse sus operaciones para ser compartidas de la mejor manera posible pero la implementación de esta nueva extensión no debe suponer un detrimento de las funcionalidades ya existentes en PI. De esta forma, si es necesario duplicar piezas para ser consecuente con esto, sea hará.”
- S4: “quiero que se muestren en carpetas independientes los ficheros destinados a opencode, los destinados a PI y los utilizados en comúm.”
- S5: “Hay una versión de opencode disponible en el sistema, puedes actualizarla y gestionarla completamente y realizar todas las pruebas necesarias para asegurarte de que todas las funcionalidades son replicadas correctamente y no se cometen errores pasando todos los tests.”
- S6: “Crea una rama de desarrollo para realizar todos estos cambios y no mergees a master sin que yo lo indique, eso si, haz todos los commits que consideres necesarios para mantener un historial que puedas trackear si lo ves necesario.”

## Tasks
- T1 — S1, S3, S4, S6 — Inline: separate Pi and common; preserve legacy entrypoints and prove regression coverage — done (42599a2).
- T2 — S2, S4 — Inline: OpenCode gateway, bounded recovery, compatible streaming and native protocol passthrough — done (596db7b); independent findings corrected and locally verified.
- T3 — S2, S5 — Inline: price/speed integration, setup docs and actual OpenCode smoke — verified (metrics: 36d4d54; smoke: delivery work unit).
- T4 — S1, S5, S6 — Independent verifier and final checkout rename with Pi compatibility — done; this delivery work unit.

## Log
L1. Partiendo de esta lígica vamos a cambiar también la estructura de esta carpeta, debe pasar a llamarse de pi-extensions a ai-extensions. El nombre de pi-failover-router pasará a llamarse failover-router.
Dentro de failover-router ahora aplicaremos la opción B para poder crear la mejor versión para OpenCode y que replique el máximo de funcionalidades de las de PI sin contar con la tarjeta de visualización, la cual no es necesaria y se puede prescindir de ella.
Para realizar cualquier tipo de implementación es vital que no se modifiquen las funcionalidadesd e PI ni su eficiencia, es decir, pueden modularizarse y extraerse sus operaciones para ser compartidas de la mejor manera posible pero la implementación de esta nueva extensión no debe suponer un detrimento de las funcionalidades ya existentes en PI. De esta forma, si es necesario duplicar piezas para ser consecuente con esto, sea hará.
También quiero que se muestren en carpetas independientes los ficheros destinados a opencode, los destinados a PI y los utilizados en comúm.
Hay una versión de opencode disponible en el sistema, puedes actualizarla y gestionarla completamente y realizar todas las pruebas necesarias para asegurarte de que todas las funcionalidades son replicadas correctamente y no se cometen errores pasando todos los tests.
Crea una rama de desarrollo para realizar todos estos cambios y no mergees a master sin que yo lo indique, eso si, haz todos los commits que consideres necesarios para mantener un historial que puedas trackear si lo ves necesario.

L2. Baseline on master: Pi router 236/236 (exit 0). OpenCode reports v2.0.32.
L3. Pi regression suite after 42599a2: 236/236 (exit 0). Legacy entrypoint resolves to the same adapter and its patch script exists. Rename-dominant local work unit; do not merge or publish.
L4. Gateway work unit 596db7b (630 authored lines including tests). Its rollback boundary is the OpenCode source and tests; it does not touch Pi. Independent verifier ran T2 and found SSE framing, capped error classification, credential reflection, and explicit Responses storage defects. Regression RED: focused suite exit 1. After fixes: 19/19 gateway checks exit 0. Isolated `opencode models --standalone` listed all three example models on v2.0.32.
L5. Metrics work unit 36d4d54 (534 authored lines including tests). Regression RED covered lost concurrent probes, incorrect protocol selection and duplicate marketplace refreshes; GREEN 7/7. The HTTP integration also verified marketplace-based routing and cached prices across a restart. Metrics are opt-in and isolated from Pi.
L6. `npm --prefix failover-router run test:opencode:smoke` exited 0 with the installed OpenCode v2.0.32. Chat: HTTP 429 then fallback. Responses: incomplete SSE containing a tool call then fallback. Both performed exactly one completed read and passed its result to the next request. No real providers or account credentials. Prior full Node check passed 262/262 (before the durable-cache restart test), notifier 32/32, Gentle Shell card verified.
L7. Renamed the single checkout to `ai-extensions`, with `pi-extensions -> ai-extensions` for existing absolute paths. Legacy router and notifier imports resolve, and the Pi patch script is present. Compared with `master`: Pi adapter body identical after normalizing import paths; 9 shared modules byte-for-byte identical. From the new checkout: router 263/263 (including 236 Pi and 27 OpenCode), notifier 32/32, Gentle Shell card verifier and two-protocol isolated OpenCode smoke all exited 0. `master` unchanged at cd0adfe; no merge or push.
