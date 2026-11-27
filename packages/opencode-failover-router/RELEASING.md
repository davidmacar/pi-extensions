# Release a new OpenCode plugin version

Each stable OpenCode extension release gets a versioned npm-format archive and SHA-256 checksum in **GitHub Releases**. A push to `master`, an unrelated release, or a prerelease does not attach a plugin. The workflow does not publish to npm; the same archive is ready for an explicitly authorized registry publication.

## Validate a candidate before release

1. Update the version in [`package.json`](package.json) using stable SemVer (for example `0.1.1`). It is independent of the OpenCode runtime version and of Pi. When changing the supported OpenCode version, update and verify the pinned runtime in the workflow and the native smoke test together.
2. From the repository root, create a local candidate. The output directory must not already exist:

   ```sh
   work=$(mktemp -d)
   npm --prefix failover-router test
   npm --prefix packages/opencode-failover-router test
   npm --prefix packages/opencode-failover-router run release:pack -- opencode-v0.1.1 "$work/release"
   (cd "$work/release" && sha256sum --check opencode-failover-router-0.1.1.tgz.sha256)
   OPENCODE_PLUGIN_TARBALL="$work/release/opencode-failover-router-0.1.1.tgz" \
     npm --prefix failover-router run test:opencode:smoke
   ```

   Use Node `>=22.19.0`, the pinned OpenCode `v2.0.32` binary on `PATH` (or set `OPENCODE_BIN`), and Linux with Bubblewrap and network namespaces for the smoke test. It loads the extracted archive through OpenCode's global and project discovery, and via a relative path in `plugins`. It uses loopback fixtures and temporary state; no real provider keys are needed.
3. Commit the version bump and the changes to release, then integrate them into `master` using the repository's normal review process. Make sure that commit includes [the release workflow](../../.github/workflows/opencode-plugin-release.yml).

## Publish on GitHub

1. Create a GitHub Release targeting the verified commit with tag **`opencode-v0.1.1`** (use your actual version). Publish it as a normal release, not a draft or prerelease. GitHub Actions must be enabled and the repository must allow adding assets to a published release.
2. The `release: published` workflow builds from the tagged commit, rejects a mismatched version, audits the exact archive, runs the router and package test suites, and loads that archive in native OpenCode. Only after all checks pass does a separate job attach:
   - `opencode-failover-router-0.1.1.tgz`
   - `opencode-failover-router-0.1.1.tgz.sha256`
3. Confirm both assets are present before sharing the release. If verification fails, the attachment job does not run. For a transient CI failure, rerun the failed jobs; if the tagged code needs a fix, release a new version rather than moving the tag. The workflow does not overwrite existing assets.

## Publish the same artifact to npm (optional)

1. Confirm that the publishing account owns or can claim `opencode-failover-router` on npm. Wait for explicit publication approval. Use an npm account with 2FA; authenticate with npm's CLI from a secure environment, not with credentials in the repository or command arguments.
2. From the repository root, download both assets from the matching GitHub Release into a separate directory. Verify the SHA-256 and run the same allowlist and credential-pattern checks CI uses:

   ```sh
   asset_dir=/absolute/path/to/downloads
   archive=opencode-failover-router-0.1.1.tgz
   (cd "$asset_dir" && sha256sum --check "$archive.sha256") &&
     node packages/opencode-failover-router/scripts/audit-tarball.mjs "$asset_dir/$archive" &&
     npm publish "$asset_dir/$archive" --dry-run --offline --ignore-scripts --access public --registry https://registry.npmjs.org/
   ```

   Review the file list and the contents of any changed examples or source files. The audit scans for known credential patterns; it cannot recognize every possible secret. Never allow `.env`, `.npmrc`, private keys, live settings, logs, or state to enter the archive. Examples must reference environment variables, not contain real credentials.
3. After review, run the same `npm publish` command **without `--dry-run` or `--offline`** on the verified `.tgz`, not on the checkout. Confirm that the published version matches the GitHub asset. For future CI automation, prefer [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/) with OIDC rather than a long-lived token; no npm publication job is enabled in this repository.

For installation and rollback, see the [plugin README](README.md).
