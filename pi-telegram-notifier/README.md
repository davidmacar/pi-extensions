# Pi Telegram wait notifications

Sends short Spanish Telegram alerts to the private account **@MacDamon15** when Pi asks for input or finishes a run. Responses remain in Pi, as selected during setup. No agent output, question bodies, prompt titles or buttons are sent.

## Activate

1. Revoke the token shared in chat using BotFather and generate a replacement. Do not send the replacement to an agent or put it in a terminal command.
2. Inside this directory, create the local file privately if it does not already exist:

   ```sh
   test -e config.local.json || (umask 077; cp config.local.example.json config.local.json)
   chmod 600 config.local.json
   ```

3. Edit that file yourself: set `botToken` to the replacement; leave `chatId` empty. The username is fixed to MacDamon15. The local file is excluded from Git; it is never read by the test suite.
4. Add this extension path to the existing `extensions` array in Pi settings, preserving other entries:

   ```json
   "/absolute/path/to/pi-extensions/pi-telegram-notifier/index.js"
   ```

5. Restart Pi. Send a fresh `/start` to the bot **privately from @MacDamon15**, then run `/telegram-notifier setup` in Pi. Setup finds that account's direct private message, verifies the current chat identity, and stores its numeric ID locally with mode 0600. Forwarded starts, groups, other users and a different existing chat binding are rejected.
6. Run `/telegram-notifier test` to send a test notice. `/telegram-notifier status` reports configuration only, without testing delivery.

If setup cannot find a recent start, send it again and retry. Pending updates may expire or be consumed by another bot client. Setup uses one short `getUpdates` request, without acknowledging updates by offset. A webhook or another update consumer can prevent discovery; setup reports failure and preserves the existing binding. Normal notifications do not poll updates or consume replies.

## What triggers a notice

- `ui_prompt_start` sends a fixed message asking you to open Pi. There is no remote answer path. Finishing that prompt and later finishing the task produces a separate completion notice.
- `agent_settled` is the final idle boundary, unlike `agent_end`. Aborted runs, open prompts, duplicate settlements and headless JSON/print child sessions do not produce completion notices. Only interactive TUI sessions participate.
- Each send rechecks that `getChat` returns the pinned private chat and the allowed username. API calls time out after eight seconds, reject redirects and expose only generic errors locally. There is no automatic resend, avoiding duplicate Telegram messages.

## Subagents

Completion notices query Gentle 4.9's existing display events: `gentle-pi:herdr-desktop:tasks-request` and the synchronous `gentle-pi:herdr-desktop:tasks` response for the current `sessionId`. Queued, running and waiting children all count as active, so no completion notice is sent while any remain. A fresh empty active snapshot permits the notice; snapshots are never cached. No task labels or prompts are forwarded.

With no subagent/orchestrator tools, normal Pi settlement is sufficient. If those tools exist but the publisher is unavailable, malformed or belongs to another session, **completion notices are suppressed** with a local explanation. Other spawners require their own adapter; Pi has no universal detached-child registry. Input-prompt alerts still work. This event integration controls notifications only and never changes agent work or routing.

## Development

Run `npm test` in this directory. Tests use injected dummy config and transports, and preload a global fetch block. They never read the live local config or intentionally contact Telegram. Restart Pi after code changes because native ESM modules can remain cached across `/reload`.
