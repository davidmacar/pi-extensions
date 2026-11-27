# OpenCode plugin package
Reuse the gateway without modifying the Pi adapter or standalone installation. Do not publish in this session.
Risk: item 2 (credential exclusion); item 5 (plugin packaging and release workflow); item 4 (listener lifecycle in the initial work unit).

## Specs
- S1: “Hazlo en una carpeta separada”
- S2: “deja documentación para que cuando se realice una publicación de una nueva versión válida de la extensión para opencode se genere un plugin nuevo.”
- S3: “Comprueba las rutas de instalaciíon que indica Opencode en su documentación oficial para las extensiones para instalar la extensión siguiendo su guía de uso, actualiza la documentación y haz los cambios necesarios de ser requeridos”
- S4: “Quiero inicialmente en GitHub pero dejalo todo preparado para distribuirlo también en npm y asegúrate de que en esta distribución no se incluyen ningún tipo de claves privadas, tokens o similares que puedan comprometer la seguridad de mis cuentas.”

## Tasks
- T1 — S1 — Inline: package the OpenCode v2 server adapter and verify the extracted artifact against OpenCode — locally verified (9a43b95).
- T2 — S2 — Inline: add the release workflow and document versioning, installation, and verification — locally verified (41059f7).
- T3 — S1, S2 — Independent verification of release gates and listener lifecycle — blocked before execution by renamed checkout identity.
- T4 — S3 — Inline: align the installation guide with local/global discovery and configured paths — locally verified against OpenCode v2.0.32 (this work unit).
- T5 — S4 — Inline: prepare npm-ready packaging without publishing, audit the exact archive for secrets, and document installation and publication — locally verified (this work unit); independent check blocked.

## Log
L1. Hazlo en una carpeta separada y deja documentación para que cuando se realice una publicación de una nueva versión válida de la extensión para opencode se genere un plugin nuevo.
L2. Target the verified OpenCode v2.0.32 loader. Keep provider configuration explicit and the standalone gateway supported. An explorer launch failed before execution because the session Git identity still points at the old checkout.
L3. RED: the package test could not find the manifest. Native smoke initially failed with a file path, then with a directory whose only entrypoint was under dist. v2.0.32 resolves configured local packages via a root index or server entry. GREEN: extracted package opens one listener for concurrent setup, shuts it down on final cleanup, and passes the package smoke for Chat 429, truncated Responses and historical Responses 524. The standalone smoke also passes.
L4. Local release rehearsal using `@opencode/cli-linux-x64@2.0.32`: package tests 2/2, router tests 386/386, generated `.tgz` checksum OK, exact archive and standalone native smokes exit 0. Workflow YAML and Bash syntax passed a local structural check. The independent verifier could not register the renamed checkout; GitHub Actions and the remote upload were not exercised because nothing was published.
L5. Initial local slice ends at 41059f7: 9a43b95 (plugin packaging and smoke), then 41059f7 (release script, CI and guides). S3–S4 are a separate work unit; no remote delivery has been requested.
L6. The official OpenCode Plugins and Building Plugins docs describe package names or local plugin directories in `opencode.json(c)`; relative paths resolve from the config file, and `.opencode/plugins/` and the global config `plugins/` directories are auto-discovered. GitHub-release `.tgz` assets are not npm package-name installs: extract them into an auto-discovered directory or configure their extracted directory explicitly. Keep GitHub Releases as the active channel.
L7. The user requested preparing an npm distribution in addition to GitHub without publishing now, and requiring an archive audit for private keys, tokens, or similar account-credential material. The configured explorer could not start because the runtime could not register a worktree after the checkout Git identity changed.

L8. S3: the release README uses the official project and global discovery directories plus an explicit directory path option. Native OpenCode v2.0.32 loaded the exact release archive by all three routes (isolated global XDG config, project discovery, and a relative path resolved from `.opencode/opencode.jsonc`).
L9. S4: release packing audits the actual npm tarball before it produces release assets. The three package tests passed, including synthetic credentials and an unexpected `.env` in the archive. The real package contained 21 allowlisted files, passed the credential-pattern audit and SHA-256 verification, and installed offline via npm with scripts disabled. The standalone native smoke also passed. A simulated npm publication exited 0 with `--dry-run --offline --ignore-scripts` and isolated empty npm configuration; no real registry operation was attempted. The independent verifier could not register a worktree after the checkout rename and ran no probes. Keep that review and remote release validation pending.
