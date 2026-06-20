const express = require('express');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'bizchat-data.json');

function loadData() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed.nextIds) {
      parsed.nextIds = { business: 1, conversation: 1, message: 1 };
    }
    parsed.businesses = parsed.businesses || [];
    parsed.conversations = parsed.conversations || [];
    parsed.messages = parsed.messages || [];
    return parsed;
  } catch (error) {
    return {
      nextIds: { business: 1, conversation: 1, message: 1 },
      businesses: [],
      conversations: [],
      messages: []
    };
  }
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
  return data;
}

function getBusinessByWhatsAppPhoneId(phoneId) {
  const data = loadData();
  return data.businesses.find(b => b.whatsapp_phone_id === phoneId);
}

function getBusinessByEmail(email) {
  const data = loadData();
  return data.businesses.find(b => b.email === email);
}

function getBusinessById(id) {
  const data = loadData();
  return data.businesses.find(b => b.id === id);
}

function insertBusiness(email, passwordHash, shopName) {
  const data = loadData();
  const business = {
    id: data.nextIds.business++,
    email,
    password_hash: passwordHash,
    shop_name: shopName || 'My Shop',
    description: '',
    services: '',
    prices: '',
    timings: '',
    faqs: '',
    whatsapp_number: '',
    whatsapp_phone_id: '',
    payment_link: '',
    monthly_fee: 5000,
    created_at: new Date().toISOString()
  };
  data.businesses.push(business);
  saveData(data);
  return business;
}

function updateBusiness(id, updates) {
  const data = loadData();
  const business = data.businesses.find(b => b.id === id);
  if (!business) return null;
  Object.assign(business, updates);
  saveData(data);
  return business;
}

function ensureConversation(businessId, customerPhone, customerName) {
  const data = loadData();
  let conversation = data.conversations.find(c => c.business_id === businessId && c.customer_phone === customerPhone);
  if (!conversation) {
    conversation = {
      id: data.nextIds.conversation++,
      business_id: businessId,
      customer_phone: customerPhone,
      customer_name: customerName || '',
      created_at: new Date().toISOString()
    };
    data.conversations.push(conversation);
    saveData(data);
  }
  return conversation;
}

function insertMessage(conversationId, direction, content) {
  const data = loadData();
  const message = {
    id: data.nextIds.message++,
    conversation_id: conversationId,
    direction,
    content,
    timestamp: new Date().toISOString()
  };
  data.messages.push(message);
  saveData(data);
  return message;
}

function getConversationsForBusiness(businessId) {
  const data = loadData();
  return data.conversations
    .filter(c => c.business_id === businessId)
    .map(c => {
      const messages = data.messages.filter(m => m.conversation_id === c.id).sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
      const lastMessage = messages.length ? messages[messages.length - 1] : null;
      return {
        ...c,
        message_count: messages.length,
        last_message: lastMessage ? lastMessage.content : null,
        last_message_time: lastMessage ? lastMessage.timestamp : null
      };
    })
    .sort((a, b) => new Date(b.last_message_time || 0) - new Date(a.last_message_time || 0));
}

function getConversationByIdAndBusiness(id, businessId) {
  const data = loadData();
  return data.conversations.find(c => c.id === Number(id) && c.business_id === businessId);
}

function getMessagesForConversation(conversationId) {
  const data = loadData();
  return data.messages
    .filter(m => m.conversation_id === Number(conversationId))
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
}

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'bizchat-secret-change-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

// OpenRouter AI setup
// Uses OPENROUTER_API_KEY from environment variables.

// Helper: require auth
function requireAuth(req, res, next) {
  if (!req.session.businessId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
}

// ============================================
// WHATSAPP WEBHOOK
// ============================================

// Webhook verification (Meta calls this when setting up)
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  const verifyToken = process.env.VERIFY_TOKEN || 'bizchat_verify_token';

  if (mode === 'subscribe' && token === verifyToken) {
    console.log('Webhook verified');
    return res.status(200).send(challenge);
  }

  res.status(403).send('Verification failed');
});

// Receive WhatsApp messages
app.post('/webhook', async (req, res) => {
  try {
    const data = req.body;

    if (data.object !== 'whatsapp_business_account') {
      return res.status(200).send('OK');
    }

    for (const entry of data.entry || []) {
      for (const change of entry.changes || []) {
        const messages = change.value.messages || [];

        for (const msg of messages) {
          await handleWhatsAppMessage(msg, change.value);
        }
      }
    }

    res.status(200).send('OK');
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(200).send('OK');
  }
});

async function handleWhatsAppMessage(msg, value) {
  const customerPhone = msg.from;
  const businessPhoneId = value.metadata?.phone_number_id;
  const messageText = msg.text?.body || '';
  const customerName = msg.profile?.name || 'Customer';

  if (!messageText) return;

  // Find business by WhatsApp phone ID
  const business = getBusinessByWhatsAppPhoneId(businessPhoneId);

  if (!business) {
    console.log('No business found for phone ID:', businessPhoneId);
    return;
  }

  // Create or get conversation
  const conversation = ensureConversation(business.id, customerPhone, customerName);

  // Store incoming message
  insertMessage(conversation.id, 'in', messageText);

  // Generate AI response
  const aiResponse = await generateAIResponse(business, messageText);

  // Store outgoing message
  insertMessage(conversation.id, 'out', aiResponse);

  // Send response to WhatsApp
  await sendWhatsAppMessage(business.whatsapp_number, businessPhoneId, customerPhone, aiResponse);
}

