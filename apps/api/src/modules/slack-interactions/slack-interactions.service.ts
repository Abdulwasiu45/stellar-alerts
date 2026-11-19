/**
 * service.ts — Slack interactive alert actions (acknowledge / snooze) (#940).
 *
 * Mirrors modules/discord-interactions/discord-interactions.service.ts:
 * transport-agnostic, takes a parsed interaction payload and returns the
 * Slack response, so it can be unit tested without Fastify or a live Slack
 * workspace. Shares the same underlying alert-action store as Discord's
 * service (lib/alert-action-store.ts), so one alert has one acknowledged /
 * snoozed state regardless of which platform acted on it.
 */
import { sharedAlertActionStore } from '../../lib/alert-action-store';
import type { DiscordAlertActionState, DiscordAlertActionStore } from '../discord-interactions/discord-interactions.actionStore';
import type { SlackBlock } from '../notifications/providers/slack.provider';
import {
  SLACK_ACK_ACTION_ID,
  SLACK_SNOOZE_ACTION_ID,
  SLACK_SNOOZE_MODAL_CALLBACK_ID,
  buildSnoozeModalView,
  extractSnoozeSeconds,
} from '../../utils/slack-alert-actions';
import { resolveActorId, type SlackInteractionPayload } from './slack-interactions.types';

/**
 * A context block whose sole element starts with one of these is a
 * previously-appended status line (see buildConfirmation): replaced, not
 * stacked, so re-acknowledging or re-snoozing an alert doesn't leave a
 * growing trail of old status lines on the card.
 */
const STATUS_LINE_PREFIXES = ['✅ Alert acknowledged', '😴 Alert snoozed'];

function isStatusContextBlock(block: SlackBlock): boolean {
  return (
    block.type === 'context' &&
    block.elements.length === 1 &&
    typeof block.elements[0].text === 'string' &&
    STATUS_LINE_PREFIXES.some((prefix) => block.elements[0].text!.startsWith(prefix))
  );
}

function withStatusContextBlock(existingBlocks: SlackBlock[], statusText: string): SlackBlock[] {
  const withoutPriorStatus = existingBlocks.filter((block) => !isStatusContextBlock(block));
  return [
    ...withoutPriorStatus,
    { type: 'context', elements: [{ type: 'mrkdwn', text: statusText }] },
  ];
}

/** Upper bound for an ad-hoc snooze duration (7 days) — matches Discord's. */
export const MAX_SNOOZE_SECONDS = 7 * 24 * 60 * 60;

/** Slack response for an interaction that should just acknowledge receipt (no visible reply). */
export interface SlackInteractionAck {
  kind: 'ack';
}

/** Slack response that posts an ephemeral message back to the clicking user. */
export interface SlackInteractionEphemeral {
  kind: 'ephemeral';
  text: string;
}

/** Slack response that opens a modal via views.open, using the given trigger_id. */
export interface SlackInteractionOpenModal {
  kind: 'open_modal';
  triggerId: string;
  view: ReturnType<typeof buildSnoozeModalView>;
}

/**
 * Slack response that updates the original alert message in place via
 * response_url (POST { replace_original: true, text, blocks }), so the
 * card itself shows who acknowledged/snoozed it and when, instead of
 * leaving that only in an ephemeral reply.
 */
export interface SlackInteractionUpdateMessage {
  kind: 'update_message';
  responseUrl: string;
  text: string;
  blocks: SlackBlock[];
}

export type SlackInteractionResult =
  | SlackInteractionAck
  | SlackInteractionEphemeral
  | SlackInteractionOpenModal
  | SlackInteractionUpdateMessage;

export interface SlackInteractionsServiceOptions {
  store?: DiscordAlertActionStore;
}

export class SlackInteractionsService {
  private readonly store: DiscordAlertActionStore;

  constructor(options: SlackInteractionsServiceOptions = {}) {
    this.store = options.store ?? sharedAlertActionStore;
  }

