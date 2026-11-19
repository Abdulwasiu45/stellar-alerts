# Slack Interactive Alert Actions (Acknowledge / Snooze)

Payment alerts posted to Slack via Block Kit (`slack.provider.ts`, issue
#637) carry an **Acknowledge** and a **Snooze** button. Clicking either
triggers Slack's Interactivity callback, handled by one new module,
`modules/slack-interactions/` (issue #940).

## What each button does

- **Acknowledge**: records who acknowledged the alert and when, then
  updates the original Slack message in place (via `response_url`) to
  show that status as a new context line on the card, replacing any
  prior status line rather than stacking a second one.
- **Snooze**: opens a modal (`views.open`) asking the operator to choose
  a silence duration (1 hour / 4 hours / 24 hours). Submitting the modal
  records the snooze and its expiry; Slack closes the modal on
  submission (a `view_submission` has no `response_url` to update the
  original card with, unlike a button click).

Both actions are recorded in the same in-memory alert-action store
Discord's interactive alerts use (`lib/alert-action-store.ts`), keyed by
`alertId` — acknowledging or snoozing an alert from Slack is visible to
a Discord-side reader of the same alert, and vice versa.

## Setup

1. **Re-apply the updated app manifest.** [`slack-app-manifest.yml`](../slack-app-manifest.yml)
   now declares an `interactivity` block pointing at
   `https://<your-api-host>/slack/interactions`, and adds the `chat:write`
   bot scope (needed for `chat.postMessage` and `views.open`). In Slack app
   settings, use *App Manifest* to update an existing app, or recreate it
   from the manifest if it predates this change.
2. **Reinstall the app to the workspace** after adding the `chat:write`
   scope — Slack requires re-authorization when scopes change.
3. **Set `SLACK_BOT_TOKEN`.** The *Bot User OAuth Token* shown after
   installing the app (starts with `xoxb-`):
   ```
   SLACK_BOT_TOKEN=<your bot token>
   ```
   Without it, Acknowledge still works (it only needs `response_url`,
   not the bot token), but clicking Snooze cannot open the modal.
4. `SLACK_SIGNING_SECRET` (already required for `/slack/commands`, issue
   #452) also verifies `/slack/interactions` requests — no separate
   secret.

## Configuration

| Variable | Required | Purpose |
| --- | --- | --- |
| `SLACK_SIGNING_SECRET` | For the Slack routes | Same HMAC secret `/slack/commands` uses; verifies `/slack/interactions` too. |
| `SLACK_BOT_TOKEN` | For the Snooze modal | Bot token used to call `views.open`. Acknowledge does not need it. |

No database migration is required — alert-action state lives in the same
in-memory store Discord's interactive alerts already use, not a new
Prisma model.

## Testing

Focused automated tests live in
`apps/api/src/modules/slack-interactions/__tests__/slack-interactions.service.test.ts`:
acknowledging updates the card's blocks and replaces (not stacks) a
prior status line, snoozing records the chosen duration and rejects an
invalid or over-long one, the Snooze button opens the modal, and the
shared store makes an acknowledgment recorded by the Slack handler
visible through the same store a Discord-side reader would use.

```bash
npm run test:api -- src/modules/slack-interactions
```

## Compatibility and rollout

- **Additive rollout.** New route, two new buttons appended to the
  existing alert card (within Slack's 5-element actions-block limit),
  and one new optional env var (`SLACK_BOT_TOKEN`); the existing
  Acknowledge button's `action_id` is unchanged so this does not require
  re-sending any already-posted alert.
- **Graceful degradation.** Without `SLACK_BOT_TOKEN`, Snooze's button
  click is still verified and would be recorded if it reached that code
  path, but the modal cannot open; without `SLACK_SIGNING_SECRET`, both
  `/slack/commands` and `/slack/interactions` fail closed (503).
