# Failover Router for OpenCode

This OpenCode v2 server plugin starts and stops the loopback failover gateway for you. It reuses the standalone gateway’s routing, shared tariffs, and local cost ledger. Pi and the standalone gateway remain supported; this package does not install or configure either of them.

## Install from a GitHub Release

1. Download the versioned `opencode-failover-router-<version>.tgz` and its `.sha256` file from the same `opencode-v<version>` release. In the download directory run:

   ```sh
   sha256sum --check opencode-failover-router-0.1.0.tgz.sha256
   mkdir -p "$HOME/.local/share/opencode-failover-router/0.1.0"
   tar -xzf opencode-failover-router-0.1.0.tgz -C "$HOME/.local/share/opencode-failover-router/0.1.0"
   ```

   Replace `0.1.0` with the downloaded version. Keep each version in its own directory so you can switch back by changing the plugin path.
2. Copy `package/examples/gateway.example.json` to a private configuration file, replace the sample channel URLs and model IDs, and set `FAILOVER_ROUTER_CONFIG` to its **absolute path** in the OpenCode server environment. Provide the local `FAILOVER_ROUTER_KEY` and the channel credentials named by `apiKeyEnv` in that environment, not in the JSON. If the gateway should refresh SubRouter tariffs, provide `SUBROUTER_API_KEY` as well.
3. Merge the `providers` block from `package/examples/opencode.example.jsonc` into your `opencode.jsonc` and append the extracted **package directory** to the existing `plugins` array:

   ```jsonc
   {
     "plugins": ["file:///home/you/.local/share/opencode-failover-router/0.1.0/package"]
   }
   ```

   Do not point to `index.js` or the archive. Replace the example path with your own. The provider configuration still controls model IDs and protocol; its `baseURL` must match the gateway listener.
4. Start OpenCode with the environment above, then select a configured model. With the example IDs, a standalone test is `opencode run --standalone --model failover-chat/chat-cheap "Say hello"`. A real provider may charge for this request.

The tested runtime is OpenCode `v2.0.32` on Linux. The plugin runs in the **server** process: for a managed service, set the environment where the service starts and restart it. Do not start the standalone gateway on the same address. Multiple locations loading this package with the same config in one process share a listener; separate OpenCode processes must use different ports (and matching provider URLs) or share a standalone gateway instead.

The archive is an npm-format package, but GitHub Releases are the distribution channel. Nothing is published to the npm registry by this workflow.
