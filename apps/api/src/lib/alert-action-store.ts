/**
 * Shared alert-action state (acknowledge / snooze / re-route), keyed by
 * alertId. One alert has one state regardless of which chat platform
 * (Discord, Slack, ...) acted on it — the underlying store in
 * modules/discord-interactions is already generic, not Discord-specific,
 * so Discord's and Slack's interactions services share this one instance
 * instead of each keeping an isolated, platform-scoped copy of the same
 * state.
 */
import { InMemoryDiscordAlertActionStore, type DiscordAlertActionStore } from '../modules/discord-interactions/discord-interactions.actionStore';

export const sharedAlertActionStore: DiscordAlertActionStore = new InMemoryDiscordAlertActionStore();
