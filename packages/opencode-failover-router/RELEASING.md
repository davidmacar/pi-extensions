# Release a new OpenCode plugin version

Each stable OpenCode extension release gets a versioned npm-format archive and SHA-256 checksum in **GitHub Releases**. A push to `master`, an unrelated release, or a prerelease does not attach a plugin. The workflow does not publish to the npm registry.

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

   Use Node `>=22.19.0`, the pinned OpenCode `v2.0.32` binary on `PATH` (or set `OPENCODE_BIN`), and Linux with Bubblewrap and network namespaces for the smoke test. The smoke uses the extracted archive, simulated loopback providers, and temporary state; it needs no provider keys.
3. Commit the version bump and the changes to release, then integrate them into `master` using the repository's normal review process. Make sure that commit includes [the release workflow](../../.github/workflows/opencode-plugin-release.yml).

## Publish on GitHub

1. Create a GitHub Release targeting the verified commit with tag **`opencode-v0.1.1`** (use your actual version). Publish it as a normal release, not a draft or prerelease. GitHub Actions must be enabled and the repository must allow adding assets to a published release.
2. The `release: published` workflow builds from the tagged commit, rejects a mismatched version, runs the router and package test suites, and executes the **same archive** in native OpenCode. Only after all checks pass does a separate job attach:
   - `opencode-failover-router-0.1.1.tgz`
   - `opencode-failover-router-0.1.1.tgz.sha256`
3. Confirm both assets are present before sharing the release. If verification fails, the attachment job does not run. For a transient CI failure, rerun the failed jobs; if the tagged code needs a fix, release a new version rather than moving the tag. The workflow does not overwrite existing assets.

For installation and rollback, see the [plugin README](README.md).