async function generateAIResponse(business, customerMessage) {
  const systemPrompt = `You are a helpful AI assistant for "${business.shop_name}", a business in Pakistan.

BUSINESS INFORMATION:
- Shop Name: ${business.shop_name}
- Description: ${business.description}
- Services: ${business.services}
- Prices: ${business.prices}
- Working Hours: ${business.timings}
- FAQs: ${business.faqs}

INSTRUCTIONS:
- Respond in a friendly, helpful manner
- Keep responses concise (under 200 words)
- If asked about prices, services, or timings, use the business info provided
- If you don't know something specific, suggest the customer contact the shop directly
- Be polite and use Pakistani English expressions naturally
- For questions not related to the business, politely redirect to business topics`;

  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'openrouter/free',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: customerMessage }
        ]
      })
    });

    const data = await response.json();
    if (data.error) {
      console.error('OpenRouter error:', data.error);
      return 'Sorry, I am having trouble responding right now. Please try again or contact the shop directly.';
    }

    return data.choices?.[0]?.message?.content || 'Sorry, I am having trouble responding right now. Please try again or contact the shop directly.';
  } catch (error) {
    console.error('OpenRouter fetch error:', error);
    return 'Sorry, I am having trouble responding right now. Please try again or contact the shop directly.';
  }
}

async function sendWhatsAppMessage(whatsappNumber, phoneId, to, text) {
  const token = process.env.WHATSAPP_TOKEN;

  if (!token || !phoneId) {
    console.log('WhatsApp credentials not configured');
    return;
  }

  try {
    const response = await fetch(
      `https://graph.facebook.com/v19.0/${phoneId}/messages`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: to,
          type: 'text',
          text: { body: text }
        })
      }
    );

    const data = await response.json();
    console.log('WhatsApp send result:', data);
  } catch (error) {
    console.error('WhatsApp send error:', error);
  }
}

// ============================================
// AUTH ROUTES
// ============================================

app.post('/api/auth/register', async (req, res) => {
  const { email, password, shop_name } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password required' });
  }

  try {
    const existing = getBusinessByEmail(email);
    if (existing) {
      return res.status(400).json({ error: 'Email already registered' });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const business = insertBusiness(email, passwordHash, shop_name || 'My Shop');

    req.session.businessId = business.id;
    res.json({ success: true, businessId: business.id });
  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({ error: 'Registration failed' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password required' });
  }

  try {
    const business = getBusinessByEmail(email);

    if (!business) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const valid = await bcrypt.compare(password, business.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    req.session.businessId = business.id;
    res.json({ success: true, businessId: business.id });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ success: true });
  });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  const business = getBusinessById(req.session.businessId);
  res.json(business);
});

// ============================================
// BUSINESS ROUTES
// ============================================

app.put('/api/business', requireAuth, (req, res) => {
  const {
    shop_name, description, services, prices, timings,
    faqs, whatsapp_number, whatsapp_phone_id, payment_link
  } = req.body;

  try {
    updateBusiness(req.session.businessId, {
      shop_name: shop_name || '',
      description: description || '',
      services: services || '',
      prices: prices || '',
      timings: timings || '',
      faqs: faqs || '',
      whatsapp_number: whatsapp_number || '',
      whatsapp_phone_id: whatsapp_phone_id || '',
      payment_link: payment_link || ''
    });

    res.json({ success: true });
  } catch (error) {
    console.error('Update error:', error);
    res.status(500).json({ error: 'Update failed' });
  }
});

// ============================================
// CONVERSATIONS ROUTES
// ============================================

app.get('/api/conversations', requireAuth, (req, res) => {
  const conversations = getConversationsForBusiness(req.session.businessId);
  res.json(conversations);
});

app.get('/api/conversations/:id/messages', requireAuth, (req, res) => {
  const conversation = getConversationByIdAndBusiness(req.params.id, req.session.businessId);

  if (!conversation) {
    return res.status(404).json({ error: 'Conversation not found' });
  }

  const messages = getMessagesForConversation(req.params.id);

  res.json({ conversation, messages });
});

// ============================================
// DASHBOARD HTML
// ============================================

app.get('/', (req, res) => {
  if (req.session.businessId) {
    res.redirect('/dashboard');
  } else {
    res.redirect('/login');
  }
});

app.get('/login', (req, res) => {
  res.send(getLoginPage());
});

app.get('/register', (req, res) => {
  res.send(getRegisterPage());
});

app.get('/dashboard', (req, res) => {
  if (!req.session.businessId) {
    return res.redirect('/login');
  }
  res.send(getDashboardPage());
});

app.get('/settings', (req, res) => {
  if (!req.session.businessId) {
    return res.redirect('/login');
  }
  res.send(getSettingsPage());
});

app.get('/conversations/:id', (req, res) => {
  if (!req.session.businessId) {
    return res.redirect('/login');
  }
  res.send(getConversationPage(req.params.id));
});

// ============================================
// HTML PAGES
// ============================================

function getLoginPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>BizChat AI - Login</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: radial-gradient(circle at top left, #0f172a 0%, #1e293b 35%, #020617 100%); min-height: 100vh; display: flex; align-items: center; justify-content: center; color: #f8fafc; }
    body::before { content: ''; position: fixed; inset: 0; background: radial-gradient(circle at 20% 20%, rgba(59,130,246,0.18), transparent 28%), radial-gradient(circle at 80% 10%, rgba(14,165,233,0.1), transparent 20%), radial-gradient(circle at 50% 90%, rgba(99,102,241,0.12), transparent 25%); pointer-events: none; }
    .container { position: relative; width: min(100%, 420px); background: rgba(15, 23, 42, 0.9); border: 1px solid rgba(148,163,184,0.2); border-radius: 32px; padding: 40px 36px; backdrop-filter: blur(24px); box-shadow: 0 40px 90px rgba(15,23,42,0.42); }
    .brand { display: inline-flex; align-items: center; gap: 10px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; font-size: 12px; color: #38bdf8; margin-bottom: 20px; }
    .brand::before { content: '•'; color: #60a5fa; }
    h1 { font-size: 34px; font-weight: 800; color: #f8fafc; margin-bottom: 10px; }
    p.subtitle { color: #cbd5e1; line-height: 1.7; margin-bottom: 32px; }
    .form-group { margin-bottom: 20px; }
    label { display: block; margin-bottom: 8px; font-size: 14px; color: #e2e8f0; }
    input { width: 100%; border: 1px solid rgba(148,163,184,0.25); border-radius: 14px; padding: 14px 16px; background: rgba(255,255,255,0.05); color: #f8fafc; font-size: 15px; transition: border-color 0.2s, transform 0.2s; }
    input::placeholder { color: #94a3b8; }
    input:focus { outline: none; border-color: #38bdf8; transform: translateY(-1px); box-shadow: 0 0 0 4px rgba(56,189,248,0.12); }
    button { width: 100%; padding: 16px; border-radius: 14px; border: none; background: linear-gradient(135deg, #38bdf8 0%, #6366f1 100%); color: white; font-size: 16px; font-weight: 700; cursor: pointer; transition: transform 0.2s, opacity 0.2s; }
    button:hover { transform: translateY(-1px); opacity: 0.96; }
    .footer { margin-top: 26px; text-align: center; color: #94a3b8; font-size: 14px; }
    .footer a { color: #38bdf8; text-decoration: none; font-weight: 600; }
    .footer a:hover { text-decoration: underline; }
    .error { background: rgba(248,113,113,0.12); color: #fecaca; border: 1px solid rgba(248,113,113,0.3); padding: 14px 16px; border-radius: 14px; margin-bottom: 22px; display: none; }
  </style>
</head>
<body>
  <div class="container">
    <div class="brand">BizChat AI</div>
    <h1>Welcome Back</h1>
    <p class="subtitle">Sign in and access your AI-powered WhatsApp commerce dashboard instantly.</p>
    <div id="error" class="error"></div>
    <form id="loginForm">
      <div class="form-group">
        <label for="email">Email</label>
        <input type="email" id="email" required placeholder="hello@business.com">
      </div>
      <div class="form-group">
        <label for="password">Password</label>
        <input type="password" id="password" required placeholder="Your secure password">
      </div>
      <button type="submit">Sign In</button>
    </form>
    <p class="footer">Don't have an account? <a href="/register">Create one</a></p>
  </div>
  <script>
    document.getElementById('loginForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const error = document.getElementById('error');
      error.style.display = 'none';
      const email = document.getElementById('email').value;
      const password = document.getElementById('password').value;

      try {
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password })
        });
        const data = await res.json();
        if (data.success) {
          window.location = '/dashboard';
        } else {
          error.textContent = data.error || 'Invalid email or password.';
          error.style.display = 'block';
        }
      } catch (err) {
        error.textContent = 'Login failed. Please try again.';
        error.style.display = 'block';
      }
    });
  </script>
</body>
</html>`;
}

function getRegisterPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>BizChat AI - Register</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: radial-gradient(circle at top left, #0f172a 0%, #1e293b 35%, #020617 100%); min-height: 100vh; display: flex; align-items: center; justify-content: center; color: #f8fafc; padding: 24px; }
    body::before { content: ''; position: fixed; inset: 0; background: radial-gradient(circle at 20% 15%, rgba(16,185,129,0.16), transparent 24%), radial-gradient(circle at 80% 20%, rgba(59,130,246,0.14), transparent 18%); pointer-events: none; }
    .container { position: relative; width: min(100%, 460px); background: rgba(15, 23, 42, 0.92); border: 1px solid rgba(148,163,184,0.18); border-radius: 32px; padding: 42px 38px; backdrop-filter: blur(24px); box-shadow: 0 40px 90px rgba(15,23,42,0.42); }
    .brand { display: inline-flex; align-items: center; gap: 10px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; font-size: 12px; color: #34d399; margin-bottom: 20px; }
    .brand::before { content: '•'; color: #60a5fa; }
    h1 { font-size: 34px; font-weight: 800; color: #f8fafc; margin-bottom: 10px; }
    p.subtitle { color: #cbd5e1; line-height: 1.7; margin-bottom: 32px; }
    .form-group { margin-bottom: 20px; }
    label { display: block; margin-bottom: 8px; font-size: 14px; color: #e2e8f0; }
    input { width: 100%; border: 1px solid rgba(148,163,184,0.24); border-radius: 14px; padding: 14px 16px; background: rgba(255,255,255,0.05); color: #f8fafc; font-size: 15px; transition: border-color 0.2s, transform 0.2s; }
    input::placeholder { color: #94a3b8; }
    input:focus { outline: none; border-color: #34d399; transform: translateY(-1px); box-shadow: 0 0 0 4px rgba(52,211,153,0.14); }
    button { width: 100%; padding: 16px; border-radius: 14px; border: none; background: linear-gradient(135deg, #22c55e 0%, #3b82f6 100%); color: white; font-size: 16px; font-weight: 700; cursor: pointer; transition: transform 0.2s, opacity 0.2s; }
    button:hover { transform: translateY(-1px); opacity: 0.96; }
    .footer { margin-top: 26px; text-align: center; color: #94a3b8; font-size: 14px; }
    .footer a { color: #38bdf8; text-decoration: none; font-weight: 600; }
    .footer a:hover { text-decoration: underline; }
    .error { background: rgba(248,113,113,0.12); color: #fecaca; border: 1px solid rgba(248,113,113,0.3); padding: 14px 16px; border-radius: 14px; margin-bottom: 22px; display: none; }
  </style>
</head>
<body>
  <div class="container">
    <div class="brand">BizChat AI</div>
    <h1>Create Account</h1>
    <p class="subtitle">Build your WhatsApp AI assistant and start converting conversations into sales.</p>
    <div id="error" class="error"></div>
    <form id="registerForm">
      <div class="form-group">
        <label for="shop_name">Shop Name</label>
        <input type="text" id="shop_name" required placeholder="e.g., Ahmed Electronics">
      </div>
      <div class="form-group">
        <label for="email">Email</label>
        <input type="email" id="email" required placeholder="hello@business.com">
      </div>
      <div class="form-group">
        <label for="password">Password</label>
        <input type="password" id="password" required placeholder="Create a password">
      </div>
      <button type="submit">Create Account</button>
    </form>
    <p class="footer">Already have an account? <a href="/login">Sign in</a></p>
  </div>
  <script>
    document.getElementById('registerForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const error = document.getElementById('error');
      error.style.display = 'none';
      const shop_name = document.getElementById('shop_name').value;
      const email = document.getElementById('email').value;
      const password = document.getElementById('password').value;

      try {
        const res = await fetch('/api/auth/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ shop_name, email, password })
        });
        const data = await res.json();
        if (data.success) {
          window.location = '/settings';
        } else {
          error.textContent = data.error || 'Registration failed.';
          error.style.display = 'block';
        }
      } catch (err) {
        error.textContent = 'Registration failed. Please try again.';
        error.style.display = 'block';
      }
    });
  </script>
</body>
</html>`;
}

function getDashboardPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>BizChat AI - Dashboard</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f1f5f9; color: #0f172a; min-height: 100vh; }
    .header { background: linear-gradient(135deg, #0f172a 0%, #1e3a5f 100%); color: white; padding: 24px 36px; display: flex; justify-content: space-between; align-items: center; gap: 20px; }
    .brand { display: flex; align-items: center; gap: 12px; font-size: 20px; font-weight: 700; letter-spacing: 0.02em; }
    .nav { display: flex; gap: 18px; flex-wrap: wrap; }
    .nav a { color: rgba(255,255,255,0.86); text-decoration: none; font-size: 14px; transition: color 0.2s; }
    .nav a:hover { color: #ffffff; }
    .container { max-width: 1240px; margin: 0 auto; padding: 32px 28px 48px; }
    .hero { display: grid; grid-template-columns: 1.6fr 1fr; gap: 24px; margin-bottom: 32px; }
    .hero-card { background: white; border-radius: 24px; padding: 28px; box-shadow: 0 20px 60px rgba(15,23,42,0.08); border: 1px solid rgba(148,163,184,0.12); }
    .hero-title { font-size: 24px; font-weight: 700; margin-bottom: 10px; }
    .hero-copy { color: #475569; line-height: 1.7; margin-bottom: 24px; }
    .status-badges { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 18px; }
    .badge { padding: 10px 14px; border-radius: 999px; font-size: 13px; font-weight: 700; letter-spacing: 0.01em; }
    .badge.online { background: #d1fae5; color: #065f46; }
    .badge.pending { background: #fef9c3; color: #78350f; }
    .badge.complete { background: #cffafe; color: #0c4a6e; }
    .cta-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; margin-top: 24px; }
    .action-card { background: #0f172a; color: white; border-radius: 18px; padding: 20px; box-shadow: 0 20px 60px rgba(15,23,42,0.14); transition: transform 0.2s; text-decoration: none; }
    .action-card:hover { transform: translateY(-2px); }
    .action-card h3 { font-size: 16px; margin-bottom: 10px; }
    .action-card p { color: rgba(255,255,255,0.72); font-size: 14px; line-height: 1.7; }
    .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 24px; margin-bottom: 40px; }
    .stat-card { background: white; padding: 24px; border-radius: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    .stat-card h3 { font-size: 14px; color: #64748b; margin-bottom: 8px; }
    .stat-card .value { font-size: 32px; font-weight: 700; color: #1e293b; }
    .card-grid { display: grid; gap: 24px; grid-template-columns: 1.4fr 1fr; margin-bottom: 32px; }
    .panel { background: white; border-radius: 24px; padding: 28px; box-shadow: 0 24px 60px rgba(15,23,42,0.08); border: 1px solid rgba(148,163,184,0.14); }
    .panel h2 { font-size: 20px; font-weight: 700; margin-bottom: 16px; }
    .stat-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 18px; }
    .stat-card { border-radius: 20px; padding: 22px; background: #f8fafc; border: 1px solid rgba(148,163,184,0.18); }
    .stat-card strong { display: block; font-size: 32px; margin-top: 12px; color: #0f172a; }
    .stat-card span { font-size: 14px; color: #64748b; }
    .progress { margin-top: 20px; }
    .progress-bar { height: 12px; border-radius: 999px; background: #e2e8f0; overflow: hidden; }
    .progress-fill { height: 100%; border-radius: 999px; background: linear-gradient(90deg, #38bdf8, #22c55e); width: 0%; transition: width 0.4s ease; }
    .conversation-list { display: grid; gap: 12px; }
    .conv-item { background: #f8fafc; border-radius: 18px; padding: 18px 20px; display: grid; grid-template-columns: auto 1fr auto; gap: 14px; align-items: center; cursor: pointer; transition: transform 0.2s, background 0.2s; }
    .conv-item:hover { transform: translateY(-1px); background: #ffffff; }
    .conv-icon { width: 42px; height: 42px; border-radius: 14px; display: grid; place-items: center; background: #e0f2fe; color: #0c4a6e; font-weight: 700; }
    .conv-meta { display: grid; gap: 6px; }
    .conv-phone { font-weight: 700; color: #0f172a; }
    .conv-name { font-size: 14px; color: #64748b; }
    .conv-last { color: #475569; font-size: 14px; line-height: 1.5; max-width: 360px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .conv-time { font-size: 12px; color: #94a3b8; }
    .notice { background: #fef3c7; border: 1px solid #fde68a; padding: 18px 22px; border-radius: 18px; display: grid; gap: 14px; margin-bottom: 24px; }
    .notice strong { color: #92400e; }
    .notice a { align-self: start; display: inline-flex; padding: 12px 20px; border-radius: 12px; background: #d97706; color: white; text-decoration: none; font-weight: 700; }
    .small-text { color: #64748b; font-size: 14px; }
    .setup-list { margin-top: 22px; display: grid; gap: 12px; }
    .setup-item { display: flex; align-items: center; gap: 12px; font-size: 14px; color: #475569; }
    .setup-item span { display: inline-flex; width: 22px; height: 22px; align-items: center; justify-content: center; border-radius: 8px; background: #e2e8f0; color: #0f172a; font-weight: 700; }
    .card-grid { display: grid; gap: 24px; grid-template-columns: 1.4fr 1fr; margin-bottom: 32px; }
    .panel { background: white; border-radius: 24px; padding: 28px; box-shadow: 0 24px 60px rgba(15,23,42,0.08); border: 1px solid rgba(148,163,184,0.14); }
    .panel h2 { font-size: 20px; font-weight: 700; margin-bottom: 16px; }
    .stat-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 18px; }
    .stat-card { border-radius: 20px; padding: 22px; background: #f8fafc; border: 1px solid rgba(148,163,184,0.18); }
    .stat-card strong { display: block; font-size: 32px; margin-top: 12px; color: #0f172a; }
    .stat-card span { font-size: 14px; color: #64748b; }
    .progress { margin-top: 20px; }
    .progress-bar { height: 12px; border-radius: 999px; background: #e2e8f0; overflow: hidden; }
    .progress-fill { height: 100%; border-radius: 999px; background: linear-gradient(90deg, #38bdf8, #22c55e); width: 0%; transition: width 0.4s ease; }
    .conversation-list { display: grid; gap: 12px; }
    .conv-item { background: #f8fafc; border-radius: 18px; padding: 18px 20px; display: grid; grid-template-columns: auto 1fr auto; gap: 14px; align-items: center; cursor: pointer; transition: transform 0.2s, background 0.2s; }
    .conv-item:hover { transform: translateY(-1px); background: #ffffff; }
    .conv-icon { width: 42px; height: 42px; border-radius: 14px; display: grid; place-items: center; background: #e0f2fe; color: #0c4a6e; font-weight: 700; }
    .conv-meta { display: grid; gap: 6px; }
    .conv-phone { font-weight: 700; color: #0f172a; }
    .conv-name { font-size: 14px; color: #64748b; }
    .conv-last { color: #475569; font-size: 14px; line-height: 1.5; max-width: 360px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .conv-time { font-size: 12px; color: #94a3b8; }
    @media (max-width: 980px) {
      .header, .hero, .card-grid, .cta-grid, .stat-grid { grid-template-columns: 1fr; }
      .hero { display: block; }
      .cta-grid { display: grid; }
      .stat-grid { display: grid; }
    }
  </style>
</head>
<body>
  <header class="header">
    <div class="brand">BizChat AI</div>
    <nav class="nav">
      <a href="/dashboard">Dashboard</a>
      <a href="/settings">Settings</a>
      <a href="#" onclick="logout()">Logout</a>
    </nav>
  </header>
  <main class="container">
    <section class="hero-card hero">
      <div>
        <p class="badge online">AI Assistant Live</p>
        <h1 class="hero-title">Powerful WhatsApp automation for your business</h1>
        <p class="hero-copy">Manage conversations, monitor performance, and complete setup from one polished dashboard.</p>
        <div class="status-badges">
          <span class="badge complete">Smart replies</span>
          <span class="badge complete">WhatsApp integration</span>
          <span class="badge pending">Payment setup</span>
        </div>
      </div>
      <div class="stat-grid">
        <div class="stat-card"><span>Total conversations</span><strong id="convCount">0</strong></div>
        <div class="stat-card"><span>Messages this month</span><strong id="msgCount">0</strong></div>
        <div class="stat-card"><span>Business score</span><strong id="setupScore">0%</strong></div>
      </div>
    </section>

    <section class="cta-grid">
      <a href="/settings" class="action-card">
        <h3>Complete your setup</h3>
        <p>Update business details, WhatsApp credentials and payment info to unlock full AI support.</p>
      </a>
      <a href="/dashboard" class="action-card">
        <h3>Review conversations</h3>
        <p>Open your most recent conversations and see customer requests in real time.</p>
      </a>
      <a href="/settings" class="action-card">
        <h3>Manage billing</h3>
        <p>Connect your payment gateway and activate assistant payments with one click.</p>
      </a>
    </section>

    <div id="paymentNotice" class="notice" style="display: none;">
      <strong>Payment setup required</strong>
      <p>To fully activate your AI assistant, add a payment link in Settings.</p>
      <a id="paymentLink" href="#">Go to Settings</a>
      <p class="small-text">Your monthly fee is PKR <span id="monthlyFee"></span>. Once configured, customers can pay instantly.</p>
    </div>

    <div class="card-grid">
      <section class="panel">
        <h2>Setup progress</h2>
        <p class="small-text">A quick look at your business readiness score and key setup steps.</p>
        <div class="progress"><div class="progress-bar"><div class="progress-fill" id="progressFill"></div></div></div>
        <div style="margin-top: 14px;"><strong id="setupScoreLabel">0% complete</strong></div>
        <div class="setup-list">
          <div class="setup-item"><span id="item1">✕</span> Business info</div>
          <div class="setup-item"><span id="item2">✕</span> WhatsApp config</div>
          <div class="setup-item"><span id="item3">✕</span> Payment link</div>
        </div>
      </section>
      <section class="panel">
        <h2>Recent conversations</h2>
        <div class="conversation-list" id="convList">
          <div class="conv-item"><div class="conv-meta"><div class="conv-phone">Loading...</div></div></div>
        </div>
      </section>
    </div>
  </main>
  <script>
    async function loadDashboard() {
      try {
        const me = await fetch('/api/auth/me').then(r => r.json());
        if (me.error) {
          window.location = '/login';
          return;
        }

        const convs = await fetch('/api/conversations').then(r => r.json());
        document.getElementById('convCount').textContent = convs.length;

        const configItems = [
          { label: 'Business info', value: me.shop_name },
          { label: 'WhatsApp config', value: me.whatsapp_phone_id && me.whatsapp_number },
          { label: 'Payment link', value: me.payment_link }
        ];
        const completed = configItems.filter(item => item.value).length;
        const progressValue = Math.round((completed / configItems.length) * 100);
        document.getElementById('setupScore').textContent = \`\${progressValue}%\`;
        document.getElementById('setupScoreLabel').textContent = \`\${progressValue}% complete\`;
        document.getElementById('progressFill').style.width = \`\${progressValue}%\`;

        configItems.forEach((item, index) => {
          const span = document.getElementById(\`item\${index + 1}\`);
          if (item.value) {
            span.textContent = '✓';
            span.style.background = '#d1fae5';
            span.style.color = '#166534';
          } else {
            span.textContent = '✕';
            span.style.background = '#f8fafc';
            span.style.color = '#475569';
          }
        });

        if (!me.payment_link) {
          document.getElementById('paymentNotice').style.display = 'grid';
          document.getElementById('paymentLink').href = '/settings';
          document.getElementById('monthlyFee').textContent = (me.monthly_fee || 5000).toLocaleString();
        }

        const list = document.getElementById('convList');
        if (convs.length === 0) {
          list.innerHTML = '<div class="empty">No conversations yet. Customer messages will appear here.</div>';
        } else {
          list.innerHTML = convs.map(c => \`
            <div class="conv-item" onclick="window.location='/conversations/\${c.id}'">
              <div>
                <div class="conv-phone">\${c.customer_phone}</div>
                <div class="conv-name">\${c.customer_name || 'Customer'}</div>
              </div>
              <div>
                <div class="conv-last">\${c.last_message || ''}</div>
                <div class="conv-time">\${c.last_message_time ? new Date(c.last_message_time).toLocaleDateString() : ''}</div>
              </div>
            </div>
          \`).join('');
        }

        const allMsgs = await Promise.all(convs.map(c => fetch('/api/conversations/' + c.id + '/messages').then(r => r.json())));
        const total = allMsgs.reduce((sum, m) => sum + (m.messages?.length || 0), 0);
        document.getElementById('msgCount').textContent = total;
      } catch (err) {
        console.error(err);
      }
    }

    async function logout() {
      await fetch('/api/auth/logout', { method: 'POST' });
      window.location = '/login';
    }

    loadDashboard();
  </script>
</body>
</html>`;
}

function getSettingsPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>BizChat AI - Settings</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f8fafc; min-height: 100vh; }
    .header { background: linear-gradient(135deg, #1e3a5f 0%, #0f172a 100%); color: white; padding: 20px 40px; display: flex; justify-content: space-between; align-items: center; }
    .header h1 { font-size: 24px; font-weight: 700; }
    .nav { display: flex; gap: 24px; align-items: center; }
    .nav a { color: rgba(255,255,255,0.8); text-decoration: none; font-size: 14px; transition: color 0.2s; }
    .nav a:hover { color: white; }
    .container { max-width: 800px; margin: 0 auto; padding: 40px; }
    .card { background: white; border-radius: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); padding: 32px; margin-bottom: 24px; }
    .card h2 { font-size: 20px; font-weight: 600; color: #1e293b; margin-bottom: 24px; }
    .form-group { margin-bottom: 20px; }
    label { display: block; font-size: 14px; font-weight: 500; color: #475569; margin-bottom: 6px; }
    input, textarea { width: 100%; padding: 12px 16px; border: 1px solid #e2e8f0; border-radius: 8px; font-size: 14px; font-family: inherit; }
    textarea { min-height: 100px; resize: vertical; }
    input:focus, textarea:focus { outline: none; border-color: #3b82f6; box-shadow: 0 0 0 3px rgba(59,130,246,0.1); }
    button { background: #3b82f6; color: white; padding: 14px 28px; border: none; border-radius: 8px; font-size: 16px; font-weight: 600; cursor: pointer; transition: background 0.2s; }
    button:hover { background: #2563eb; }
    .success { background: #ecfdf5; color: #059669; padding: 12px; border-radius: 8px; margin-bottom: 20px; display: none; }
    .help { font-size: 12px; color: #94a3b8; margin-top: 4px; }
  </style>
</head>
<body>
  <header class="header">
    <h1>BizChat AI</h1>
    <nav class="nav">
      <a href="/dashboard">Dashboard</a>
      <a href="/settings">Settings</a>
      <a href="#" onclick="logout()">Logout</a>
    </nav>
  </header>
  <div class="container">
    <div id="success" class="success">Settings saved successfully!</div>

    <div class="card">
      <h2>Business Information</h2>
      <p style="color: #64748b; margin-bottom: 24px;">This information will be used by the AI to answer customer questions.</p>
      <form id="settingsForm">
        <div class="form-group">
          <label for="shop_name">Shop Name</label>
          <input type="text" id="shop_name" placeholder="e.g., Ahmed Electronics">
        </div>
        <div class="form-group">
          <label for="description">Description</label>
          <textarea id="description" placeholder="Brief description of your business..."></textarea>
        </div>
        <div class="form-group">
          <label for="services">Services / Products</label>
          <textarea id="services" placeholder="List your main services or products..."></textarea>
        </div>
        <div class="form-group">
          <label for="prices">Prices</label>
          <textarea id="prices" placeholder="Key prices and pricing information..."></textarea>
        </div>
        <div class="form-group">
          <label for="timings">Working Hours</label>
          <input type="text" id="timings" placeholder="e.g., Mon-Sat 9am-8pm, Sunday closed">
        </div>
        <div class="form-group">
          <label for="faqs">Frequently Asked Questions &amp; Answers</label>
          <textarea id="faqs" placeholder="Common questions and your standard answers..."></textarea>
        </div>
        <button type="submit">Save Business Info</button>
      </form>
    </div>

    <div class="card">
      <h2>WhatsApp Configuration</h2>
      <p style="color: #64748b; margin-bottom: 24px;">Configure your WhatsApp Business API credentials from Meta Developers Console.</p>
      <form id="whatsappForm">
        <div class="form-group">
          <label for="whatsapp_number">WhatsApp Business Number</label>
          <input type="text" id="whatsapp_number" placeholder="e.g., +923001234567">
          <p class="help">Your WhatsApp Business phone number with country code</p>
        </div>
        <div class="form-group">
          <label for="whatsapp_phone_id">Phone Number ID</label>
          <input type="text" id="whatsapp_phone_id" placeholder="From Meta Developers Console">
          <p class="help">Found in Meta Developers Console > WhatsApp > Phone Numbers</p>
        </div>
        <button type="submit">Save WhatsApp Settings</button>
      </form>
    </div>

    <div class="card">
      <h2>Payment Settings</h2>
      <p style="color: #64748b; margin-bottom: 24px;">Add your payment link to show customers how to pay you.</p>
      <form id="paymentForm">
        <div class="form-group">
          <label for="payment_link">Payment Link (JazzCash, EasyPaisa, Bank)</label>
          <input type="url" id="payment_link" placeholder="https://your-payment-link.com">
        </div>
        <button type="submit">Save Payment Settings</button>
      </form>
    </div>
  </div>
  <script>
    async function loadSettings() {
      try {
        const data = await fetch('/api/auth/me').then(r => r.json());
        if (data.error) {
          window.location = '/login';
          return;
        }
        document.getElementById('shop_name').value = data.shop_name || '';
        document.getElementById('description').value = data.description || '';
        document.getElementById('services').value = data.services || '';
        document.getElementById('prices').value = data.prices || '';
        document.getElementById('timings').value = data.timings || '';
        document.getElementById('faqs').value = data.faqs || '';
        document.getElementById('whatsapp_number').value = data.whatsapp_number || '';
        document.getElementById('whatsapp_phone_id').value = data.whatsapp_phone_id || '';
        document.getElementById('payment_link').value = data.payment_link || '';
      } catch (err) {
        console.error(err);
      }
    }

    async function saveSettings(formData) {
      try {
        const res = await fetch('/api/business', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(formData)
        });
        const data = await res.json();
        if (data.success) {
          document.getElementById('success').style.display = 'block';
          setTimeout(() => document.getElementById('success').style.display = 'none', 3000);
        }
      } catch (err) {
        console.error(err);
      }
    }

    document.getElementById('settingsForm').addEventListener('submit', (e) => {
      e.preventDefault();
      saveSettings({
        shop_name: document.getElementById('shop_name').value,
        description: document.getElementById('description').value,
        services: document.getElementById('services').value,
        prices: document.getElementById('prices').value,
        timings: document.getElementById('timings').value,
        faqs: document.getElementById('faqs').value
      });
    });

    document.getElementById('whatsappForm').addEventListener('submit', (e) => {
      e.preventDefault();
      saveSettings({
        whatsapp_number: document.getElementById('whatsapp_number').value,
        whatsapp_phone_id: document.getElementById('whatsapp_phone_id').value
      });
    });

    document.getElementById('paymentForm').addEventListener('submit', (e) => {
      e.preventDefault();
      saveSettings({
        payment_link: document.getElementById('payment_link').value
      });
    });

    async function logout() {
      await fetch('/api/auth/logout', { method: 'POST' });
      window.location = '/login';
    }

    loadSettings();
  </script>
</body>
</html>`;
}

function getConversationPage(convId) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>BizChat AI - Conversation</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f8fafc; min-height: 100vh; }
    .header { background: linear-gradient(135deg, #1e3a5f 0%, #0f172a 100%); color: white; padding: 20px 40px; display: flex; justify-content: space-between; align-items: center; }
    .header h1 { font-size: 24px; font-weight: 700; }
    .nav { display: flex; gap: 24px; align-items: center; }
    .nav a { color: rgba(255,255,255,0.8); text-decoration: none; font-size: 14px; }
    .nav a:hover { color: white; }
    .container { max-width: 800px; margin: 0 auto; padding: 40px; }
    .conv-header { background: white; border-radius: 12px; padding: 20px; margin-bottom: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    .conv-header h2 { font-size: 20px; color: #1e293b; }
    .conv-header p { color: #64748b; font-size: 14px; }
    .messages { background: white; border-radius: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); padding: 20px; min-height: 400px; max-height: 60vh; overflow-y: auto; }
    .msg { margin-bottom: 16px; display: flex; flex-direction: column; }
    .msg.in { align-items: flex-start; }
    .msg.out { align-items: flex-end; }
    .msg-bubble { max-width: 70%; padding: 12px 16px; border-radius: 16px; font-size: 14px; line-height: 1.5; }
    .msg.in .msg-bubble { background: #e2e8f0; color: #1e293b; }
    .msg.out .msg-bubble { background: #3b82f6; color: white; }
    .msg-time { font-size: 11px; color: #94a3b8; margin-top: 4px; }
    .back { display: inline-flex; align-items: center; gap: 8px; color: #3b82f6; text-decoration: none; font-size: 14px; margin-bottom: 20px; }
  </style>
</head>
<body>
  <header class="header">
    <h1>BizChat AI</h1>
    <nav class="nav">
      <a href="/dashboard">Dashboard</a>
      <a href="/settings">Settings</a>
      <a href="#" onclick="logout()">Logout</a>
    </nav>
  </header>
  <div class="container">
    <a href="/dashboard" class="back">← Back to Dashboard</a>
    <div class="conv-header">
      <h2 id="customerName">Loading...</h2>
      <p id="customerPhone"></p>
    </div>
    <div class="messages" id="msgList"></div>
  </div>
  <script>
    async function loadConversation() {
      try {
        const data = await fetch('/api/conversations/${convId}/messages').then(r => r.json());
        if (data.error) {
          window.location = '/dashboard';
          return;
        }
        document.getElementById('customerName').textContent = data.conversation.customer_name || 'Customer';
        document.getElementById('customerPhone').textContent = data.conversation.customer_phone;

        const list = document.getElementById('msgList');
        list.innerHTML = data.messages.map(m => \`
          <div class="msg \${m.direction}">
            <div class="msg-bubble">\${escapeHtml(m.content)}</div>
            <div class="msg-time">\${new Date(m.timestamp).toLocaleString()}</div>
          </div>
        \`).join('');
        list.scrollTop = list.scrollHeight;
      } catch (err) {
        console.error(err);
      }
    }

    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }

    async function logout() {
      await fetch('/api/auth/logout', { method: 'POST' });
      window.location = '/login';
    }

    loadConversation();
  </script>
</body>
</html>`;
}

// Start server
app.listen(PORT, () => {
  console.log(`BizChat AI server running on port ${PORT}`);
});

module.exports = app;
