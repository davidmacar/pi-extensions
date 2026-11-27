import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { startGateway } from "./router/opencode/src/server.js";

const gateways = new Map();

async function boot(path) {
  let config;
  try { config = JSON.parse(await readFile(path, "utf8")); }
  catch { throw new Error("Cannot read FAILOVER_ROUTER_CONFIG as JSON"); }
  try { return await startGateway({ config, log: console.error }); }
  catch (error) {
    if (error.code === "EADDRINUSE") {
      throw new Error("Failover gateway port in use. Stop the standalone gateway or configure a separate port and baseURL.");
    }
    throw error;
  }
}

// OpenCode v2 accepts the same definition object returned by Plugin.define.
export default {
  id: "opencode-failover-router",
  async setup() {
    const path = process.env.FAILOVER_ROUTER_CONFIG;
    if (!path || !isAbsolute(path)) throw new Error("Set FAILOVER_ROUTER_CONFIG to an absolute gateway JSON path");
    let entry = gateways.get(path);
    // A new instance may load while the last instance is still closing.
    while (entry?.closing) {
      await entry.closing;
      entry = gateways.get(path);
    }
    if (!entry) {
      entry = { users: 0, starting: boot(path) };
      gateways.set(path, entry);
    }
    entry.users++;
    let gateway;
    try { gateway = await entry.starting; }
    catch (error) {
      if (gateways.get(path) === entry) gateways.delete(path);
      throw error;
    }
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      if (--entry.users === 0) {
        entry.closing = gateway.close().finally(() => gateways.delete(path));
        await entry.closing;
      }
    };
  },
};
