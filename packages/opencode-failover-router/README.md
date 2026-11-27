# Failover Router for OpenCode

This OpenCode v2 server plugin starts and stops the loopback failover gateway for you. It reuses the standalone gateway’s routing, shared tariffs, and local cost ledger. It does not install or configure Pi or the standalone gateway. The installation paths below follow the [official OpenCode plugin guide](https://opencode.ai/docs/plugins/) and were tested on Linux with OpenCode `v2.0.32`.

## Install from a GitHub Release

1. Download `opencode-failover-router-<version>.tgz` and its `.sha256` file from the same [GitHub Release](https://github.com/davidmacar/pi-extensions/releases) tagged `opencode-v<version>`.
2. Choose **one** of OpenCode's [auto-discovery locations](https://opencode.ai/docs/plugins/#discover):

   | Scope | Extract the package to | Put provider settings in |
   | --- | --- | --- |
   | Global | `~/.config/opencode/plugins/opencode-failover-router/` | `~/.config/opencode/opencode.jsonc` |
   | One project | `<project>/.opencode/plugins/opencode-failover-router/` | `<project>/opencode.jsonc` or `<project>/.opencode/opencode.jsonc` |

   If `XDG_CONFIG_HOME` is set, use `$XDG_CONFIG_HOME/opencode` instead of `~/.config/opencode`. From the download directory, verify and extract the archive (replace `0.1.0` with the release version):

   ```sh
   archive=opencode-failover-router-0.1.0.tgz
   plugins_dir="${XDG_CONFIG_HOME:-$HOME/.config}/opencode/plugins"
   # For a project install, set plugins_dir to /absolute/path/to/project/.opencode/plugins instead.
   plugin_dir="$plugins_dir/opencode-failover-router"
   sha256sum --check "$archive.sha256" &&
     mkdir -p "$plugins_dir" && mkdir "$plugin_dir" &&
     tar -xzf "$archive" -C "$plugin_dir" --strip-components=1
   ```

   The destination must be new; `package.json` and `index.js` should be directly inside `opencode-failover-router/`. No `plugins` entry is needed for this layout. Do not keep two versions in an auto-discovered `plugins/` directory. For an upgrade or rollback, stop OpenCode, move the current directory outside the discovery path, then extract or restore the desired version at the same path.
3. Follow [Configure the gateway](#configure-the-gateway).

### Use an explicit path instead

You can extract the package outside the auto-discovery directories and append its directory to `plugins` in `opencode.jsonc`:

```jsonc
{
  "plugins": ["../local-plugins/opencode-failover-router"]
}
```

In this example, the config is `<project>/.opencode/opencode.jsonc` and the package is `<project>/local-plugins/opencode-failover-router/`. Relative paths resolve from the config file, not the shell. Absolute paths and `file://` URLs are also accepted. The entry must point to the directory containing `package.json`, not `index.js` or the `.tgz`. `opencode plugin add` does not accept GitHub Release tarballs.

## Configure the gateway

1. Copy `examples/gateway.example.json` from the extracted package to a private configuration file. Replace the sample channel URLs and model IDs and set `FAILOVER_ROUTER_CONFIG` to the file's **absolute path** in the OpenCode server environment.
2. Set `FAILOVER_ROUTER_KEY` and the upstream credentials named by `apiKeyEnv` in that same environment, not in JSON or the plugin directory. To enable SubRouter tariff refresh, opt in via `refreshMarketplace` and provide `SUBROUTER_API_KEY` in the server environment. Never commit the live settings or credentials.
3. Merge the `providers` block from the package's `examples/opencode.example.jsonc` into your existing config. Its `baseURL` must match the gateway listener. Restart OpenCode and select a configured model. With the example IDs, `opencode run --standalone --model failover-chat/chat-cheap "Say hello"` checks the connection; a real provider may charge for the request.

Configure the environment on the machine and in the process where the **OpenCode server** runs. Do not start the standalone gateway on the same address. Separate OpenCode processes must use different listener ports (and matching provider URLs), or share a standalone gateway instead.

## npm installation (after publication)

GitHub Releases are the initial distribution channel. Once the package is published to npm, remove any local copy from OpenCode's discovery or configuration, then install a pinned version with `opencode plugin add opencode-failover-router@0.1.0`. Alternatively, add `"opencode-failover-router@0.1.0"` to `plugins` in `opencode.jsonc`. Use the published version and configure the gateway as above. The [repository examples](https://github.com/davidmacar/pi-extensions/tree/master/failover-router/opencode) are also available if you installed by name.
