import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, watch, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { emptyPriceCache, readPriceCache, recordPrices } from "./price-cache.js";
import { fetchSubrouterOffers } from "./subrouter-prices.js";

export const PRICE_REFRESH_MS = 60 * 60_000;
export const sharedPriceDir = (env = process.env) => env.SUBROUTER_PRICE_CACHE_DIR ||
  join(env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "ai-extensions", "subrouter-prices");

const modelFile = model => `${createHash("sha256").update(model).digest("hex")}.json`;
const writeOptions = { mode: 0o600, flag: "wx" };
const alias = ref => ref.slice("subrouter-".length);

/** Authenticated snapshots are keyed by model, so consumers can request different channels. */
export function createSharedPrices({ dir, refs, apiKey, fetchImpl = fetch, now = Date.now, log = () => {} }) {
  const groups = new Map();
  for (const ref of new Set(refs)) {
    const [channel, ...parts] = ref.split("/");
    const model = parts.join("/");
    if (!/^subrouter-.+$/.test(channel) || !model) continue;
    const file = modelFile(model);
    if (!groups.has(file)) groups.set(file, { model, refs: [] });
    groups.get(file).refs.push(ref);
  }
  const attempted = new Map();
  let cache = emptyPriceCache();
  let lifecycle;
  let listener;
  let watcher;
  let timer;
  let job;
  const read = file => readPriceCache(join(dir, file), { readFile: readFileSync });
  const report = message => { try { log(`failover-router: ${message}`); } catch { /* logging is optional */ } };

  function load() {
    const prices = {};
    let updatedAt = 0;
    for (const [file, group] of groups) {
      const snapshot = read(file);
      if (!snapshot) continue;
      updatedAt = Math.max(updatedAt, snapshot.updatedAt);
      for (const ref of group.refs) {
        const match = snapshot.prices[ref] ?? snapshot.prices[alias(ref)];
        if (match) prices[ref] = match;
      }
    }
    // Watchers can see our own rename as well. Publish each observed state once.
    if (updatedAt !== cache.updatedAt || JSON.stringify(prices) !== JSON.stringify(cache.prices)) {
      cache = { ...cache, updatedAt, prices };
      try { listener?.(cache); } catch { report("shared price subscriber failed"); }
    }
  }

  function publish(file, offers, at) {
    const previous = read(file);
    if (previous && previous.updatedAt >= at) return;
    // The successful response describes the model, not just this host's channels.
    const snapshot = recordPrices(emptyPriceCache(), offers, at);
    const path = join(dir, file);
    const temp = join(dir, `.${file}.${randomUUID()}.tmp`);
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(temp, JSON.stringify(snapshot), writeOptions);
      renameSync(temp, path);
    } catch {
      try { unlinkSync(temp); } catch { /* no owned temporary file remains */ }
      report("could not publish shared SubRouter tariffs");
    }
  }

  function refresh() {
    if (job) return job;
    load();
    if (!apiKey || !groups.size) return;
    lifecycle ??= new AbortController();
    const { signal } = lifecycle;
    const at = now();
    const due = [...groups].filter(([file]) => {
      const snapshot = read(file);
      const checked = Math.max(attempted.get(file) ?? -Infinity, snapshot?.updatedAt ?? -Infinity);
      return at - checked >= PRICE_REFRESH_MS;
    });
    if (!due.length) return;
    job = Promise.all(due.map(async ([file, { model }]) => {
      attempted.set(file, at);
      try {
        const rows = await fetchSubrouterOffers(model, { apiKey, fetchImpl, signal });
        const offers = new Map();
        for (const row of rows) {
          const ref = `${row.provider_slug}/${model}`;
          if (!offers.has(ref)) offers.set(ref, row);
        }
        if (!signal.aborted && offers.size) publish(file, Object.fromEntries(offers), at);
        else if (!signal.aborted) report("SubRouter returned no comparable tariffs; keeping last known rates");
      } catch {
        if (!signal.aborted) report("authenticated SubRouter tariff refresh failed; keeping last known rates");
      }
    })).then(() => { if (!signal.aborted) load(); }).finally(() => { job = undefined; });
    return job;
  }

  function start(onUpdate) {
    listener = onUpdate;
    if (groups.size && !watcher) {
      try {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        watcher = watch(dir, { persistent: false }, (_event, file) => { if (!file || groups.has(file)) load(); });
        watcher.on("error", () => { watcher?.close(); watcher = undefined; });
      } catch { /* periodic reload still works if the watcher is unavailable */ }
    }
    if (groups.size && timer === undefined) {
      timer = setInterval(() => { void refresh(); }, PRICE_REFRESH_MS);
      timer.unref?.();
    }
    return refresh();
  }

  function stop() {
    clearInterval(timer);
    timer = undefined;
    watcher?.close();
    watcher = undefined;
    listener = undefined;
    lifecycle?.abort();
    lifecycle = undefined;
    attempted.clear();
  }

  load();
  return { start, stop, refresh, snapshot: () => cache };
}
