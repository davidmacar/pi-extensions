# OpenCode per-channel cost ledger and failure matrix
Keep the user's scope limited to utility 1; do not extend this into UI, telemetry, or Pi billing changes.
Risk: items 2 (provider/request metadata reaches durable cost records), 3 (gateway error-classification and response path), and 4 (client abort and shutdown ordering).

## Specs
- S1: “Solo quiero imlpementar la 1 y que una vez termines de implementarla realices pruebas exhaustivas con todos los fallos que he registrado y que se tienen y tenían en cuenta en pi para simularlos en OpenCode y comprobar que todo funciona correctamente. Al finalizar todo dame una guía de como instalar cada extensión.”
- S2: “la 1” — Estimate and record the cost of each OpenCode gateway attempt using the responding channel's usage and shared SubRouter tariff, explicitly distinguishing missing usage/rates from zero cost.
- S3: Exercise OpenCode failover against all failure examples and kinds already covered by Pi classifier/recovery tests; prove rotatable errors rotate, request-shaped/unknown errors do not, and budgets/cooldowns work. No real upstreams or credentials.
- S4: Provide installation steps for Pi and OpenCode and state feature boundaries.

## Tasks
- T1 — S1, S2 — Inline: parse usage from Chat/Responses and append private per-attempt cost estimates; deterministic tests — verified; see cost ledger commit in L5.
- T2 — S1, S3 — Inline: exercise Pi's historic errors, classification boundaries and recovery limits through the OpenCode gateway — verified; see incident replay commit in L5.
- T3 — S1, S2 — Independent review of cost-ledger data handling — blocked before execution: the verifier could not register the renamed checkout (session Git identity changed).
- T4 — S4 — Installation guide for both runtimes and final suites — verified; this documentation commit.

## Log
L1. Solo quiero imlpementar la 1 y que una vez termines de implementarla realices pruebas exhaustivas con todos los fallos que he registrado y que se tienen y tenían en cuenta en pi para simularlos en OpenCode y comprobar que todo funciona correctamente. Al finalizar todo dame una guía de como instalar cada extensión.
L2. RED: ledger import did not exist; gateway accounting cases exposed missing usage and incorrect fixture assumptions. GREEN: targeted suite 134/134, including reported usage for a failed call and a successful fallback at their distinct fetched tariffs in Chat and Responses, abort/shutdown, partial usage, and private ledger path checks.
L3. Historical HTTP replay RED: 48/52; the two 524 variants and the Responses terminal-error wording were not recognized, and a safety-filter fixture was missing its recorded `safety_filter` prefix. Gateway-only normalization restored the expected behavior while keeping request-error precedence. Final: 102 HTTP protocol/error combinations and five recovery scenarios. Native v2.0.32 loopback smoke verified Chat 429, Responses truncation, and historical Responses HTTP 524, including a single tool execution and matching ledger records. No credentials or remote providers used.
L4. Final regression: router 386/386, Telegram notifier 32/32, Pi Channels verifier and native OpenCode smoke all exited 0. Pi and shared runtime files are unchanged relative to d8b83ff. Independent verification is still unrun due to the session registration error. No push or merge.
L5. Local work units: 38160e0 adds the private ledger (OpenCode source and accounting tests only; isolated staged unit passed 19/19); e0ac33f adds the OpenCode-only 524/Responses normalization, two-protocol failure matrix, and native smoke assertions. The installation guide and evidence are a separate documentation unit. Differential check against d8b83ff: health, model listing, unauthorized and invalid request agreed in stdout, stderr and exit code, with zero provider dispatches.
