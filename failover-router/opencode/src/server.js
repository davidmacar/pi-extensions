import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeGatewayConfig } from "./config.js";
import { createMetrics } from "./metrics.js";
import { routeGatewayRequest } from "./route.js";

export async function startGateway({ config, env = process.env, fetchImpl = fetch, now = Date.now, sleep,
  stateDir = env.FAILOVER_ROUTER_STATE_DIR ?? resolve(env.XDG_STATE_HOME || resolve(homedir(), ".local/state"), "ai-extensions", "failover-router"),
  log = () => {}, port } = {}) {
  config = normalizeGatewayConfig(config, { env });
  const metrics = config.probeSpeed || config.refreshMarketplace ? createMetrics({ config, stateDir, fetchImpl, now, log }) : undefined;
  const channelsState = new Map();
  const active = new Set();
  let closing = false;
  const server = createServer({ headersTimeout: 10_000, requestTimeout: 120_000 }, (request, response) => {
    if (closing || active.size >= 8) {
      response.writeHead(503, { connection: "close" }); response.end(); return;
    }
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end('{"status":"ok"}'); return;
    }
    const controller = new AbortController();
    const abort = () => { if (!response.writableFinished) controller.abort(); };
    request.once("aborted", abort);
    response.once("close", abort);
    active.add(controller);
    void routeGatewayRequest({ request, response, config, signal: controller.signal, fetchImpl, channelsState,
      now, sleep, prepare: metrics?.prepare, getMetrics: metrics?.getMetrics, log }).catch(() => {
      if (controller.signal.aborted || response.destroyed) return;
      log("failover-router: gateway request failed");
      if (!response.headersSent) response.writeHead(502, { "content-type": "application/json" });
      response.end('{"error":{"message":"Gateway request failed","type":"server_error"}}');
    }).finally(() => {
      active.delete(controller);
      request.off("aborted", abort);
      response.off("close", abort);
    });
  });
  try {
    await new Promise((ready, fail) => {
      server.once("error", fail);
      server.listen({ host: config.listen.host, port: port ?? config.listen.port }, () => { server.off("error", fail); ready(); });
    });
  } catch (error) {
    metrics?.close();
    throw error;
  }
  const { port: boundPort } = server.address();
  const host = config.listen.host === "::1" ? "[::1]" : config.listen.host;
  let closed;
  return { url: `http://${host}:${boundPort}`, close() {
    if (closed) return closed;
    closing = true;
    metrics?.close();
    for (const controller of active) controller.abort();
    closed = new Promise((done, fail) => server.close(error => error ? fail(error) : done()));
    server.closeAllConnections();
    return closed;
  } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const file = process.argv[2] ?? process.env.FAILOVER_ROUTER_CONFIG;
    if (!file) throw new Error("Usage: node opencode/src/server.js <gateway-config.json>");
    let config;
    try { config = JSON.parse(readFileSync(file, "utf8")); }
    catch { throw new Error("Cannot read gateway configuration as JSON"); }
    const gateway = await startGateway({ config, log: console.error });
    console.error(`failover-router: OpenCode gateway listening at ${gateway.url}`);
    const shutdown = () => { void gateway.close().catch(() => { process.exitCode = 1; }); };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  } catch (error) {
    console.error(`failover-router: ${error.message}`);
    process.exitCode = 1;
  }
}
