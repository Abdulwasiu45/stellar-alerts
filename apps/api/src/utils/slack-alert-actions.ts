/**
 * Block Kit action builders for an interactive payment alert: a Snooze
 * button that opens a duration-picker modal (#940). The Acknowledge
 * button itself already exists inline in slack.provider.ts's
 * buildBlockKitPayload (action_id 'acknowledge_alert'); this module keeps
 * that action_id as the source of truth so the interactions handler and
 * the button stay in sync, and adds the matching snooze pieces.
 */
import type { SlackButtonElement } from '../modules/notifications/providers/slack.provider';

/** Matches slack.provider.ts's buildBlockKitPayload button exactly. */
export const SLACK_ACK_ACTION_ID = 'acknowledge_alert';
export const SLACK_SNOOZE_ACTION_ID = 'snooze_alert';
export const SLACK_SNOOZE_MODAL_CALLBACK_ID = 'sa_snooze_modal';
export const SLACK_SNOOZE_DURATION_BLOCK_ID = 'sa_snooze_duration';
export const SLACK_SNOOZE_DURATION_ACTION_ID = 'sa_snooze_duration_select';

/** Snooze durations the modal offers, in seconds. */
export const SLACK_SNOOZE_DURATIONS = [
  { label: '1 hour', seconds: 3600 },
  { label: '4 hours', seconds: 14400 },
  { label: '24 hours', seconds: 86400 },
] as const;

/** The Snooze button to add alongside the existing Acknowledge Alert button. */
export function buildSlackSnoozeButton(alertId: string): SlackButtonElement {
  return {
    type: 'button',
    text: { type: 'plain_text', text: '😴 Snooze', emoji: true },
    action_id: SLACK_SNOOZE_ACTION_ID,
    value: alertId,
  };
}

/** The modal view shown after clicking Snooze, letting the operator pick a duration. */
export function buildSnoozeModalView(alertId: string) {
  return {
    type: 'modal' as const,
    callback_id: SLACK_SNOOZE_MODAL_CALLBACK_ID,
    private_metadata: alertId,
    title: { type: 'plain_text' as const, text: 'Snooze Alert' },
    submit: { type: 'plain_text' as const, text: 'Snooze' },
    close: { type: 'plain_text' as const, text: 'Cancel' },
    blocks: [
      {
        type: 'input',
        block_id: SLACK_SNOOZE_DURATION_BLOCK_ID,
        label: { type: 'plain_text', text: 'Silence this alert for' },
        element: {
          type: 'static_select',
          action_id: SLACK_SNOOZE_DURATION_ACTION_ID,
          placeholder: { type: 'plain_text', text: 'Choose a duration' },
          options: SLACK_SNOOZE_DURATIONS.map((d) => ({
            text: { type: 'plain_text', text: d.label },
            value: String(d.seconds),
          })),
        },
      },
    ],
  };
}

/** Extracts the chosen snooze duration (seconds) from a view_submission payload's state. */
export function extractSnoozeSeconds(
  state: { values?: Record<string, Record<string, { selected_option?: { value: string } }>> } | undefined,
): number | null {
  const selected = state?.values?.[SLACK_SNOOZE_DURATION_BLOCK_ID]?.[SLACK_SNOOZE_DURATION_ACTION_ID]?.selected_option?.value;
  if (!selected) return null;
  const seconds = Number(selected);
  return Number.isInteger(seconds) && seconds > 0 ? seconds : null;
}
