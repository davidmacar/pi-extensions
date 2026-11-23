// Display-only channel snapshot published by pi-failover-router.
//
// The router measures throughput, knows which channel a model would use and
// which ones are sitting out a cooldown. It publishes that as one small object
// on the event bus; the rail paints it and decides nothing. Nothing here is
// review or delivery authority, and an extension that never publishes simply
// gets no Channels section.

export const CHANNELS_SIDEBAR_EVENT = "gentle-pi:channels-sidebar/v2";
export const CHANNELS_SNAPSHOT_SCHEMA = "gentle-pi.channels-sidebar/v2";

/** The fastest channels a model shows: the card is a rail section, not a table. */
export const CHANNELS_SHOWN = 3;

export type ChannelState = "active" | "ready" | "cooldown" | "failed" | "unmeasured";

export interface ChannelsSidebarPrice {
	input_price: number;
	price_currency: string;
}

export interface ChannelsSidebarChannel {
	/** `provider/id` of the physical channel, kept for correlation. */
	ref: string;
	/** Short name the row shows. */
	channel: string;
	state: ChannelState;
	tokensPerSecond: number | null;
	measuredAt: number | null;
	/** Time left before this channel is usable again, when `state` is `cooldown`. */
	cooldownMs?: number;
	/** The provider or timeout text behind a `failed` state. */
	note?: string;
	/** Current marketplace input price, present for cheap virtual models. */
	price?: ChannelsSidebarPrice | null;
}

export interface ChannelsSidebarModel {
	/** The physical model the channels serve. */
	model: string;
	/** Virtual model shown as a distinct fast or cheap section. */
	virtualId: string;
	/** Routing order represented by this section. */
	order: "speed" | "cost";
	/** The channel a request would use right now, when one is known. */
	active: string | null;
	total: number;
	/** Channels the card does not show because only the fastest three fit. */
	hidden: number;
	channels: ChannelsSidebarChannel[];
}

export interface ChannelsSidebarSnapshot {
	schema: typeof CHANNELS_SNAPSHOT_SCHEMA;
	/** Instant of the newest measurement the card shows; null before the first one. */
	measuredAt: number | null;
	models: ChannelsSidebarModel[];
}

const STATES: readonly ChannelState[] = ["active", "ready", "cooldown", "failed", "unmeasured"];
const MAX_MODELS = 16;

const record = (value: unknown): Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

const text = (value: unknown, max: number): string | undefined =>
	typeof value === "string" && value.length > 0 && value.length <= max ? value : undefined;

const finite = (value: unknown): number | undefined =>
	typeof value === "number" && Number.isFinite(value) ? value : undefined;

function isChannel(value: unknown): value is ChannelsSidebarChannel {
	const channel = record(value);
	return text(channel.ref, 200) !== undefined
		&& text(channel.channel, 40) !== undefined
		&& STATES.includes(channel.state as ChannelState)
		&& (channel.tokensPerSecond === null || finite(channel.tokensPerSecond) !== undefined)
		&& (channel.measuredAt === null || finite(channel.measuredAt) !== undefined)
		&& (channel.cooldownMs === undefined || finite(channel.cooldownMs) !== undefined)
		&& (channel.note === undefined || text(channel.note, 200) !== undefined)
		&& (channel.price === undefined || channel.price === null || (
			record(channel.price).input_price !== undefined
			&& finite(record(channel.price).input_price) !== undefined
			&& text(record(channel.price).price_currency, 20) !== undefined
		));
}

function isModel(value: unknown): value is ChannelsSidebarModel {
	const model = record(value);
	return text(model.model, 120) !== undefined
		&& text(model.virtualId, 80) !== undefined
		&& (model.order === "speed" || model.order === "cost")
		&& (model.active === null || text(model.active, 40) !== undefined)
		&& Number.isInteger(model.total)
		&& (model.total as number) >= 0
		&& Number.isInteger(model.hidden)
		&& (model.hidden as number) >= 0
		&& Array.isArray(model.channels)
		&& model.channels.length > 0
		&& model.channels.length <= CHANNELS_SHOWN
		&& model.channels.every(isChannel);
}

/** True when the payload is a snapshot the rail may paint: bounded, typed, and nothing else. */
export function isChannelsSidebarSnapshot(value: unknown): value is ChannelsSidebarSnapshot {
	const snapshot = record(value);
	return snapshot.schema === CHANNELS_SNAPSHOT_SCHEMA
		&& (snapshot.measuredAt === null || finite(snapshot.measuredAt) !== undefined)
		&& Array.isArray(snapshot.models)
		&& snapshot.models.length <= MAX_MODELS
		&& snapshot.models.every(isModel);
}
