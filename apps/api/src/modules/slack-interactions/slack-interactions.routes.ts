import { FastifyInstance } from 'fastify';
import { slackInteractionsController } from './slack-interactions.controller';
import { SLACK_INTERACTIONS_PATH } from './slack-interactions.types';

export async function slackInteractionsRoutes(app: FastifyInstance) {
  // Same raw-body requirement as slack.routes.ts's /slack/commands: Slack
  // signs the exact bytes it posts, so the parser keeps the body as a raw
  // string rather than eagerly parsing the urlencoded `payload=` field.
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
    done(null, typeof body === 'string' ? body : String(body));
  });

  app.post(SLACK_INTERACTIONS_PATH, slackInteractionsController.handleInteraction.bind(slackInteractionsController));
}
