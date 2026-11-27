import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Tests must never use a developer's relay key or its shared tariff files.
// Pricing integration tests can still inject an explicit fake key and directory.
delete process.env.SUBROUTER_API_KEY;
delete process.env.SUBROUTER_PRICE_CACHE_DIR;
const state = mkdtempSync(join(tmpdir(), "failover-router-test-state-"));
process.env.XDG_STATE_HOME = state;
process.once("exit", () => rmSync(state, { recursive: true, force: true }));
