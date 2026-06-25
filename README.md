# BizChat AI

WhatsApp AI assistant for Pakistani small businesses. Automatically responds to customer inquiries using OpenRouter.

## Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment Variables

Copy `.env.example` to `.env` and fill in your credentials:

```bash
OPENROUTER_API_KEY=your_key_here
DATABASE_URL=postgres://user:password@host:5432/database
DATABASE_SSL=true
WHATSAPP_TOKEN=your_meta_token
VERIFY_TOKEN=your_webhook_verify_token
SESSION_SECRET=change_this_to_a_random_32_plus_character_string
```

### 3. Run the Server

```bash
npm start
```

### 4. Configure WhatsApp Webhook

1. Go to [Meta Developers Console](https://developers.facebook.com)
2. Create a WhatsApp Business app
3. Set webhook URL: `https://your-domain.com/webhook`
4. Use your VERIFY_TOKEN for verification

## Features

- WhatsApp webhook receives customer messages
- AI responses powered by OpenRouter
- Business owner dashboard to manage shop info
- Conversation history viewer
- PKR pricing display

## Deployment

Works on Railway, Render, or any Node.js hosting with Node.js 18+ and PostgreSQL.

Required deployment variables:

- `DATABASE_URL`: PostgreSQL connection string.
- `SESSION_SECRET`: random 32+ character value.
- `OPENROUTER_API_KEY`: OpenRouter API key for AI replies.
- `WHATSAPP_TOKEN`: Meta WhatsApp token.
- `VERIFY_TOKEN`: webhook verification token.

Set `DATABASE_SSL=false` only if your PostgreSQL provider requires plain connections.
