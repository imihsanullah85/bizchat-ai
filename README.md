# BizChat AI

WhatsApp AI assistant for Pakistani small businesses. Automatically responds to customer inquiries using Google Gemini AI.

## Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment Variables

Copy `.env.example` to `.env` and fill in your credentials:

```bash
GEMINI_API_KEY=your_key_here
WHATSAPP_TOKEN=your_meta_token
VERIFY_TOKEN=your_webhook_verify_token
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
- AI responses powered by Google Gemini
- Business owner dashboard to manage shop info
- Conversation history viewer
- PKR pricing display

## Deployment

Works on Railway, Render, or any Node.js hosting.
