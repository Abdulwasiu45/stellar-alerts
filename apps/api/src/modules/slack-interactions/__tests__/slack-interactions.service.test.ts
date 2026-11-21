import { describe, expect, it } from 'vitest';

import { InMemoryDiscordAlertActionStore } from '../../discord-interactions/discord-interactions.actionStore';
import { SlackInteractionsService, MAX_SNOOZE_SECONDS } from '../slack-interactions.service';
import {
  SLACK_ACK_ACTION_ID,
  SLACK_SNOOZE_ACTION_ID,
  SLACK_SNOOZE_MODAL_CALLBACK_ID,
  SLACK_SNOOZE_DURATION_BLOCK_ID,
  SLACK_SNOOZE_DURATION_ACTION_ID,
  buildSlackSnoozeButton,
} from '../../../utils/slack-alert-actions';
import type { SlackBlock } from '../../notifications/providers/slack.provider';
import type { SlackInteractionPayload } from '../slack-interactions.types';

const FIXED_NOW = new Date('2026-09-27T12:00:00.000Z');

function makeService() {
  return new SlackInteractionsService({ store: new InMemoryDiscordAlertActionStore(() => FIXED_NOW) });
}

const SAMPLE_BLOCKS: SlackBlock[] = [
  { type: 'header', text: { type: 'plain_text', text: '🚨 Stellar Payment Alert' } },
  {
    type: 'actions',
    elements: [
      { type: 'button', text: { type: 'plain_text', text: 'Acknowledge' }, action_id: SLACK_ACK_ACTION_ID, value: 'alert-1' },
      buildSlackSnoozeButton('alert-1'),
    ],
  },
];

function blockActionPayload(
  actionId: string,
  alertId = 'alert-1',
  overrides: Partial<SlackInteractionPayload> = {},
): SlackInteractionPayload {
  return {
    type: 'block_actions',
    user: { id: 'U123', username: 'operator' },
    actions: [{ action_id: actionId, value: alertId, type: 'button' }],
    message: { ts: '1234.5678', blocks: SAMPLE_BLOCKS },
    response_url: 'https://hooks.slack.com/actions/T1/B1/xyz',
    trigger_id: 'trigger-1',
    ...overrides,
  };
}

function viewSubmissionPayload(seconds: number | null, alertId = 'alert-1'): SlackInteractionPayload {
  return {
    type: 'view_submission',
    user: { id: 'U123', username: 'operator' },
    view: {
      callback_id: SLACK_SNOOZE_MODAL_CALLBACK_ID,
      private_metadata: alertId,
      state: {
        values:
          seconds === null
            ? {}
            : {
                [SLACK_SNOOZE_DURATION_BLOCK_ID]: {
                  [SLACK_SNOOZE_DURATION_ACTION_ID]: { selected_option: { value: String(seconds) } },
                },
              },
      },
    },
  };
}

