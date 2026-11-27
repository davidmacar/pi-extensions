# OpenCode plugin package
Reuse the gateway without modifying the Pi adapter or standalone installation. Do not publish in this session.
Risk: item 5 (plugin packaging and release workflow); item 4 (listener lifecycle).

## Specs
- S1: “Hazlo en una carpeta separada”
- S2: “deja documentación para que cuando se realice una publicación de una nueva versión válida de la extensión para opencode se genere un plugin nuevo.”

## Tasks
- T1 — S1 — Inline: package the OpenCode v2 server adapter and verify the extracted artifact against OpenCode — locally verified (9a43b95).
- T2 — S2 — Inline: add the release workflow and document versioning, installation, and verification — verified locally; this release workflow commit.
- T3 — S1, S2 — Independent verification of release gates and listener lifecycle — blocked before execution by renamed checkout identity.

## Log
L1. Hazlo en una carpeta separada y deja documentación para que cuando se realice una publicación de una nueva versión válida de la extensión para opencode se genere un plugin nuevo.
L2. Target the verified OpenCode v2.0.32 loader. Keep provider configuration explicit and the standalone gateway supported. An explorer launch failed before execution because the session Git identity still points at the old checkout.
L3. RED: the package test could not find the manifest. Native smoke initially failed with a file path, then with a directory whose only entrypoint was under dist. v2.0.32 resolves configured local packages via a root index or server entry. GREEN: extracted package opens one listener for concurrent setup, shuts it down on final cleanup, and passes the package smoke for Chat 429, truncated Responses and historical Responses 524. The standalone smoke also passes.
L4. Local release rehearsal using `@opencode/cli-linux-x64@2.0.32`: package tests 2/2, router tests 386/386, generated `.tgz` checksum OK, exact archive and standalone native smokes exit 0. Workflow YAML and Bash syntax passed a local structural check. The independent verifier could not register the renamed checkout; GitHub Actions and the remote upload were not exercised because nothing was published.
L5. Local work units: 9a43b95 (plugin packaging and smoke); this release workflow commit (release script, CI and guides).
