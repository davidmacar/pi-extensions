#!/usr/bin/env node
/**
 * Adds the Channels card to the installed gentle-pi package.
 *
 * Why a patch script instead of a fork: Gentle Shell's rail section list is
 * closed — there is no extension seam for a new card — so a new section has to
 * be added to the package itself. The install under
 * `~/.pi/agent/npm/node_modules/gentle-pi` is a published tarball, not a
 * checkout, so this directory is the durable copy: it carries the two new
 * modules and every anchored edit, and it puts them back after `pi update`
 * replaces the package.
 *
 * Usage:
 *   node apply.mjs                 apply what is missing, idempotent
 *   node apply.mjs --check         verify the install still carries the card
 *   node apply.mjs --dry-run       say what would change, write nothing
 *   node apply.mjs --root <path>   another gentle-pi install
 *
 * Exit code 1 when an anchor is gone (the package changed upstream), so a
 * silent downgrade to a shell without the card is impossible.
 */
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const valueOf = (flag) => {
	const index = argv.indexOf(flag);
	return index >= 0 ? argv[index + 1] : undefined;
};

/**
 * Where the package is installed. `PI_PACKAGE_DIR` is Pi's own override for the
 * package directory (environment-variables.md), so a relocated install is found
 * without a flag; `GENTLE_PI_ROOT` points straight at the package.
 */
function packageRoot() {
	const explicit = valueOf("--root") ?? process.env.GENTLE_PI_ROOT;
	if (explicit) return resolve(explicit);
	const nested = join(homedir(), ".pi", "agent", "npm", "node_modules", "gentle-pi");
	const relocated = process.env.PI_PACKAGE_DIR ? resolve(process.env.PI_PACKAGE_DIR) : undefined;
	if (!relocated) return nested;
	for (const candidate of [join(relocated, "node_modules", "gentle-pi"), join(relocated, "gentle-pi")]) {
		if (existsSync(join(candidate, "package.json"))) return candidate;
	}
	return nested;
}

const root = packageRoot();
const dryRun = has("--dry-run");
const checkOnly = has("--check");

/** The new modules, copied verbatim: they carry the contract and the rendering. */
const MODULES = ["lib/channels-sidebar-state.ts", "lib/shell-channels.ts"];

/**
 * Anchored edits. `marker` proves the edit is already present; `find` must
 * appear exactly once or the patch refuses to guess.
 */
