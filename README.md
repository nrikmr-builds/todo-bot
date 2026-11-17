# todo-bot

A personal to-do list I manage by texting a WhatsApp chat in plain English ("done with the podcast one", "add revise resume under Recruiting", "oops, undo that"). The same list is also available from Claude Code through a `/todo` command.

```
WhatsApp ─► Meta Cloud API ─► Cloudflare Worker (/webhook) ─► Claude Haiku 5.5 + list tools
                                     │                              │
Claude Code /todo ─► bin/todo ─► /api/*  ─────────────►  D1 database (categories, items, archive)
```

## Why I built it

I already kept my to-do lists in WhatsApp. To keep the list on top, I used to copy the last message, edit it by hand, and send it again so it showed up as the most recent message. I chose WhatsApp because I'm already there all day texting friends, so seeing my to-do list among those chats reminds me what I still need to get done.

This bot keeps that habit and removes the manual part. I text changes in plain English, and the bot replies with the updated list, which keeps it at the top of the chat.

## How it works

- **One agent, many front ends.** Free text from WhatsApp, or from the terminal via `bin/todo chat`, goes to a Claude Haiku tool-use loop (`src/agent.ts`). The model never edits the list directly. It calls typed tools (`src/tools.ts`) such as `add_items`, `complete_items`, `move_items` and `restore_items`, and it may only confirm a change after a tool result says the change happened.
- **Stable labels instead of positions.** Items get labels like `A3` or `R5` that don't change when other items are completed, so "x R3" always means the same thing. Loose references ("the econ one") are resolved against the current list, and the agent asks rather than guesses when a reference is ambiguous.
- **Nothing is lost.** Completing an item archives it, `restore_items` undoes it, and `list_done` shows what was finished recently. Categories can be nested ("Recruiting > Networking").
- **Conversation context.** Each request includes the current list and the last few turns, so follow-ups like "undo that" work.

## Security

- Webhook requests are checked against Meta's `X-Hub-Signature-256` HMAC using the app secret, with a constant-time comparison.
- Only one WhatsApp number (`ALLOWED_WA_ID`) can talk to the bot. Messages from anyone else are silently ignored.
- Meta retries webhooks, so each message ID is claimed in D1 before it's handled. A retried message is never applied twice.
- The terminal API (`/api/*`) requires a bearer token. All credentials are Worker secrets; none are in the repo.

## Code map

- `src/store.ts`: list logic (labels, nested categories, archive, rendering) on Cloudflare D1
- `src/tools.ts`: tool definitions shared by the agent and the HTTP API
- `src/agent.ts`: Haiku tool-use loop and system prompt
- `src/whatsapp.ts`: signature check, read receipts and typing indicator, sending replies (split at WhatsApp's 4096-character limit)
- `src/index.ts`: routing, the webhook handler, and the private API
- `bin/todo`: terminal client used by the Claude Code `/todo` skill

## Deploy

```bash
npm install
npx wrangler login
npx wrangler d1 create todo            # paste database_id into wrangler.jsonc
npx wrangler d1 migrations apply todo --remote
for s in ANTHROPIC_API_KEY API_TOKEN WA_VERIFY_TOKEN WA_APP_SECRET WA_TOKEN WA_PHONE_NUMBER_ID ALLOWED_WA_ID; do npx wrangler secret put $s; done
npx wrangler deploy
```

Run `wrangler secret put` in a real terminal. It reads the value from a hidden prompt, and in a non-interactive shell it silently stores an empty value.

## Meta (WhatsApp Cloud API) setup

1. developers.facebook.com → Create app → use case **Connect with customers through WhatsApp**.
2. Use cases → Customize → **Step 1. Try it out**: copy the test number's **Phone number ID** (`WA_PHONE_NUMBER_ID`) and add your own number in the **Recipient** list (`ALLOWED_WA_ID`, digits with country code).
3. App settings → Basic → **App secret** → `WA_APP_SECRET`.
4. business.facebook.com → Settings → System users → add an Admin system user → assign the app and the WhatsApp account with full control → generate a never-expiring token with `whatsapp_business_messaging` and `whatsapp_business_management` → `WA_TOKEN`.
5. Webhook: callback `https://<worker>.workers.dev/webhook`, verify token = `WA_VERIFY_TOKEN`, then subscribe to the **messages** field.
6. Subscribe your WhatsApp Business Account to the app. Without this, Meta sends no webhooks even after step 5:
   ```bash
   curl -X POST "https://graph.facebook.com/v25.0/<WABA_ID>/subscribed_apps" -H "Authorization: Bearer $WA_TOKEN"
   ```
7. WhatsApp contact search won't find the test number. Open `https://wa.me/<test number digits>` on your phone, save the contact, and text it.

## Terminal

`~/.config/todo-bot/env` holds `TODO_URL` and `TODO_TOKEN` (= `API_TOKEN`). Then:

```bash
bin/todo list
bin/todo tool complete_items '{"labels":["R3"]}'
bin/todo chat "add to academics: email the TA"
```
