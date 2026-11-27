import { copyFile, mkdir, rm } from "node:fs/promises";
import { commonFiles, exampleFiles, gatewayFiles } from "./package-files.mjs";

const root = new URL("../../../", import.meta.url);
const pkg = new URL("../", import.meta.url);
const from = (path) => new URL(path, root);
const to = (path) => new URL(path, pkg);

// Preserve the relative import layout. Allowlist source files instead of
// copying directories that might contain local settings, tests or credentials.
const copies = [
  [to("src/index.js"), "dist/index.js"],
  ...commonFiles.map(name => [from("failover-router/common/" + name + ".js"), "dist/router/common/" + name + ".js"]),
  ...gatewayFiles.map(name => [from("failover-router/opencode/src/" + name + ".js"), "dist/router/opencode/src/" + name + ".js"]),
  ...exampleFiles.map(name => [from("failover-router/opencode/" + name), "examples/" + name]),
];
for (const directory of ["dist/", "examples/"]) await rm(to(directory), { recursive: true, force: true });
for (const [source, path] of copies) {
  const destination = to(path);
  await mkdir(new URL(".", destination), { recursive: true });
  await copyFile(source, destination);
}