const EDITS = [
	{
		file: "lib/shell-bar.ts",
		marker: 'from "./shell-channels.ts"',
		find: 'import { renderChangesWidget, type ChangesModel } from "./shell-changes.ts";',
		replace: [
			'import { renderChangesWidget, type ChangesModel } from "./shell-changes.ts";',
			'import { channelsSectionCount, renderChannelsRows } from "./shell-channels.ts";',
			'import type { ChannelsSidebarSnapshot } from "./channels-sidebar-state.ts";',
		].join("\n"),
		what: "import the Channels renderer",
	},
	{
		file: "lib/shell-bar.ts",
		marker: "channels?: ChannelsSidebarSnapshot;",
		find: "\tintegrations?: string[];\n}",
		replace: "\tintegrations?: string[];\n\t/** Channels measured by the failover router; absent when no extension publishes any. */\n\tchannels?: ChannelsSidebarSnapshot;\n}",
		what: "carry the snapshot on the bar model",
	},
	{
		file: "lib/shell-bar.ts",
		marker: '"integrations" | "channels"',
		find: 'export type StatusSection = "session" | "changes" | "review" | "stats" | "integrations";',
		replace: 'export type StatusSection = "session" | "changes" | "review" | "stats" | "integrations" | "channels";',
		what: "make channels a collapsible section key",
	},
	{
		file: "lib/shell-bar.ts",
		marker: 'key: "channels"',
		find: "\t// The status bar shows the permission mode once; Integrations only says",
		replace: [
			"\t// Channels: what the failover router measured for each physical model, so the",
			"\t// rail answers \"which channel would answer now, and how fast\" without a probe.",
			"\tif (model.channels && model.channels.models.length > 0) {",
			"\t\tsections.push({ key: \"channels\", header: header(\"channels\", \"Channels\", channelsSectionCount(model.channels)), rows: renderChannelsRows(model.channels, theme, width) });",
			"\t}",
			"\t// The status bar shows the permission mode once; Integrations only says",
		].join("\n"),
		what: "push the Channels section before Integrations",
	},
	{
		file: "extensions/gentle-shell.ts",
		marker: "../lib/channels-sidebar-state.ts",
		find: 'import { installSidebar, invalidateSidebar, narrowStatusOwner, SIDEBAR_BREAKPOINT, STATUS_OWNER } from "../lib/shell-sidebar-layout.ts";',
		replace: [
			'import { installSidebar, invalidateSidebar, narrowStatusOwner, SIDEBAR_BREAKPOINT, STATUS_OWNER } from "../lib/shell-sidebar-layout.ts";',
			'import { CHANNELS_SIDEBAR_EVENT, isChannelsSidebarSnapshot, type ChannelsSidebarSnapshot } from "../lib/channels-sidebar-state.ts";',
		].join("\n"),
		what: "import the event contract",
	},
	{
		file: "extensions/gentle-shell.ts",
		marker: "\tchannels?: ChannelsSidebarSnapshot;",
		find: "\tjobs?: RunningJobDisplay[];\n\tprofile?: string;",
		replace: "\tjobs?: RunningJobDisplay[];\n\tchannels?: ChannelsSidebarSnapshot;\n\tprofile?: string;",
		what: "accept the snapshot when building the bar model",
	},
	{
		file: "extensions/gentle-shell.ts",
		marker: "options.channels ? { channels: options.channels }",
		find: "\t\tintegrations: entries.filter(([key]) => key !== MODE_STATUS_KEY && key !== YOLO_STATUS_KEY).map(([, text]) => text),\n\t};",
		replace: "\t\tintegrations: entries.filter(([key]) => key !== MODE_STATUS_KEY && key !== YOLO_STATUS_KEY).map(([, text]) => text),\n\t\t...(options.channels ? { channels: options.channels } : {}),\n\t};",
		what: "pass the snapshot into the built model",
	},
	{
		file: "extensions/gentle-shell.ts",
		marker: "channels: () => ChannelsSidebarSnapshot | undefined;",
		find: '\treview: () => ReviewSidebarSnapshot | undefined;\n\ttracker: () => Pick<WorktreeChangesTracker, "model" | "unbornRoots">;',
		replace: '\treview: () => ReviewSidebarSnapshot | undefined;\n\tchannels: () => ChannelsSidebarSnapshot | undefined;\n\ttracker: () => Pick<WorktreeChangesTracker, "model" | "unbornRoots">;',
		what: "give the footer memo a channels input",
	},
	{
		file: "extensions/gentle-shell.ts",
		marker: "deps.channels(),",
		find: "\t\t\tdeps.review(),",
		replace: "\t\t\tdeps.review(),\n\t\t\tdeps.channels(),",
		what: "repaint when the snapshot changes",
	},
	{
		file: "extensions/gentle-shell.ts",
		marker: "channels: deps.channels(),",
		find: "\t\t\treview: deps.review(),\n\t\t};",
		replace: "\t\t\treview: deps.review(),\n\t\t\tchannels: deps.channels(),\n\t\t};",
		what: "lay the snapshot onto the memoized model",
	},
	{
		file: "extensions/gentle-shell.ts",
		marker: "CHANNELS_SIDEBAR_EVENT, (value) => {",
		find: "\tconst unsubscribeJobs = pi.events.on(JOBS_SIDEBAR_EVENT, (value) => {",
		replace: [
			"\tlet channels: ChannelsSidebarSnapshot | undefined;",
			"\t// Channels is machine-scoped, not session-scoped: the measurement cache is",
			"\t// shared by every session, so any of them may paint it.",
			"\tconst unsubscribeChannels = pi.events.on(CHANNELS_SIDEBAR_EVENT, (value) => {",
			"\t\tif (!isChannelsSidebarSnapshot(value)) return;",
			"\t\tchannels = value;",
			"\t\tredrawReview();",
			"\t});",
			"\tconst unsubscribeJobs = pi.events.on(JOBS_SIDEBAR_EVENT, (value) => {",
		].join("\n"),
		what: "store the snapshot and repaint on arrival",
	},
	{
		file: "extensions/gentle-shell.ts",
		marker: "channels: () => channels,",
		find: "\t\t\t\treview: () => review,\n\t\t\t\ttracker: () => tracker,",
		replace: "\t\t\t\treview: () => review,\n\t\t\t\tchannels: () => channels,\n\t\t\t\ttracker: () => tracker,",
		what: "feed the memo from the stored snapshot",
	},
	{
		file: "extensions/gentle-shell.ts",
		marker: "\t\tunsubscribeChannels();",
		find: "\t\tunsubscribeJobs();",
		replace: "\t\tunsubscribeJobs();\n\t\tunsubscribeChannels();",
		what: "unsubscribe on shutdown",
	},
	{
		file: "docs/gentle-shell.md",
		marker: "Changes → Review → Channels → Integrations",
		find: "**Todos → Jobs → Agents → Changes → Review → Integrations**",
		replace: "**Todos → Jobs → Agents → Changes → Review → Channels → Integrations**",
		what: "document the section order",
	},
	{
		file: "docs/gentle-shell.md",
		marker: "Changes, Review, Stats, Channels, Integrations",
		find: "each Status section: Changes, Review, Stats, Integrations",
		replace: "each Status section: Changes, Review, Stats, Channels, Integrations",
		what: "document the transparent-surface card list",
	},
	{
		file: "docs/gentle-shell.md",
		marker: "**Channels** appears when a channel publisher registers",
		find: "Integrations lists other extensions' statuses and says what the permission mode means without repeating it.",
		replace: [
			"**Channels** appears when a channel publisher registers (the failover router does): per physical model the channel a request would use and the fastest three with the tokens per second of the last measurement, a cooldown taking the place of the speed while a channel rests, and one mark per row — `●` in use, `⏱ 4m` cooling down, `✕` where the probe failed, `—` never measured. It disappears until a publisher sends its first snapshot.",
			"Integrations lists other extensions' statuses and says what the permission mode means without repeating it.",
		].join("\n"),
		what: "describe the Channels card in the Rail section",
	},
	{
		file: "docs/gentle-shell.md",
		marker: "- Extensions can publish channel measurements",
		find: "- The bar names the subscription it shows",
		replace: [
			"- Extensions can publish channel measurements for the rail's Channels card: emit `gentle-pi:channels-sidebar/v1` on `pi.events` with `{ schema: \"gentle-pi.channels-sidebar/v1\", measuredAt, models: [{ model, active, total, hidden, channels: [{ ref, channel, state, tokensPerSecond, measuredAt, cooldownMs?, note? }] }] }`. `state` is one of `active`, `ready`, `cooldown`, `failed`, `unmeasured`; at most three channels per model and sixteen models are painted. A malformed payload is ignored rather than crashing the shell, and the last valid snapshot stays until a new one replaces it. That is display data only: it grants no review, permission or delivery authority.",
			"- The bar names the subscription it shows",
		].join("\n"),
		what: "document the event contract",
	},
];

