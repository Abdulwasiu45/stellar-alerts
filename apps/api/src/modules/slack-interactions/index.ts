/**
 * Slack interactive alert actions (acknowledge / snooze) (#940).
 *
 * Public surface consumed by app.ts.
 */
export * from './slack-interactions.types';
export {
  SlackInteractionsService,
  slackInteractionsService,
  MAX_SNOOZE_SECONDS,
  type SlackInteractionsServiceOptions,
  type SlackInteractionResult,
} from './slack-interactions.service';
export { SlackInteractionsController, slackInteractionsController } from './slack-interactions.controller';
export { slackInteractionsRoutes } from './slack-interactions.routes';
