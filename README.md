[README.md](https://github.com/user-attachments/files/35416365/README.md)
# Discord moderation bot starter

This starter has `/help`, `/ping`, `/timeout`, `/kick`, and `/ban`, plus phrase-based rule review.
Rule matches are sent to a moderator channel; the bot does not delete messages or take action on its own.

## Setup

1. Install Node.js, then run `npm install` in this folder.
2. Create an application and bot in the [Discord Developer Portal](https://discord.com/developers/applications).
3. Copy `.env.example` to `.env` and fill in the bot token and application ID.
4. To test quickly, set `GUILD_ID` to your test server's ID. Remove it to register commands globally; global command updates can take longer to appear.
5. In the Developer Portal, enable the **Message Content Intent** under the bot's privileged gateway intents. The bot needs it to inspect messages.
6. Invite the bot to your test server with the `bot` and `applications.commands` scopes. Give it only the permissions it needs: View Channels, Send Messages in the private moderator review channel, Moderate Members, Kick Members, and Ban Members.
7. Run `npm start`.

## Configure rule review

1. Make a private text channel that only moderators can view.
2. Run `/modlog set` and choose that channel.
3. Use `/rule add` to enter a short rule name, its exact trigger phrase, and the server rule moderators should check. New rules are drafts. Add separate rules for separate phrases.
4. Use `/rule test` with sample text to preview what would match without posting a report. Use `/rule enable` to start reviewing matches; `/rule disable`, `/rule list`, and `/rule remove` manage rules.
5. Review reports with **Confirm violation** or **False alarm** buttons. `/rule stats` shows those counts so admins can tune phrases.

Matching is case-insensitive and ignores repeated whitespace, but it looks for the configured phrase as written. It does not understand context or infer meaning from a rules document. Every match is only a moderator review suggestion; no automatic warning, deletion, timeout, kick, or ban happens. Reports include a message excerpt, link, and feedback buttons in the configured channel. Only members with Manage Messages or Manage Server can review them. Feedback updates counts but does not automatically change rules or take action. Keep the review channel private.

Server configuration is saved locally in `data/guild-settings.json`; back it up if needed. Never share or commit your bot token.