describe('SlackInteractionsService.handle — block_actions (#940)', () => {
  it('acknowledges an alert and returns an update_message result preserving the card blocks', async () => {
    const service = makeService();
    const result = await service.handle(blockActionPayload(SLACK_ACK_ACTION_ID));

    expect(result.kind).toBe('update_message');
    if (result.kind === 'update_message') {
      expect(result.text).toContain('acknowledged');
      expect(result.text).toContain('<@U123>');
      expect(result.blocks[0]).toEqual(SAMPLE_BLOCKS[0]);
      expect(result.blocks[1]).toEqual(SAMPLE_BLOCKS[1]);
      const statusBlock = result.blocks[result.blocks.length - 1];
      expect(statusBlock.type).toBe('context');
    }

    const state = await service.getAlertState('alert-1');
    expect(state?.status).toBe('acknowledged');
    expect(state?.actorId).toBe('U123');
  });

  it('falls back to an ephemeral reply when the message blocks are unavailable', async () => {
    const service = makeService();
    const result = await service.handle(blockActionPayload(SLACK_ACK_ACTION_ID, 'alert-1', { message: undefined }));

    expect(result.kind).toBe('ephemeral');
  });

  it('opens the snooze modal when the Snooze button is clicked', async () => {
    const service = makeService();
    const result = await service.handle(blockActionPayload(SLACK_SNOOZE_ACTION_ID));

    expect(result.kind).toBe('open_modal');
    if (result.kind === 'open_modal') {
      expect(result.triggerId).toBe('trigger-1');
      expect(result.view.private_metadata).toBe('alert-1');
      expect(result.view.callback_id).toBe(SLACK_SNOOZE_MODAL_CALLBACK_ID);
    }
    // Clicking Snooze does not itself change the alert's stored state yet.
    expect(await service.getAlertState('alert-1')).toBeNull();
  });

  it('returns an ephemeral error when the snooze button has no trigger_id', async () => {
    const service = makeService();
    const result = await service.handle(blockActionPayload(SLACK_SNOOZE_ACTION_ID, 'alert-1', { trigger_id: undefined }));
    expect(result.kind).toBe('ephemeral');
  });

  it('returns an ephemeral error when no action value (alertId) is present', async () => {
    const service = makeService();
    const payload = blockActionPayload(SLACK_ACK_ACTION_ID);
    payload.actions![0].value = undefined;

    const result = await service.handle(payload);
    expect(result.kind).toBe('ephemeral');
  });

  it('returns an ephemeral error when the actor cannot be identified', async () => {
    const service = makeService();
    const payload = blockActionPayload(SLACK_ACK_ACTION_ID);
    payload.user = { id: '' } as any;
    // resolveActorId falls back to 'unknown' only when .id is missing entirely.
    delete (payload.user as any).id;

    const result = await service.handle(payload);
    expect(result.kind).toBe('ephemeral');
  });

  it('replaces a prior status line rather than stacking a second one', async () => {
    const service = makeService();
    const blocksWithPriorSnooze: SlackBlock[] = [
      ...SAMPLE_BLOCKS,
      { type: 'context', elements: [{ type: 'mrkdwn', text: '😴 Alert snoozed by <@U999> until 2026-09-27T13:00:00.000Z.' }] },
    ];

    const result = await service.handle(
      blockActionPayload(SLACK_ACK_ACTION_ID, 'alert-1', { message: { ts: '1', blocks: blocksWithPriorSnooze } }),
    );

    expect(result.kind).toBe('update_message');
    if (result.kind === 'update_message') {
      const contextBlocks = result.blocks.filter((b) => b.type === 'context');
      expect(contextBlocks).toHaveLength(1);
      expect(contextBlocks[0]).toMatchObject({
        elements: [{ text: expect.stringContaining('acknowledged') }],
      });
    }
  });
});

describe('SlackInteractionsService.handle — view_submission (#940)', () => {
  it('records a snooze with the selected duration', async () => {
    const service = makeService();
    const result = await service.handle(viewSubmissionPayload(14400));

    expect(result.kind).toBe('ack');
    const state = await service.getAlertState('alert-1');
    expect(state?.status).toBe('snoozed');
    expect(state?.actorId).toBe('U123');
    expect(state?.snoozedUntil).toBe(new Date(FIXED_NOW.getTime() + 14400 * 1000).toISOString());
  });

  it('rejects a missing duration selection', async () => {
    const service = makeService();
    const result = await service.handle(viewSubmissionPayload(null));
    expect(result.kind).toBe('ephemeral');
    expect(await service.getAlertState('alert-1')).toBeNull();
  });

  it('rejects a duration beyond the maximum', async () => {
    const service = makeService();
    const result = await service.handle(viewSubmissionPayload(MAX_SNOOZE_SECONDS + 1));
    expect(result.kind).toBe('ephemeral');
  });

  it('ignores a view_submission for an unrelated modal', async () => {
    const service = makeService();
    const payload = viewSubmissionPayload(3600);
    payload.view!.callback_id = 'some_other_modal';

    const result = await service.handle(payload);
    expect(result.kind).toBe('ack');
    expect(await service.getAlertState('alert-1')).toBeNull();
  });

  it('rejects a submission missing private_metadata (the alertId)', async () => {
    const service = makeService();
    const payload = viewSubmissionPayload(3600);
    payload.view!.private_metadata = undefined;

    const result = await service.handle(payload);
    expect(result.kind).toBe('ephemeral');
  });
});

describe('SlackInteractionsService.handle — unsupported type', () => {
  it('acks anything that is neither block_actions nor view_submission', async () => {
    const service = makeService();
    const result = await service.handle({ type: 'shortcut', user: { id: 'U1' } });
    expect(result.kind).toBe('ack');
  });
});

describe('Discord/Slack shared alert state (#940)', () => {
  it('Slack acknowledging an alert is visible through the same store a Discord-style reader would use', async () => {
    const sharedStore = new InMemoryDiscordAlertActionStore(() => FIXED_NOW);
    const slackService = new SlackInteractionsService({ store: sharedStore });

    await slackService.handle(blockActionPayload(SLACK_ACK_ACTION_ID));

    const stateFromSharedStore = await sharedStore.get('alert-1');
    expect(stateFromSharedStore?.status).toBe('acknowledged');
    expect(stateFromSharedStore?.actorId).toBe('U123');
  });
});
