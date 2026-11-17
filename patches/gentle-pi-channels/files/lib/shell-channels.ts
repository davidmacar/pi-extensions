import { renderPanelRow } from "./shell-panel.ts";
import { sanitizeTerminalText } from "./terminal-theme.ts";
import { CHANNELS_SHOWN, type ChannelsSidebarChannel, type ChannelsSidebarModel, type ChannelsSidebarSnapshot } from "./channels-sidebar-state.ts";

// The Channels rail section: what the failover router measured, one block per
// physical model — the channel a request would use, then the fastest three with
// the tokens per second of the last measurement. Rows use the same panel row and
// roles as Changes and Stats, so the card needs no chrome of its own.

type ChannelsTheme = { fg(role: string, text: string): string };

/** `7.1 tok/s`: one decimal below ten, integers above, so the column stays narrow. */
export function formatTokensPerSecond(speed: number | null): string {
	if (speed === null || !Number.isFinite(speed) || speed <= 0) return "";
	return `${speed >= 10 ? Math.round(speed).toString() : speed.toFixed(1)} tok/s`;
}

/** `4m`, or `2h` once the wait is long enough that minutes stop being useful. */
export function formatCooldown(ms: number): string {
	const minutes = Math.max(1, Math.ceil(ms / 60_000));
	return minutes < 60 ? `${minutes}m` : `${Math.round(minutes / 60)}h`;
}

const clean = (value: string) => sanitizeTerminalText(value).replace(/[\x00-\x1f\x7f]/g, "").trim();

/** The one mark a channel row carries besides its speed. */
function stateMark(channel: ChannelsSidebarChannel, theme: ChannelsTheme): string {
	switch (channel.state) {
		case "active":
			return theme.fg("accent", "●");
		case "cooldown":
			return theme.fg("warning", `⏱ ${formatCooldown(channel.cooldownMs ?? 0)}`);
		case "failed":
			return theme.fg("error", "✕");
		case "unmeasured":
			return theme.fg("muted", "—");
		case "ready":
			return "";
	}
}

/**
 * The model block: a head row naming the model and the channel a request would
 * use, then one row per shown channel — rank, short name, measured speed, and
 * the one mark that explains a channel that is not simply available.
 */
export function channelsModelRows(model: ChannelsSidebarModel, theme: ChannelsTheme, width: number): string[] {
	const name = clean(model.model);
	const active = model.active ? clean(model.active) : "";
	const head = renderPanelRow(
		width,
		theme.fg("text", name),
		active ? theme.fg("muted", `→ ${active}`) : "",
	);
	const shown = model.channels.slice(0, CHANNELS_SHOWN);
	// One shared column keeps the speeds aligned without widening the rail: the
	// longest shown channel name decides it, bounded so a pathological id clips.
	const column = Math.min(12, Math.max(...shown.map((channel) => clean(channel.channel).length)));
	const rows = shown.map((channel, index) => {
		const label = theme.fg("muted", `${index + 1}`);
		const channelName = theme.fg(channel.state === "active" ? "accent" : "text", clean(channel.channel).padEnd(column));
		const speed = formatTokensPerSecond(channel.tokensPerSecond);
		// The mark leads the right column: the state of a channel is what the
		// reader looks for, and a right-aligned number alone hides it.
		const right = [stateMark(channel, theme), speed ? theme.fg("muted", speed) : ""].filter(Boolean).join(" ");
		return renderPanelRow(width, `${label} ${channelName}`, right);
	});
	return [head, ...rows];
}

/** Every visible model block, in the order the publisher ranked them. */
export function renderChannelsRows(snapshot: ChannelsSidebarSnapshot, theme: ChannelsTheme, width: number): string[] {
	const rows: string[] = [];
	for (const model of snapshot.models) rows.push(...channelsModelRows(model, theme, width));
	return rows;
}

/** What the section counts on its right column: models, not channels. */
export function channelsSectionCount(snapshot: ChannelsSidebarSnapshot): string {
	return String(snapshot.models.length);
}
