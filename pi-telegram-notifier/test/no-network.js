// Loaded by npm scripts and test modules before any extension handler runs.
globalThis.fetch = async () => { throw new Error("Real network access is forbidden in notifier tests"); };
