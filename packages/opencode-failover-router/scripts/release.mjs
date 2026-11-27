import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile, copyFile, constants } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const [tag, output] = process.argv.slice(2);
const pkg = new URL("../", import.meta.url);
const { name, version } = JSON.parse(await readFile(new URL("package.json", pkg), "utf8"));
if (process.argv.length !== 4 || !output || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version) || tag !== `opencode-v${version}`) {
  console.error("Usage: node scripts/release.mjs opencode-v<package.json version> <new-output-directory> (stable versions only)");
  process.exit(1);
}
const dir = resolve(output);
const filename = `${name}-${version}.tgz`;
const scratch = await mkdtemp(join(tmpdir(), "opencode-release-"));
try {
  execFileSync("npm", ["pack", "--pack-destination", scratch], { cwd: pkg, stdio: ["ignore", 2, 2] });
  const packed = join(scratch, filename);
  const digest = createHash("sha256").update(await readFile(packed)).digest("hex");
  await mkdir(dir); // An existing release directory must not be overwritten.
  await copyFile(packed, join(dir, filename), constants.COPYFILE_EXCL);
  await writeFile(join(dir, `${filename}.sha256`), `${digest}  ${filename}\n`, { flag: "wx" });
  console.log(join(dir, filename));
} finally {
  await rm(scratch, { recursive: true, force: true });
}
