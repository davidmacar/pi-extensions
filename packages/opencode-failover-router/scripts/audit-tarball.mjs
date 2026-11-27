import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { packageFiles } from "./package-files.mjs";

const credentialPatterns = [
  ["private-key-block", /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/],
  ["aws-access-key-id", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ["github-token", /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,})\b/],
  ["npm-token", /\bnpm_[A-Za-z0-9]{30,}\b/],
  ["slack-token", /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/],
  ["google-api-key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["provider-api-key", /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{32,}\b/],
  ["literal-credential", /\b(?:api[_ -]?key|access[_ -]?token|auth[_ -]?token|client[_ -]?secret|private[_ -]?key|password)["']?\s*[:=]\s*["'`][A-Za-z0-9+/_=.@!-]{16,}["'`]/i],
  ["url-credentials", /https?:\/\/[^\s/@:"'<>]+:[^\s/@"'<>]+@/i],
];

function audit(archive) {
  const members = [...packageFiles].map(path => `package/${path}`);
  const expected = new Set(members);
  const directories = new Set(members.flatMap(member => member.split("/").slice(0, -1).map((_, index, parents) => parents.slice(0, index + 1).join("/") + "/")));
  const list = flag => execFileSync("tar", [flag, archive], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trimEnd().split("\n");
  const paths = list("-tzf");
  const metadata = list("-tvzf");
  if (paths.length !== metadata.length || new Set(paths).size !== paths.length) {
    throw new Error("Malformed or duplicate package entries");
  }
  for (const [index, path] of paths.entries()) {
    const type = metadata[index][0];
    if (directories.has(path) && type === "d") continue;
    if (!expected.delete(path) || type !== "-") throw new Error("Unexpected package entry or non-regular file");
  }
  if (expected.size) throw new Error(`Missing required package path: ${[...expected][0]}`);
  for (const path of members) {
    const bytes = execFileSync("tar", ["-xOzf", archive, path], { stdio: ["ignore", "pipe", "pipe"] });
    const text = bytes.toString("utf8");
    if (bytes.includes(0) || !Buffer.from(text, "utf8").equals(bytes)) {
      throw new Error(`Expected UTF-8 text in ${path}`);
    }
    for (const [rule, pattern] of credentialPatterns) {
      if (pattern.test(text)) throw new Error(`Secret-like credential content in ${path}: ${rule}`);
    }
  }
  return members.length;
}

if (process.argv.length !== 3 || !process.argv[2]) {
  console.error("Usage: node scripts/audit-tarball.mjs <package.tgz>");
  process.exitCode = 2;
} else {
  try {
    const count = audit(resolve(process.argv[2]));
    console.log(`OK: ${count} package files; allowlist and credential-pattern audit passed`);
  } catch (error) {
    // Do not print archive entry names we did not allow, tar diagnostics, or matched values.
    console.error(error.status != null || error.code ? "Cannot read package archive" : error.message);
    process.exitCode = 1;
  }
}