const fileExists = async (path) => {
	try {
		return (await stat(path)).isFile();
	} catch {
		return false;
	}
};

const problems = [];
const applied = [];
const already = [];

const packageJson = join(root, "package.json");
if (!(await fileExists(packageJson))) {
	console.error(`apply: no gentle-pi install at ${root}`);
	console.error("apply: pass --root <path> or set GENTLE_PI_ROOT");
	process.exit(1);
}
const meta = JSON.parse(await readFile(packageJson, "utf8"));
if (meta.name !== "gentle-pi") {
	console.error(`apply: ${root} is package "${meta.name}", not gentle-pi`);
	process.exit(1);
}
console.log(`apply: ${meta.name}@${meta.version} at ${root}`);

for (const module of MODULES) {
	const source = join(HERE, "files", module);
	const target = join(root, module);
	const wanted = await readFile(source, "utf8");
	const current = (await fileExists(target)) ? await readFile(target, "utf8") : undefined;
	if (current === wanted) {
		already.push(module);
		continue;
	}
	if (checkOnly) {
		problems.push(`${module}: ${current === undefined ? "missing" : "out of date"}`);
		continue;
	}
	if (!dryRun) {
		await mkdir(dirname(target), { recursive: true });
		await copyFile(source, target);
	}
	applied.push(`${module} (${current === undefined ? "added" : "updated"})`);
}

for (const edit of EDITS) {
	const path = join(root, edit.file);
	if (!(await fileExists(path))) {
		problems.push(`${edit.file}: file missing`);
		continue;
	}
	const original = await readFile(path, "utf8");
	if (original.includes(edit.marker)) {
		already.push(`${edit.file}: ${edit.what}`);
		continue;
	}
	const occurrences = original.split(edit.find).length - 1;
	if (occurrences !== 1) {
		problems.push(`${edit.file}: expected exactly one anchor for "${edit.what}", found ${occurrences}`);
		continue;
	}
	if (checkOnly) {
		problems.push(`${edit.file}: ${edit.what} is not applied`);
		continue;
	}
	if (!dryRun) await writeFile(path, original.replace(edit.find, edit.replace));
	applied.push(`${edit.file}: ${edit.what}`);
}

for (const line of applied) console.log(`apply: ${dryRun ? "would apply" : "applied"} ${line}`);
for (const line of already) console.log(`apply: already present ${line}`);

if (problems.length > 0) {
	console.error(`\napply: ${problems.length} problem(s), the package no longer matches this patch:`);
	for (const line of problems) console.error(`  - ${line}`);
	console.error("\napply: read README.md; the anchors above name the upstream lines that moved.");
	process.exit(1);
}
console.log(checkOnly ? "\napply: the Channels card is installed." : "\napply: done. /reload pi to paint the card.");
