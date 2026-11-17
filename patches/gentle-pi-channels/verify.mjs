#!/usr/bin/env node
/**
 * Renders the installed Channels card outside Pi and checks what it paints.
 *
 * Node refuses to strip TypeScript inside node_modules, and the package's own
 * imports of host-provided modules only resolve inside Pi. So this copies `lib/`
 * and `scripts/` to a scratch directory, stubs the two modules whose graph needs
 * the running host (`nan-provider`, `background-jobs-tools`), and imports the
 * real `renderShellStatusSections` through jiti — the same loader Pi uses. What
 * is asserted below is therefore the package's own section renderer with the
 * patch applied, not a reimplementation of it.
 *
 * Usage: node verify.mjs [--root <path>] [--print]
 */
import { execFile } from "node:child_process";
import { cp, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const argv = process.argv.slice(2);
const valueOf = (flag) => {
	const index = argv.indexOf(flag);
	return index >= 0 ? argv[index + 1] : undefined;
};
const root = resolve(valueOf("--root") ?? process.env.GENTLE_PI_ROOT ?? join(homedir(), ".pi", "agent", "npm", "node_modules", "gentle-pi"));
const print = argv.includes("--print");

/** The host packages the renderer imports, which only exist inside Pi. */
function hostRoot() {
	const candidates = [
		process.env.PI_CODING_AGENT_ROOT,
		join(homedir(), ".local", "lib", "node_modules", "@earendil-works", "pi-coding-agent"),
		join(homedir(), ".pi", "agent", "npm", "node_modules", "@earendil-works", "pi-coding-agent"),
	].filter(Boolean);
	const found = candidates.find((candidate) => existsSync(join(candidate, "node_modules", "jiti", "lib", "jiti.mjs")));
	if (!found) {
		console.error("verify: cannot find the Pi install that provides jiti and @earendil-works/pi-tui");
		console.error("verify: set PI_CODING_AGENT_ROOT to the pi-coding-agent package directory");
		process.exit(1);
	}
	return found;
}

const fixture = {
	schema: "gentle-pi.channels-sidebar/v1",
	measuredAt: 1794937772447,
	models: [
		{
			model: "deepseek-v4.1-flash-1017",
			active: "znu",
			total: 4,
			hidden: 1,
			channels: [
				{ ref: "subrouter-znu/deepseek-v4.1-flash-1017", channel: "znu", state: "active", tokensPerSecond: 7.1, measuredAt: 1794937772447 },
				{ ref: "subrouter-stableai/deepseek-v4.1-flash-1017", channel: "stableai", state: "ready", tokensPerSecond: 4.2, measuredAt: 1794937772447 },
				{ ref: "subrouter-relai/deepseek-v4.1-flash-1017", channel: "relai", state: "cooldown", tokensPerSecond: 3.7, measuredAt: 1794937772447, cooldownMs: 240_000 },
			],
		},
		{
			model: "gpt-6.1-sol",
			active: "best",
			total: 4,
			hidden: 1,
			channels: [
				{ ref: "subrouter-best/gpt-6.1-sol", channel: "best", state: "active", tokensPerSecond: 1.2, measuredAt: 1794937772447 },
				{ ref: "subrouter-fxpayback/gpt-6.1-sol", channel: "fxpayback", state: "failed", tokensPerSecond: null, measuredAt: null, note: "probe timed out after 45000 ms" },
				{ ref: "subrouter-000/gpt-6.1-sol", channel: "000", state: "unmeasured", tokensPerSecond: null, measuredAt: null },
			],
		},
	],
};

const harness = `
const { createJiti } = await import(process.env.JITI_PATH);
const jiti = createJiti(import.meta.url, { interopDefault: true });
const { renderShellStatusSections } = await jiti.import("./lib/shell-bar.ts");
const { readFile } = await import("node:fs/promises");
const theme = { fg: (_role, text) => text, bold: (text) => text };
const base = { cwd: "/home/me/project", branch: "main", dirty: 2, sessionName: "channels", modelId: "router/deepseek-rapido",
	effort: "high", contextPercent: 42, contextWindow: 1_000_000, costTotal: 1.5, subscription: true, statuses: [], integrations: ["MCP: 3 servers enabled"] };
const changes = { files: 2, added: 12, deleted: 3 };
const snapshot = JSON.parse(await readFile("./fixture.json", "utf8"));
const render = (model, options = {}) => renderShellStatusSections(model, theme, 46, { density: "comfortable", visibility: {} }, "? for keys", options).lines;
const cases = {
	painted: render({ ...base, changes, channels: snapshot }),
	collapsed: render({ ...base, changes, channels: snapshot }, { collapsed: new Set(["channels"]) }),
	empty: render({ ...base, changes }),
};
console.log(JSON.stringify(cases));
`;

const pi = hostRoot();
const scope = dirname(pi);
const nodeModules = dirname(scope);
const scratch = await mkdtemp(join(tmpdir(), "gentle-pi-channels-"));
try {
	for (const part of ["lib", "scripts"]) await cp(join(root, part), join(scratch, part), { recursive: true });
	await cp(join(root, "package.json"), join(scratch, "package.json"));
	// Two modules reach for the live host, which a standalone render has no way to
	// provide; neither can influence a channel row.
	await writeFile(join(scratch, "lib", "nan-provider.ts"), "export const NAN_CHAT_MODEL_IDS = [];\n");
	await writeFile(join(scratch, "lib", "background-jobs-tools.ts"), 'export const JOB_GLYPH = "⧗";\n');
	await writeFile(join(scratch, "fixture.json"), JSON.stringify(fixture));
	await writeFile(join(scratch, "render.mjs"), harness);
	await symlink(join(pi, "node_modules"), join(scratch, "host_node_modules"), "dir");

	const { stdout, stderr } = await run(process.execPath, [join(scratch, "render.mjs")], {
		cwd: scratch,
		env: {
			...process.env,
			JITI_PATH: `file://${join(pi, "node_modules", "jiti", "lib", "jiti.mjs")}`,
			NODE_PATH: [join(pi, "node_modules"), nodeModules].join(":"),
		},
		maxBuffer: 8 * 1024 * 1024,
	});
	if (stderr.trim()) console.error(stderr.trim());
	const cases = JSON.parse(stdout);
	const painted = cases.painted.join("\n");
	const collapsed = cases.collapsed.join("\n");
	const empty = cases.empty.join("\n");

	const failures = [];
	const expect = (condition, message) => {
		if (!condition) failures.push(message);
	};
	expect(painted.includes("CHANNELS"), "the Channels header is missing");
	expect(/\b2\s*$/.test(painted.split("\n").find((line) => line.includes("CHANNELS")) ?? ""), "the header does not count the two models");
	expect(painted.includes("deepseek-v4.1-flash-1017"), "the model name is missing");
	expect(painted.includes("→ znu"), "the chosen channel is missing");
	expect(painted.includes("7.1 tok/s"), "the measured speed is missing");
	expect(painted.includes("⏱ 4m"), "the cooldown mark is missing");
	expect(painted.includes("✕"), "the failed-probe mark is missing");
	expect(painted.includes("—"), "the unmeasured mark is missing");
	expect(painted.indexOf("CHANGES") < painted.indexOf("CHANNELS"), "Channels must come after Changes");
	expect(painted.indexOf("CHANNELS") < painted.indexOf("INTEGRATIONS"), "Channels must come before Integrations");
	expect(!empty.includes("CHANNELS"), "the card must stay hidden without a snapshot");
	expect(collapsed.includes("▸ CHANNELS") && !collapsed.includes("7.1 tok/s"), "the section must collapse to its header");

	// A syntax error in the extension itself would break the whole shell on
	// reload, so every patched TypeScript file is transpiled once. Bun parses TS
	// natively; without it this check is skipped and said so, never faked.
	const patched = ["extensions/gentle-shell.ts", "lib/shell-bar.ts", "lib/shell-channels.ts", "lib/channels-sidebar-state.ts"];
	try {
		await run("bun", ["--version"]);
		for (const file of patched) {
			await run("bun", ["build", join(root, file), "--external", "*", "--outfile", join(scratch, "syntax.js")], { cwd: root });
		}
		console.log(`verify: ${patched.length} patched TypeScript files parse.`);
	} catch (error) {
		console.log("verify: skipped the TypeScript syntax pass (bun is not on PATH).");
	}

	if (print) {
		console.log("\n--- painted -----------------------------------------");
		console.log(painted);
		console.log("\n--- collapsed ---------------------------------------");
		console.log(collapsed);
		console.log("\n--- empty -------------------------------------------");
		console.log(empty);
	}

	if (failures.length > 0) {
		console.error("\nverify: the card does not paint what it promises:");
		for (const failure of failures) console.error(`  - ${failure}`);
		process.exit(1);
	}
	console.log("verify: the Channels card paints, orders, collapses and hides as specified.");
} finally {
	await rm(scratch, { recursive: true, force: true });
}