  async getAlertState(alertId: string): Promise<DiscordAlertActionState | null> {
    return this.store.get(alertId);
  }

  /** Entry point for `POST /slack/interactions`. Callers MUST verify the request signature first. */
  async handle(payload: SlackInteractionPayload): Promise<SlackInteractionResult> {
    if (payload.type === 'view_submission') {
      return this.handleViewSubmission(payload);
    }
    if (payload.type === 'block_actions') {
      return this.handleBlockAction(payload);
    }
    return { kind: 'ack' };
  }

  private async handleBlockAction(payload: SlackInteractionPayload): Promise<SlackInteractionResult> {
    const action = payload.actions?.[0];
    if (!action) {
      return { kind: 'ephemeral', text: '❌ No action was received.' };
    }

    const alertId = action.value;
    if (!alertId) {
      return { kind: 'ephemeral', text: '❌ This button is no longer supported. Refresh the alert message.' };
    }

    const actorId = resolveActorId(payload);
    if (actorId === 'unknown') {
      return { kind: 'ephemeral', text: '❌ Could not identify the operator who clicked this button.' };
    }

    if (action.action_id === SLACK_ACK_ACTION_ID) {
      const state = await this.store.apply({ action: 'ack', alertId, actorId });
      return this.updateOrEphemeral(payload, this.buildConfirmation(state));
    }

    if (action.action_id === SLACK_SNOOZE_ACTION_ID) {
      if (!payload.trigger_id) {
        return { kind: 'ephemeral', text: '❌ Could not open the snooze dialog. Try again.' };
      }
      return { kind: 'open_modal', triggerId: payload.trigger_id, view: buildSnoozeModalView(alertId) };
    }

    return { kind: 'ephemeral', text: '❌ Unrecognized action.' };
  }

  private async handleViewSubmission(payload: SlackInteractionPayload): Promise<SlackInteractionResult> {
    if (payload.view?.callback_id !== SLACK_SNOOZE_MODAL_CALLBACK_ID) {
      return { kind: 'ack' };
    }

    const alertId = payload.view.private_metadata;
    if (!alertId) {
      return { kind: 'ephemeral', text: '❌ This dialog is no longer linked to an alert.' };
    }

    const actorId = resolveActorId(payload);
    if (actorId === 'unknown') {
      return { kind: 'ephemeral', text: '❌ Could not identify who submitted this dialog.' };
    }

    const seconds = extractSnoozeSeconds(payload.view.state);
    if (seconds === null || seconds > MAX_SNOOZE_SECONDS) {
      return { kind: 'ephemeral', text: '❌ Invalid snooze duration selected.' };
    }

    await this.store.apply({ action: 'snooze', alertId, actorId, snoozeSeconds: seconds });
    // view_submission has no response_url to update the original card with;
    // Slack just closes the modal on an {kind: 'ack'}-equivalent response.
    return { kind: 'ack' };
  }

  private updateOrEphemeral(payload: SlackInteractionPayload, statusText: string): SlackInteractionResult {
    // Without the original message's blocks there's nothing safe to rebuild
    // the card from (sending an empty blocks array would wipe it), so this
    // falls back to an ephemeral reply rather than risk clobbering the card.
    if (payload.response_url && payload.message?.blocks) {
      return {
        kind: 'update_message',
        responseUrl: payload.response_url,
        text: statusText,
        blocks: withStatusContextBlock(payload.message.blocks, statusText),
      };
    }
    return { kind: 'ephemeral', text: statusText };
  }

  private buildConfirmation(state: DiscordAlertActionState): string {
    switch (state.status) {
      case 'acknowledged':
        return `✅ Alert acknowledged by <@${state.actorId}>.`;
      case 'snoozed':
        return `😴 Alert snoozed by <@${state.actorId}> until ${state.snoozedUntil}.`;
      default:
        return '✅ Alert updated.';
    }
  }
}

export const slackInteractionsService = new SlackInteractionsService();
