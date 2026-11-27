import { copyFile, mkdir, rm } from "node:fs/promises";

const root = new URL("../../../", import.meta.url);
const pkg = new URL("../", import.meta.url);
const from = (path) => new URL(path, root);
const to = (path) => new URL(path, pkg);

// Preserve the relative import layout. Allowlist source files instead of
// copying directories that might contain local settings, tests or credentials.
const common = ["classify", "price-cache", "recovery", "shared-prices", "speed-cache",
  "speed-order", "speed-probe", "subrouter-prices", "thinking-level"];
const gateway = ["config", "cost-ledger", "metrics", "route", "server", "upstream"];
const copies = [
  [to("src/index.js"), "dist/index.js"],
  ...common.map(name => [from("failover-router/common/" + name + ".js"), "dist/router/common/" + name + ".js"]),
  ...gateway.map(name => [from("failover-router/opencode/src/" + name + ".js"), "dist/router/opencode/src/" + name + ".js"]),
  ...["gateway.example.json", "opencode.example.jsonc"].map(name => [from("failover-router/opencode/" + name), "examples/" + name]),
];
for (const directory of ["dist/", "examples/"]) await rm(to(directory), { recursive: true, force: true });
for (const [source, path] of copies) {
  const destination = to(path);
  await mkdir(new URL(".", destination), { recursive: true });
  await copyFile(source, destination);
}
