# BizChat AI

WhatsApp AI assistant for Pakistani small businesses. The AI auto-responds to customer inquiries, detects orders, scores leads, and schedules follow-ups automatically.

## Stack

- **Runtime**: Node.js 18+
- **Framework**: Express
- **Database**: PostgreSQL (via `pg`)
- **Auth**: express-session + bcryptjs
- **AI**: OpenRouter API
- **Messaging**: Meta WhatsApp Business API

## How to run

```bash
PORT=5000 node index.js
```

The workflow "Start application" handles this automatically.

## Required environment variables

| Variable | Description |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `SESSION_SECRET` | Random 32+ char string for session encryption |
| `OPENROUTER_API_KEY` | OpenRouter API key for AI responses |
| `WHATSAPP_TOKEN` | Meta WhatsApp permanent token |
| `VERIFY_TOKEN` | Custom string for WhatsApp webhook verification |
| `DATABASE_SSL` | Set to `false` only for plain (non-SSL) PostgreSQL |

## Architecture

- **`index.js`** — All routes, page HTML, AI logic, and background scheduler (single file)
- **`db.js`** — PostgreSQL pool, `createTables()` with safe `IF NOT EXISTS` / `ALTER TABLE` migrations

## Key features

### AI takes action (not just chat)
`generateAIResponse()` returns structured JSON:
- `customer_reply` — the WhatsApp message sent to the customer
- `order_detected` — extracted order data (item, quantity, datetime) or null
- `lead_temperature` — cold / warm / hot based on buying signals
- `needs_follow_up` — whether to schedule a 2-hour follow-up

### Orders table
Detected orders are saved to the `orders` table and shown in the Orders dashboard page with filter tabs (All / New / Confirmed / Completed) and colour-coded status dropdowns.

### Lead temperature
Each conversation record has a `lead_temperature` column updated on every incoming message.

### Follow-up scheduler
`runFollowUpScheduler()` runs via `setInterval` every 10 minutes. It atomically claims due conversations with `UPDATE ... FOR UPDATE SKIP LOCKED`, sends a follow-up WhatsApp message, and only logs it in messages if the send succeeded.

## Database tables

- `businesses` — one row per registered business
- `conversations` — one per (business, customer phone) pair; includes `lead_temperature`, `follow_up_at`, `last_customer_reply_at`
- `messages` — individual in/out messages per conversation
- `orders` — detected orders with status lifecycle (new → confirmed → completed / cancelled)

## WhatsApp webhook

- `GET /webhook` — verification handshake (uses `VERIFY_TOKEN`)
- `POST /webhook` — receives messages, runs AI, sends reply, saves order if detected

## User preferences

- Keep the single-file structure (`index.js`) unless the file grows unmanageable
- Do not restructure or migrate to a different stack without asking
