import { FastifyReply, FastifyRequest } from 'fastify';
import { env } from '../../config/env';
import { verifySlackSignature } from '../slack/slack.signature';
import { slackInteractionsService } from './slack-interactions.service';
import type { SlackInteractionPayload } from './slack-interactions.types';

/**
 * Slack posts interactivity payloads as
 * `application/x-www-form-urlencoded` with a single `payload` field
 * holding a JSON string (distinct from the slash-command form fields
 * slack.controller.ts parses). Slack signs the exact raw body it sent, so
 * verification runs on that raw string before the `payload` field is
 * parsed out of it.
 */
export class SlackInteractionsController {
  async handleInteraction(request: FastifyRequest, reply: FastifyReply) {
    const rawBody = typeof request.body === 'string' ? request.body : '';

    const verification = verifySlackSignature(
      rawBody,
      request.headers['x-slack-signature'],
      request.headers['x-slack-request-timestamp'],
      env.SLACK_SIGNING_SECRET,
    );

    if (!verification.valid) {
      if (verification.failure === 'signing_secret_not_configured') {
        return reply.status(503).send({ error: 'Slack signing secret is not configured' });
      }
      return reply
        .status(401)
        .send({ error: 'Invalid Slack request signature', reason: verification.failure });
    }

    const payloadField = new URLSearchParams(rawBody).get('payload');
    if (!payloadField) {
      return reply.status(400).send({ error: 'Missing Slack interaction payload' });
    }

    let payload: SlackInteractionPayload;
    try {
      payload = JSON.parse(payloadField);
    } catch {
      return reply.status(400).send({ error: 'Malformed Slack interaction payload' });
    }

    const result = await slackInteractionsService.handle(payload);

    if (result.kind === 'open_modal') {
      await this.openModal(result.triggerId, result.view);
      return reply.send({});
    }

    if (result.kind === 'update_message') {
      await this.updateMessage(result.responseUrl, result.text, result.blocks);
      return reply.send({});
    }

    if (result.kind === 'ephemeral') {
      return reply.send({ response_type: 'ephemeral', text: result.text });
    }

    return reply.send({});
  }

  private async openModal(triggerId: string, view: unknown): Promise<void> {
    const botToken = env.SLACK_BOT_TOKEN;
    if (!botToken) {
      return;
    }
    await fetch('https://slack.com/api/views.open', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${botToken}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({ trigger_id: triggerId, view }),
    }).catch(() => {
      // Best-effort: a failed views.open leaves the button unresponsive
      // from the operator's perspective, but must not crash the request.
    });
  }

  private async updateMessage(responseUrl: string, text: string, blocks: unknown[]): Promise<void> {
    await fetch(responseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ replace_original: true, text, blocks }),
    }).catch(() => {
      // Best-effort: the alert-action state is already persisted regardless
      // of whether the card visually updates.
    });
  }
}

export const slackInteractionsController = new SlackInteractionsController();
