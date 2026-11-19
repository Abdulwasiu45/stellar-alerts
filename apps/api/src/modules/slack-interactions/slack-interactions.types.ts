/**
 * types.ts — wire types for the subset of the Slack Interactivity payload
 * this service consumes: `block_actions` (a button was clicked) and
 * `view_submission` (the snooze-duration modal was submitted).
 *
 * @see https://api.slack.com/reference/interaction-payloads/views#view_submission
 * @see https://api.slack.com/reference/interaction-payloads/block-actions
 */

export const SLACK_INTERACTIONS_PATH = '/slack/interactions';

export interface SlackInteractionUser {
  id: string;
  username?: string;
  name?: string;
}

export interface SlackBlockAction {
  action_id: string;
  value?: string;
  type: string;
}

export interface SlackInteractionMessage {
  ts?: string;
  blocks?: import('../notifications/providers/slack.provider').SlackBlock[];
}

export interface SlackViewState {
  values?: Record<string, Record<string, { selected_option?: { value: string } ; value?: string }>>;
}

export interface SlackView {
  id?: string;
  callback_id?: string;
  private_metadata?: string;
  state?: SlackViewState;
}

export interface SlackInteractionPayload {
  type: 'block_actions' | 'view_submission' | string;
  user: SlackInteractionUser;
  /** Present on block_actions; absent on view_submission. */
  actions?: SlackBlockAction[];
  /** Present on block_actions (the message the button lives on). */
  message?: SlackInteractionMessage;
  /** Present on block_actions: lets a response update the original message in place. */
  response_url?: string;
  /** Present on block_actions: required to open a modal via views.open. */
  trigger_id?: string;
  /** Present on view_submission. */
  view?: SlackView;
  channel?: { id?: string };
}

export function resolveActorId(payload: SlackInteractionPayload): string {
  return payload.user?.id ?? 'unknown';
}
