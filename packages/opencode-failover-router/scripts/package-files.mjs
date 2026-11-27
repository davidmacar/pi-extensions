export const commonFiles = [
  "classify", "price-cache", "recovery", "shared-prices", "speed-cache",
  "speed-order", "speed-probe", "subrouter-prices", "thinking-level",
];
export const gatewayFiles = ["config", "cost-ledger", "metrics", "route", "server", "upstream"];
export const exampleFiles = ["gateway.example.json", "opencode.example.jsonc"];

// This is the reviewed artifact boundary. Keep build, `files`, and the release
// audit aligned; never add configuration or credential-bearing local state.
export const packageFiles = new Set([
  "package.json", "README.md", "index.js", "dist/index.js",
  ...commonFiles.map(name => `dist/router/common/${name}.js`),
  ...gatewayFiles.map(name => `dist/router/opencode/src/${name}.js`),
  ...exampleFiles.map(name => `examples/${name}`),
]);
