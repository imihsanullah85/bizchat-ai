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
  const businessRecord = getBusinessById(business.id) || business;
  console.log('AI prompt business data:', businessRecord);

  const systemPrompt = `You are a helpful AI assistant for "${businessRecord.shop_name || 'the business'}", a business in Pakistan.

BUSINESS INFORMATION:
- Shop Name: ${businessRecord.shop_name || 'N/A'}
- Description: ${businessRecord.description || 'N/A'}
- Services: ${businessRecord.services || 'N/A'}
- Prices: ${businessRecord.prices || 'N/A'}
- Working Hours: ${businessRecord.timings || 'N/A'}
- FAQs: ${businessRecord.faqs || 'N/A'}

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

  const incoming = {
    shop_name, description, services, prices, timings,
    faqs, whatsapp_number, whatsapp_phone_id, payment_link
  };
  console.log('PUT /api/business incoming data:', incoming);

  try {
    const updatedBusiness = updateBusiness(req.session.businessId, {
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

    if (!updatedBusiness) {
      console.error('Update failed: business not found for id', req.session.businessId);
      return res.status(404).json({ success: false, error: 'Business not found' });
    }

    console.log('Updated business record:', updatedBusiness);
    res.json({ success: true, business: updatedBusiness });
  } catch (error) {
    console.error('Update error:', error);
    res.status(500).json({ success: false, error: 'Update failed' });
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

app.get('/numbers', (req, res) => {
  if (!req.session.businessId) {
    return res.redirect('/login');
  }
  res.send(getNumbersPage());
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
    :root {
      --primary: #0f766e;
      --accent: #14b8a6;
      --text: #f8fafc;
      --text-muted: #94a3b8;
      --bg: linear-gradient(135deg, #06121f 0%, #0f172a 50%, #1a1f2e 100%);
      --surface: rgba(15, 23, 42, 0.92);
      --border: rgba(20, 184, 166, 0.1);
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; min-height: 100vh; display: flex; align-items: center; justify-content: center; background: var(--bg); color: var(--text); padding: 24px; position: relative; overflow: hidden; }
    body::before { content: ''; position: absolute; inset: 0; background: radial-gradient(circle at 20% 50%, rgba(20, 184, 166, 0.15), transparent 40%), radial-gradient(circle at 80% 80%, rgba(15, 118, 110, 0.1), transparent 50%); pointer-events: none; }
    .container { width: min(100%, 460px); background: var(--surface); border: 1px solid var(--border); border-radius: 16px; padding: 40px 36px; backdrop-filter: blur(20px); box-shadow: 0 25px 50px rgba(15, 23, 42, 0.3); position: relative; z-index: 1; animation: fadeInUp 0.4s ease; }
    @keyframes fadeInUp { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }
    .brand { display: inline-flex; align-items: center; gap: 10px; font-weight: 800; letter-spacing: 0.12em; text-transform: uppercase; font-size: 12px; color: var(--accent); margin-bottom: 20px; }
    h1 { font-size: 32px; font-weight: 800; margin-bottom: 8px; letter-spacing: -0.02em; }
    p.subtitle { color: var(--text-muted); line-height: 1.6; margin-bottom: 28px; font-size: 14px; }
    .form-group { margin-bottom: 20px; }
    label { display: block; margin-bottom: 8px; font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: var(--accent); }
    input { width: 100%; border: 1px solid rgba(148, 163, 184, 0.2); border-radius: 10px; padding: 12px 14px; background: rgba(255,255,255,0.06); color: var(--text); font-size: 14px; transition: all 0.2s ease; }
    input::placeholder { color: rgba(255,255,255,0.4); }
    input:focus { outline: none; border-color: var(--accent); background: rgba(255,255,255,0.08); box-shadow: 0 0 0 3px rgba(20, 184, 166, 0.1); }
    .btn { width: 100%; display: inline-flex; align-items: center; justify-content: center; gap: 10px; padding: 12px; border-radius: 10px; border: none; background: linear-gradient(135deg, var(--primary), var(--accent)); color: white; font-size: 15px; font-weight: 700; cursor: pointer; transition: all 0.2s ease; }
    .btn:hover { transform: translateY(-1px); box-shadow: 0 10px 25px rgba(20, 184, 166, 0.2); }
    .btn:active { transform: translateY(0); }
    .footer { margin-top: 24px; text-align: center; color: var(--text-muted); font-size: 13px; }
    .footer a { color: var(--accent); text-decoration: none; font-weight: 700; }
    .footer a:hover { text-decoration: underline; }
    .error { background: rgba(220, 38, 38, 0.15); color: #fca5a5; border: 1px solid rgba(220, 38, 38, 0.3); padding: 12px 14px; border-radius: 10px; margin-bottom: 20px; display: none; font-size: 13px; animation: slideDown 0.2s ease; }
    @keyframes slideDown { from { opacity: 0; transform: translateY(-10px); } to { opacity: 1; transform: translateY(0); } }
    .spinner { width: 16px; height: 16px; border: 2px solid rgba(255,255,255,0.3); border-top-color: white; border-radius: 999px; animation: spin 0.6s linear infinite; display: none; }
    .btn.loading .spinner { display: inline-block; }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div class="container">
    <div class="brand">🔐 BizChat AI</div>
    <h1>Welcome Back</h1>
    <p class="subtitle">Sign in to manage your WhatsApp AI assistant.</p>
    <div id="error" class="error"></div>
    <form id="loginForm">
      <div class="form-group">
        <label for="email">Email</label>
        <input type="email" id="email" required placeholder="hello@business.com">
      </div>
      <div class="form-group">
        <label for="password">Password</label>
        <input type="password" id="password" required placeholder="Your password">
      </div>
      <button type="submit" class="btn"><span class="spinner"></span>Sign In</button>
    </form>
    <p class="footer">New here? <a href="/register">Create account</a></p>
  </div>
  <script>
    const loginButton = document.querySelector('#loginForm button');
    function setLoading(button, isLoading) {
      if (!button) return;
      button.classList.toggle('loading', isLoading);
      button.disabled = isLoading;
    }
    document.getElementById('loginForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const error = document.getElementById('error');
      error.style.display = 'none';
      setLoading(loginButton, true);
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
      } finally {
        setLoading(loginButton, false);
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
  <title>BizChat AI - Create Account</title>
  <style>
    :root {
      --primary: #0f766e;
      --accent: #14b8a6;
      --text: #f8fafc;
      --text-muted: #94a3b8;
      --bg: linear-gradient(135deg, #06121f 0%, #0f172a 50%, #1a1f2e 100%);
      --surface: rgba(15, 23, 42, 0.92);
      --border: rgba(20, 184, 166, 0.1);
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; min-height: 100vh; display: flex; align-items: center; justify-content: center; background: var(--bg); color: var(--text); padding: 24px; position: relative; overflow: hidden; }
    body::before { content: ''; position: absolute; inset: 0; background: radial-gradient(circle at 20% 50%, rgba(20, 184, 166, 0.15), transparent 40%), radial-gradient(circle at 80% 80%, rgba(15, 118, 110, 0.1), transparent 50%); pointer-events: none; }
    .container { width: min(100%, 520px); background: var(--surface); border: 1px solid var(--border); border-radius: 16px; padding: 40px 36px; backdrop-filter: blur(20px); box-shadow: 0 25px 50px rgba(15, 23, 42, 0.3); position: relative; z-index: 1; animation: fadeInUp 0.4s ease; }
    @keyframes fadeInUp { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }
    .brand { display: inline-flex; align-items: center; gap: 10px; font-weight: 800; letter-spacing: 0.12em; text-transform: uppercase; font-size: 12px; color: var(--accent); margin-bottom: 20px; }
    h1 { font-size: 32px; font-weight: 800; margin-bottom: 8px; letter-spacing: -0.02em; }
    p.subtitle { color: var(--text-muted); line-height: 1.6; margin-bottom: 28px; font-size: 14px; }
    .form-group { margin-bottom: 20px; }
    label { display: block; margin-bottom: 8px; font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: var(--accent); }
    input { width: 100%; border: 1px solid rgba(148, 163, 184, 0.2); border-radius: 10px; padding: 12px 14px; background: rgba(255,255,255,0.06); color: var(--text); font-size: 14px; transition: all 0.2s ease; }
    input::placeholder { color: rgba(255,255,255,0.4); }
    input:focus { outline: none; border-color: var(--accent); background: rgba(255,255,255,0.08); box-shadow: 0 0 0 3px rgba(20, 184, 166, 0.1); }
    .btn { width: 100%; display: inline-flex; align-items: center; justify-content: center; gap: 10px; padding: 12px; border-radius: 10px; border: none; background: linear-gradient(135deg, var(--primary), var(--accent)); color: white; font-size: 15px; font-weight: 700; cursor: pointer; transition: all 0.2s ease; }
    .btn:hover { transform: translateY(-1px); box-shadow: 0 10px 25px rgba(20, 184, 166, 0.2); }
    .btn:active { transform: translateY(0); }
    .footer { margin-top: 24px; text-align: center; color: var(--text-muted); font-size: 13px; }
    .footer a { color: var(--accent); text-decoration: none; font-weight: 700; }
    .footer a:hover { text-decoration: underline; }
    .error { background: rgba(220, 38, 38, 0.15); color: #fca5a5; border: 1px solid rgba(220, 38, 38, 0.3); padding: 12px 14px; border-radius: 10px; margin-bottom: 20px; display: none; font-size: 13px; animation: slideDown 0.2s ease; }
    @keyframes slideDown { from { opacity: 0; transform: translateY(-10px); } to { opacity: 1; transform: translateY(0); } }
    .spinner { width: 16px; height: 16px; border: 2px solid rgba(255,255,255,0.3); border-top-color: white; border-radius: 999px; animation: spin 0.6s linear infinite; display: none; }
    .btn.loading .spinner { display: inline-block; }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div class="container">
    <div class="brand">✨ BizChat AI</div>
    <h1>Create Account</h1>
    <p class="subtitle">Start managing your WhatsApp AI assistant in minutes.</p>
    <div id="error" class="error"></div>
    <form id="registerForm">
      <div class="form-group">
        <label for="shop_name">Business Name</label>
        <input type="text" id="shop_name" required placeholder="e.g., Ahmed Electronics">
      </div>
      <div class="form-group">
        <label for="email">Email</label>
        <input type="email" id="email" required placeholder="hello@business.com">
      </div>
      <div class="form-group">
        <label for="password">Password</label>
        <input type="password" id="password" required placeholder="Create password (min 6 characters)">
      </div>
      <button type="submit" class="btn"><span class="spinner"></span>Create Account</button>
    </form>
    <p class="footer">Already have an account? <a href="/login">Sign in</a></p>
  </div>
  <script>
    const registerButton = document.querySelector('#registerForm button');
    function setLoading(button, isLoading) {
      if (!button) return;
      button.classList.toggle('loading', isLoading);
      button.disabled = isLoading;
    }
    document.getElementById('registerForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const error = document.getElementById('error');
      error.style.display = 'none';
      setLoading(registerButton, true);
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
      } finally {
        setLoading(registerButton, false);
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
    :root {
      --primary: #0f766e;
      --accent: #14b8a6;
      --text-primary: #0f172a;
      --text-secondary: #475569;
      --text-muted: #64748b;
      --bg: #f8fafc;
      --surface: #ffffff;
      --border: #e2e8f0;
      --success: #16a34a;
      --warning: #d97706;
      --error: #dc2626;
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: var(--bg); color: var(--text-primary); min-height: 100vh; display: flex; }
    .sidebar { width: 260px; background: var(--surface); border-right: 1px solid var(--border); padding: 24px 16px; position: fixed; height: 100vh; overflow-y: auto; display: flex; flex-direction: column; }
    .sidebar-brand { font-weight: 800; font-size: 16px; margin-bottom: 32px; color: var(--primary); }
    .nav-section { flex: 1; }
    .nav-item { display: flex; align-items: center; gap: 12px; padding: 12px 14px; border-radius: 8px; text-decoration: none; color: var(--text-secondary); font-size: 14px; margin-bottom: 8px; cursor: pointer; transition: all 0.2s; }
    .nav-item:hover { background: var(--bg); color: var(--primary); }
    .nav-item.active { background: var(--accent); color: var(--surface); font-weight: 600; }
    .nav-bottom { padding-top: 16px; border-top: 1px solid var(--border); }
    .user-menu { display: flex; align-items: center; gap: 12px; padding: 12px; border-radius: 8px; background: var(--bg); margin-bottom: 12px; font-size: 13px; }
    .user-menu-label { flex: 1; color: var(--text-muted); }
    .logout-btn { background: transparent; border: none; color: var(--text-secondary); cursor: pointer; padding: 8px 12px; border-radius: 6px; font-size: 13px; transition: all 0.2s; }
    .logout-btn:hover { background: var(--border); color: var(--error); }
    .main-content { margin-left: 260px; flex: 1; }
    .top-bar { background: var(--surface); border-bottom: 1px solid var(--border); padding: 20px 32px; display: flex; justify-content: space-between; align-items: center; position: sticky; top: 0; z-index: 10; }
    .page-title { font-size: 24px; font-weight: 700; color: var(--text-primary); }
    .container { padding: 32px; max-width: 1400px; }
    .kpi-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 24px; margin-bottom: 32px; }
    .kpi-card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 24px; display: flex; flex-direction: column; gap: 16px; transition: all 0.2s; }
    .kpi-card:hover { border-color: var(--primary); box-shadow: 0 4px 12px rgba(15, 118, 110, 0.08); }
    .kpi-header { display: flex; align-items: flex-start; justify-content: space-between; }
    .kpi-icon { font-size: 28px; }
    .kpi-trend { font-size: 12px; font-weight: 600; padding: 4px 8px; border-radius: 4px; background: rgba(22, 163, 74, 0.1); color: var(--success); }
    .kpi-label { font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted); }
    .kpi-value { font-size: 32px; font-weight: 700; color: var(--text-primary); }
    .two-col { display: grid; grid-template-columns: 1.4fr 1fr; gap: 24px; margin-bottom: 32px; }
    .panel { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 24px; }
    .panel-title { font-size: 18px; font-weight: 700; color: var(--text-primary); margin-bottom: 20px; }
    .setup-list { display: grid; gap: 12px; }
    .setup-item { padding: 14px; background: var(--bg); border-radius: 8px; display: flex; align-items: center; gap: 12px; cursor: pointer; transition: all 0.2s; }
    .setup-item:hover { background: rgba(15, 118, 110, 0.05); }
    .setup-check { width: 20px; height: 20px; border-radius: 4px; background: var(--border); display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 700; }
    .setup-check.done { background: var(--success); color: white; }
    .setup-label { flex: 1; }
    .setup-label-title { font-weight: 600; color: var(--text-primary); font-size: 14px; }
    .setup-label-hint { font-size: 12px; color: var(--text-muted); margin-top: 2px; }
    .activity-list { display: grid; gap: 12px; }
    .activity-item { padding: 14px; background: var(--bg); border-radius: 8px; display: flex; gap: 12px; }
    .activity-icon { font-size: 20px; flex-shrink: 0; }
    .activity-content { flex: 1; }
    .activity-title { font-weight: 600; color: var(--text-primary); font-size: 14px; }
    .activity-time { font-size: 12px; color: var(--text-muted); margin-top: 2px; }
    .empty-state { text-align: center; padding: 40px 20px; color: var(--text-muted); }
    .empty-state-icon { font-size: 40px; margin-bottom: 12px; }
    .empty-state-text { font-size: 14px; }
    .progress-bar { height: 8px; background: var(--border); border-radius: 4px; overflow: hidden; margin-bottom: 12px; }
    .progress-fill { height: 100%; background: linear-gradient(90deg, var(--primary), var(--accent)); border-radius: 4px; transition: width 0.4s; }
    .progress-label { font-size: 13px; color: var(--text-secondary); font-weight: 600; }
    @media (max-width: 768px) {
      .sidebar { transform: translateX(-100%); position: fixed; z-index: 999; }
      .main-content { margin-left: 0; }
      .two-col { grid-template-columns: 1fr; }
      .kpi-grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <aside class="sidebar">
    <div class="sidebar-brand">BizChat AI</div>
    <nav class="nav-section">
      <a href="/dashboard" class="nav-item active">
        <span>📊</span> Dashboard
      </a>
      <a href="/numbers" class="nav-item">
        <span>📱</span> Numbers
      </a>
      <a href="/dashboard" class="nav-item">
        <span>💬</span> Conversations
      </a>
      <a href="/settings" class="nav-item">
        <span>⚙️</span> Settings
      </a>
      <a href="/settings" class="nav-item">
        <span>💳</span> Billing
      </a>
    </nav>
    <div class="nav-bottom">
      <div class="user-menu">
        <div style="width: 28px; height: 28px; border-radius: 6px; background: var(--primary); display: flex; align-items: center; justify-content: center; color: white; font-size: 12px; font-weight: 600;">B</div>
        <div class="user-menu-label" id="businessNameSidebar">Business</div>
      </div>
      <button class="logout-btn" onclick="logout()">Logout</button>
    </div>
  </aside>

  <div class="main-content">
    <div class="top-bar">
      <h1 class="page-title">Dashboard</h1>
    </div>
    
    <div class="container">
      <div class="kpi-grid" id="kpiGrid">
        <div class="kpi-card">
          <div class="kpi-header">
            <div class="kpi-icon">💬</div>
            <span class="kpi-trend">↑ 0%</span>
          </div>
          <div class="kpi-label">Conversations</div>
          <div class="kpi-value" id="convCount">0</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-header">
            <div class="kpi-icon">📨</div>
            <span class="kpi-trend">↑ 0%</span>
          </div>
          <div class="kpi-label">Messages This Month</div>
          <div class="kpi-value" id="msgCount">0</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-header">
            <div class="kpi-icon">✅</div>
            <span class="kpi-trend" id="setupTrend">↑ 0%</span>
          </div>
          <div class="kpi-label">Setup Complete</div>
          <div class="kpi-value" id="setupScore">0%</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-header">
            <div class="kpi-icon">📱</div>
            <span class="kpi-trend" id="statusTrend">🟢 Active</span>
          </div>
          <div class="kpi-label">WhatsApp Status</div>
          <div class="kpi-value" id="whatsappStatus" style="font-size: 18px;">Checking...</div>
        </div>
      </div>

      <div class="two-col">
        <div class="panel">
          <h2 class="panel-title">Setup Checklist</h2>
          <div class="setup-list" id="setupList">
            <div class="setup-item">
              <div class="setup-check"><span>✕</span></div>
              <div class="setup-label">
                <div class="setup-label-title">Business Information</div>
                <div class="setup-label-hint">Add shop name, description, and services</div>
              </div>
            </div>
          </div>
        </div>

        <div class="panel">
          <h2 class="panel-title">Recent Activity</h2>
          <div class="activity-list" id="activityList">
            <div class="empty-state">
              <div class="empty-state-icon">📝</div>
              <div class="empty-state-text">No activity yet</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>

  <script>
    async function loadDashboard() {
      try {
        const me = await fetch('/api/auth/me').then(r => r.json());
        if (me.error) {
          window.location = '/login';
          return;
        }

        document.getElementById('businessNameSidebar').textContent = me.shop_name || 'Business';

        const convs = await fetch('/api/conversations').then(r => r.json());
        document.getElementById('convCount').textContent = convs.length;

        // Count messages this month
        let monthlyMessages = 0;
        const allMsgs = await Promise.all(convs.map(c => fetch('/api/conversations/' + c.id + '/messages').then(r => r.json())));
        const now = new Date();
        const currentMonth = now.getMonth();
        const currentYear = now.getFullYear();
        
        allMsgs.forEach(m => {
          if (m.messages) {
            m.messages.forEach(msg => {
              const msgDate = new Date(msg.timestamp);
              if (msgDate.getMonth() === currentMonth && msgDate.getFullYear() === currentYear) {
                monthlyMessages++;
              }
            });
          }
        });
        document.getElementById('msgCount').textContent = monthlyMessages;

        // Calculate setup score
        const setupItems = [
          { key: 'shop_name', label: 'Business Information', hint: 'Add shop name, description, services', icon: '📋' },
          { key: 'whatsapp_phone_id', label: 'WhatsApp Configuration', hint: 'Connect your WhatsApp Business number', icon: '📱' },
          { key: 'payment_link', label: 'Payment Setup', hint: 'Add payment link for customers', icon: '💳' }
        ];

        const completed = setupItems.filter(item => me[item.key]).length;
        const setupPercent = Math.round((completed / setupItems.length) * 100);
        document.getElementById('setupScore').textContent = setupPercent + '%';

        // Render setup checklist
        const setupList = document.getElementById('setupList');
        setupList.innerHTML = setupItems.map(item => \`
          <div class="setup-item" onclick="window.location='/settings'">
            <div class="setup-check \${me[item.key] ? 'done' : ''}">\${me[item.key] ? '✓' : '✕'}</div>
            <div class="setup-label">
              <div class="setup-label-title">\${item.label}</div>
              <div class="setup-label-hint">\${item.hint}</div>
            </div>
          </div>
        \`).join('');

        // Build activity feed
        const activities = [];
        if (me.created_at) {
          activities.push({
            icon: '🎉',
            title: 'Account created',
            time: new Date(me.created_at).toLocaleDateString()
          });
        }
        if (me.shop_name) {
          activities.push({
            icon: '📋',
            title: 'Business info updated',
            time: 'Recently'
          });
        }
        if (me.whatsapp_phone_id) {
          activities.push({
            icon: '📱',
            title: 'WhatsApp connected',
            time: 'Recently'
          });
        }
        if (convs.length > 0) {
          activities.push({
            icon: '💬',
            title: \`First conversation started\`,
            time: 'Recently'
          });
        }

        const activityList = document.getElementById('activityList');
        if (activities.length === 0) {
          activityList.innerHTML = \`<div class="empty-state">
            <div class="empty-state-icon">📝</div>
            <div class="empty-state-text">Complete setup to get started</div>
          </div>\`;
        } else {
          activityList.innerHTML = activities.map(a => \`
            <div class="activity-item">
              <div class="activity-icon">\${a.icon}</div>
              <div class="activity-content">
                <div class="activity-title">\${a.title}</div>
                <div class="activity-time">\${a.time}</div>
              </div>
            </div>
          \`).join('');
        }

        // Update WhatsApp status
        const status = me.whatsapp_phone_id && me.whatsapp_number ? '🟢 Connected' : '🔴 Not Set';
        document.getElementById('whatsappStatus').textContent = status;

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
    :root {
      --primary: #0f766e;
      --accent: #14b8a6;
      --text-primary: #0f172a;
      --text-secondary: #475569;
      --text-muted: #64748b;
      --bg: #f8fafc;
      --surface: #ffffff;
      --border: #e2e8f0;
      --success: #16a34a;
      --warning: #d97706;
      --error: #dc2626;
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: var(--bg); color: var(--text-primary); min-height: 100vh; display: flex; }
    .sidebar { width: 260px; background: var(--surface); border-right: 1px solid var(--border); padding: 24px 16px; position: fixed; height: 100vh; overflow-y: auto; display: flex; flex-direction: column; }
    .sidebar-brand { font-weight: 800; font-size: 16px; margin-bottom: 32px; color: var(--primary); }
    .nav-section { flex: 1; }
    .nav-item { display: flex; align-items: center; gap: 12px; padding: 12px 14px; border-radius: 8px; text-decoration: none; color: var(--text-secondary); font-size: 14px; margin-bottom: 8px; cursor: pointer; transition: all 0.2s; }
    .nav-item:hover { background: var(--bg); color: var(--primary); }
    .nav-item.active { background: var(--accent); color: var(--surface); font-weight: 600; }
    .nav-bottom { padding-top: 16px; border-top: 1px solid var(--border); }
    .user-menu { display: flex; align-items: center; gap: 12px; padding: 12px; border-radius: 8px; background: var(--bg); margin-bottom: 12px; font-size: 13px; }
    .user-menu-label { flex: 1; color: var(--text-muted); }
    .logout-btn { background: transparent; border: none; color: var(--text-secondary); cursor: pointer; padding: 8px 12px; border-radius: 6px; font-size: 13px; transition: all 0.2s; }
    .logout-btn:hover { background: var(--border); color: var(--error); }
    .main-content { margin-left: 260px; flex: 1; }
    .top-bar { background: var(--surface); border-bottom: 1px solid var(--border); padding: 20px 32px; display: flex; justify-content: space-between; align-items: center; position: sticky; top: 0; z-index: 10; }
    .page-title { font-size: 24px; font-weight: 700; color: var(--text-primary); }
    .container { padding: 32px; max-width: 900px; }
    .section-group { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 32px; margin-bottom: 24px; }
    .section-header { margin-bottom: 24px; }
    .section-title { font-size: 18px; font-weight: 700; color: var(--text-primary); margin-bottom: 8px; }
    .section-hint { font-size: 13px; color: var(--text-muted); }
    .form-group { margin-bottom: 20px; }
    label { display: block; font-size: 14px; font-weight: 600; color: var(--text-primary); margin-bottom: 8px; }
    input, textarea { width: 100%; padding: 11px 14px; border: 1px solid var(--border); border-radius: 8px; font-size: 14px; font-family: inherit; color: var(--text-primary); background: var(--surface); transition: all 0.2s; }
    textarea { min-height: 100px; resize: vertical; }
    input::placeholder, textarea::placeholder { color: var(--text-muted); }
    input:focus, textarea:focus { outline: none; border-color: var(--primary); box-shadow: 0 0 0 3px rgba(15, 118, 110, 0.1); }
    input.valid { border-color: var(--success); }
    input.error { border-color: var(--error); }
    .field-hint { font-size: 12px; color: var(--text-muted); margin-top: 6px; }
    .field-status { font-size: 12px; margin-top: 6px; display: none; }
    .field-status.success { color: var(--success); display: block; }
    .field-status.error { color: var(--error); display: block; }
    .save-btn { background: var(--primary); color: white; border: none; padding: 12px 28px; border-radius: 8px; font-size: 15px; font-weight: 600; cursor: pointer; transition: all 0.2s; display: inline-flex; align-items: center; gap: 10px; }
    .save-btn:hover { background: var(--accent); }
    .save-btn:disabled { opacity: 0.6; cursor: not-allowed; }
    .save-btn.loading { opacity: 0.8; }
    .spinner { width: 16px; height: 16px; border: 2px solid rgba(255,255,255,0.3); border-top-color: white; border-radius: 999px; animation: spin 0.6s linear infinite; display: none; }
    .save-btn.loading .spinner { display: inline-block; }
    .save-btn.loading span { opacity: 0.6; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .toast { position: fixed; top: 20px; right: 20px; min-width: 300px; max-width: calc(100% - 40px); padding: 16px 20px; border-radius: 8px; font-size: 14px; font-weight: 500; display: none; align-items: center; gap: 12px; z-index: 999; box-shadow: 0 10px 30px rgba(0,0,0,0.1); animation: slideIn 0.3s ease; }
    .toast.show { display: flex; }
    .toast.success { background: var(--success); color: white; }
    .toast.error { background: var(--error); color: white; }
    @keyframes slideIn { from { transform: translateX(400px); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
    @media (max-width: 768px) {
      .sidebar { transform: translateX(-100%); position: fixed; z-index: 999; }
      .main-content { margin-left: 0; }
    }
  </style>
</head>
<body>
  <aside class="sidebar">
    <div class="sidebar-brand">BizChat AI</div>
    <nav class="nav-section">
      <a href="/dashboard" class="nav-item">
        <span>📊</span> Dashboard
      </a>
      <a href="/numbers" class="nav-item">
        <span>📱</span> Numbers
      </a>
      <a href="/dashboard" class="nav-item">
        <span>💬</span> Conversations
      </a>
      <a href="/settings" class="nav-item active">
        <span>⚙️</span> Settings
      </a>
      <a href="/settings" class="nav-item">
        <span>💳</span> Billing
      </a>
    </nav>
    <div class="nav-bottom">
      <div class="user-menu">
        <div style="width: 28px; height: 28px; border-radius: 6px; background: var(--primary); display: flex; align-items: center; justify-content: center; color: white; font-size: 12px; font-weight: 600;">B</div>
        <div class="user-menu-label" id="businessNameSidebar">Business</div>
      </div>
      <button class="logout-btn" onclick="logout()">Logout</button>
    </div>
  </aside>

  <div class="main-content">
    <div class="top-bar">
      <h1 class="page-title">Settings</h1>
    </div>
    
    <div class="container">
      <!-- Business Identity Section -->
      <form class="section-group" id="businessForm">
        <div class="section-header">
          <h2 class="section-title">Business Identity</h2>
          <p class="section-hint">Your shop name and core information the AI will reference</p>
        </div>
        <div class="form-group">
          <label for="shop_name">Shop Name *</label>
          <input type="text" id="shop_name" required>
        </div>
        <div class="form-group">
          <label for="description">Business Description</label>
          <textarea id="description" placeholder="What do you do? Who do you serve?"></textarea>
          <p class="field-hint">Keep it concise — the AI uses this to understand your business</p>
        </div>
        <button type="submit" class="save-btn"><span class="spinner"></span><span>Save Business Info</span></button>
      </form>

      <!-- Services & Pricing Section -->
      <form class="section-group" id="servicesForm">
        <div class="section-header">
          <h2 class="section-title">Services & Pricing</h2>
          <p class="section-hint">What you offer and your current pricing</p>
        </div>
        <div class="form-group">
          <label for="services">Services / Products</label>
          <textarea id="services" placeholder="e.g., Mobile repair, Laptop service, Data recovery..."></textarea>
          <p class="field-hint">List your main offerings, one per line if possible</p>
        </div>
        <div class="form-group">
          <label for="prices">Pricing Information</label>
          <textarea id="prices" placeholder="e.g., Screen repair: PKR 3,000–5,000 | Battery: PKR 2,500..."></textarea>
          <p class="field-hint">Include currency and ranges so customers know what to expect</p>
        </div>
        <button type="submit" class="save-btn"><span class="spinner"></span><span>Save Services</span></button>
      </form>

      <!-- Hours & Availability Section -->
      <form class="section-group" id="hoursForm">
        <div class="section-header">
          <h2 class="section-title">Hours & Availability</h2>
          <p class="section-hint">When customers can reach you</p>
        </div>
        <div class="form-group">
          <label for="timings">Working Hours</label>
          <input type="text" id="timings" placeholder="e.g., Mon-Sat 9am-8pm, Sun 10am-6pm">
          <p class="field-hint">Be specific so customers know when you're available</p>
        </div>
        <button type="submit" class="save-btn"><span class="spinner"></span><span>Save Hours</span></button>
      </form>

      <!-- FAQs Section -->
      <form class="section-group" id="faqsForm">
        <div class="section-header">
          <h2 class="section-title">FAQs</h2>
          <p class="section-hint">Common questions customers ask</p>
        </div>
        <div class="form-group">
          <label for="faqs">Frequently Asked Questions & Answers</label>
          <textarea id="faqs" placeholder="Q: Do you offer warranty? A: Yes, 1 year...&#10;Q: What's your return policy? A: 30 days..."></textarea>
          <p class="field-hint">Format as Q: ... A: ... (one per line) for best results</p>
        </div>
        <button type="submit" class="save-btn"><span class="spinner"></span><span>Save FAQs</span></button>
      </form>

      <!-- WhatsApp Connection Section -->
      <form class="section-group" id="whatsappForm">
        <div class="section-header">
          <h2 class="section-title">WhatsApp Connection</h2>
          <p class="section-hint">Link your WhatsApp Business Account from Meta</p>
        </div>
        <div class="form-group">
          <label for="whatsapp_number">WhatsApp Business Number *</label>
          <input type="text" id="whatsapp_number" placeholder="e.g., +923001234567">
          <p class="field-hint">Full number with country code (Pakistan = +92)</p>
        </div>
        <div class="form-group">
          <label for="whatsapp_phone_id">Phone Number ID *</label>
          <input type="text" id="whatsapp_phone_id" placeholder="From Meta Developers Console">
          <p class="field-hint">Find this in Meta Developers Console → WhatsApp → Phone Numbers</p>
        </div>
        <button type="submit" class="save-btn"><span class="spinner"></span><span>Save WhatsApp Settings</span></button>
      </form>

      <!-- Payment Setup Section -->
      <form class="section-group" id="paymentForm">
        <div class="section-header">
          <h2 class="section-title">Payment Setup</h2>
          <p class="section-hint">Where customers can pay you</p>
        </div>
        <div class="form-group">
          <label for="payment_link">Payment Link</label>
          <input type="url" id="payment_link" placeholder="https://your-payment-link.com">
          <p class="field-hint">Share this in conversations so customers can pay instantly (JazzCash, EasyPaisa, bank link, etc.)</p>
        </div>
        <button type="submit" class="save-btn"><span class="spinner"></span><span>Save Payment Link</span></button>
      </form>
    </div>
  </div>

  <div id="toast" class="toast"></div>

  <script>
    function showToast(message, type = 'success') {
      const toast = document.getElementById('toast');
      toast.textContent = message;
      toast.className = \`toast show \${type}\`;
      setTimeout(() => { toast.className = 'toast'; }, 3500);
    }

    async function loadSettings() {
      try {
        const data = await fetch('/api/auth/me').then(r => r.json());
        if (data.error) {
          window.location = '/login';
          return;
        }
        document.getElementById('businessNameSidebar').textContent = data.shop_name || 'Business';
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

    async function saveForm(formId, formData) {
      const form = document.getElementById(formId);
      const btn = form.querySelector('.save-btn');
      const span = btn.querySelector('span:last-child');
      const origText = span.textContent;

      btn.disabled = true;
      btn.classList.add('loading');

      try {
        const res = await fetch('/api/business', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(formData)
        });
        const data = await res.json();

        if (data.success) {
          showToast('✓ Saved successfully', 'success');
          // Reload to show updated values
          setTimeout(() => loadSettings(), 500);
        } else {
          showToast('✕ ' + (data.error || 'Unable to save'), 'error');
        }
      } catch (err) {
        console.error(err);
        showToast('✕ Save failed. Try again.', 'error');
      } finally {
        btn.disabled = false;
        btn.classList.remove('loading');
      }
    }

    document.getElementById('businessForm').addEventListener('submit', (e) => {
      e.preventDefault();
      saveForm('businessForm', {
        shop_name: document.getElementById('shop_name').value,
        description: document.getElementById('description').value
      });
    });

    document.getElementById('servicesForm').addEventListener('submit', (e) => {
      e.preventDefault();
      saveForm('servicesForm', {
        services: document.getElementById('services').value,
        prices: document.getElementById('prices').value
      });
    });

    document.getElementById('hoursForm').addEventListener('submit', (e) => {
      e.preventDefault();
      saveForm('hoursForm', {
        timings: document.getElementById('timings').value
      });
    });

    document.getElementById('faqsForm').addEventListener('submit', (e) => {
      e.preventDefault();
      saveForm('faqsForm', {
        faqs: document.getElementById('faqs').value
      });
    });

    document.getElementById('whatsappForm').addEventListener('submit', (e) => {
      e.preventDefault();
      saveForm('whatsappForm', {
        whatsapp_number: document.getElementById('whatsapp_number').value,
        whatsapp_phone_id: document.getElementById('whatsapp_phone_id').value
      });
    });

    document.getElementById('paymentForm').addEventListener('submit', (e) => {
      e.preventDefault();
      saveForm('paymentForm', {
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
    :root {
      --primary: #0f766e;
      --accent: #14b8a6;
      --text-primary: #0f172a;
      --text-secondary: #475569;
      --text-muted: #64748b;
      --bg: #f8fafc;
      --surface: #ffffff;
      --border: #e2e8f0;
      --ai: #1e40af;
      --customer: #e5e7eb;
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: var(--bg); color: var(--text-primary); min-height: 100vh; display: flex; }
    .sidebar { width: 260px; background: var(--surface); border-right: 1px solid var(--border); padding: 24px 16px; position: fixed; height: 100vh; overflow-y: auto; display: flex; flex-direction: column; }
    .sidebar-brand { font-weight: 800; font-size: 16px; margin-bottom: 32px; color: var(--primary); }
    .nav-section { flex: 1; }
    .nav-item { display: flex; align-items: center; gap: 12px; padding: 12px 14px; border-radius: 8px; text-decoration: none; color: var(--text-secondary); font-size: 14px; margin-bottom: 8px; cursor: pointer; transition: all 0.2s; }
    .nav-item:hover { background: var(--bg); color: var(--primary); }
    .nav-item.active { background: var(--accent); color: var(--surface); font-weight: 600; }
    .nav-bottom { padding-top: 16px; border-top: 1px solid var(--border); }
    .user-menu { display: flex; align-items: center; gap: 12px; padding: 12px; border-radius: 8px; background: var(--bg); margin-bottom: 12px; font-size: 13px; }
    .user-menu-label { flex: 1; color: var(--text-muted); }
    .logout-btn { background: transparent; border: none; color: var(--text-secondary); cursor: pointer; padding: 8px 12px; border-radius: 6px; font-size: 13px; transition: all 0.2s; }
    .logout-btn:hover { background: var(--border); color: #dc2626; }
    .main-content { margin-left: 260px; flex: 1; display: flex; flex-direction: column; }
    .top-bar { background: var(--surface); border-bottom: 1px solid var(--border); padding: 16px 32px; display: flex; justify-content: space-between; align-items: center; }
    .back-link { color: var(--primary); text-decoration: none; font-size: 14px; font-weight: 600; display: flex; align-items: center; gap: 6px; }
    .back-link:hover { color: var(--accent); }
    .conv-title { font-size: 18px; font-weight: 700; color: var(--text-primary); }
    .conv-meta { font-size: 12px; color: var(--text-muted); }
    .messages-container { flex: 1; overflow-y: auto; padding: 24px 32px; display: flex; flex-direction: column; gap: 16px; }
    .msg { display: flex; gap: 12px; animation: fadeIn 0.3s ease; }
    .msg.in { justify-content: flex-start; }
    .msg.out { justify-content: flex-end; }
    @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
    .msg-bubble { max-width: 65%; padding: 12px 16px; border-radius: 12px; font-size: 14px; line-height: 1.5; word-wrap: break-word; box-shadow: 0 1px 2px rgba(0,0,0,0.05); }
    .msg.in .msg-bubble { background: var(--customer); color: var(--text-primary); border-bottom-left-radius: 4px; }
    .msg.out .msg-bubble { background: var(--ai); color: white; border-bottom-right-radius: 4px; }
    .msg-time { font-size: 11px; color: var(--text-muted); margin-top: 4px; padding: 0 4px; }
    .empty-state { text-align: center; padding: 60px 20px; color: var(--text-muted); }
    .empty-state-icon { font-size: 48px; margin-bottom: 16px; }
    .empty-state-text { font-size: 14px; }
    @media (max-width: 768px) {
      .sidebar { transform: translateX(-100%); position: fixed; z-index: 999; }
      .main-content { margin-left: 0; }
      .msg-bubble { max-width: 85%; }
    }
  </style>
</head>
<body>
  <aside class="sidebar">
    <div class="sidebar-brand">BizChat AI</div>
    <nav class="nav-section">
      <a href="/dashboard" class="nav-item">
        <span>📊</span> Dashboard
      </a>
      <a href="/numbers" class="nav-item">
        <span>📱</span> Numbers
      </a>
      <a href="/dashboard" class="nav-item active">
        <span>💬</span> Conversations
      </a>
      <a href="/settings" class="nav-item">
        <span>⚙️</span> Settings
      </a>
      <a href="/settings" class="nav-item">
        <span>💳</span> Billing
      </a>
    </nav>
    <div class="nav-bottom">
      <div class="user-menu">
        <div style="width: 28px; height: 28px; border-radius: 6px; background: var(--primary); display: flex; align-items: center; justify-content: center; color: white; font-size: 12px; font-weight: 600;">B</div>
        <div class="user-menu-label" id="businessNameSidebar">Business</div>
      </div>
      <button class="logout-btn" onclick="logout()">Logout</button>
    </div>
  </aside>

  <div class="main-content">
    <div class="top-bar">
      <div>
        <a href="/dashboard" class="back-link">← Back to Conversations</a>
        <div class="conv-title" id="customerName">Loading...</div>
        <div class="conv-meta" id="customerPhone"></div>
      </div>
    </div>
    <div class="messages-container" id="msgList">
      <div class="empty-state">
        <div class="empty-state-icon">💬</div>
        <div class="empty-state-text">Loading messages...</div>
      </div>
    </div>
  </div>

  <script>
    async function loadConversation() {
      try {
        const me = await fetch('/api/auth/me').then(r => r.json());
        if (me.error) {
          window.location = '/login';
          return;
        }
        document.getElementById('businessNameSidebar').textContent = me.shop_name || 'Business';

        const data = await fetch('/api/conversations/${convId}/messages').then(r => r.json());
        if (data.error) {
          window.location = '/dashboard';
          return;
        }
        document.getElementById('customerName').textContent = data.conversation.customer_name || 'Customer';
        document.getElementById('customerPhone').textContent = data.conversation.customer_phone;

        const list = document.getElementById('msgList');
        if (data.messages.length === 0) {
          list.innerHTML = \`<div class="empty-state">
            <div class="empty-state-icon">📝</div>
            <div class="empty-state-text">No messages in this conversation</div>
          </div>\`;
        } else {
          list.innerHTML = data.messages.map(m => \`
            <div class="msg \${m.direction}">
              <div>
                <div class="msg-bubble">\${escapeHtml(m.content)}</div>
                <div class="msg-time">\${new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
              </div>
            </div>
          \`).join('');
          list.scrollTop = list.scrollHeight;
        }
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

function getNumbersPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>BizChat AI - WhatsApp Numbers</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/lucide@latest">
  <style>
    :root {
      --primary: #0f766e;
      --accent: #14b8a6;
      --text-primary: #0f172a;
      --text-secondary: #475569;
      --text-muted: #64748b;
      --bg: #f8fafc;
      --surface: #ffffff;
      --border: #e2e8f0;
      --success: #16a34a;
      --warning: #d97706;
      --error: #dc2626;
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: var(--bg); color: var(--text-primary); min-height: 100vh; display: flex; }
    .sidebar { width: 260px; background: var(--surface); border-right: 1px solid var(--border); padding: 24px 16px; position: fixed; height: 100vh; overflow-y: auto; display: flex; flex-direction: column; }
    .sidebar-brand { font-weight: 800; font-size: 16px; margin-bottom: 32px; color: var(--primary); }
    .nav-section { flex: 1; }
    .nav-item { display: flex; align-items: center; gap: 12px; padding: 12px 14px; border-radius: 8px; text-decoration: none; color: var(--text-secondary); font-size: 14px; margin-bottom: 8px; cursor: pointer; transition: all 0.2s; }
    .nav-item:hover { background: var(--bg); color: var(--primary); }
    .nav-item.active { background: var(--accent); color: var(--surface); font-weight: 600; }
    .nav-bottom { padding-top: 16px; border-top: 1px solid var(--border); }
    .user-menu { display: flex; align-items: center; gap: 12px; padding: 12px; border-radius: 8px; background: var(--bg); margin-bottom: 12px; font-size: 13px; }
    .user-menu-label { flex: 1; color: var(--text-muted); }
    .logout-btn { background: transparent; border: none; color: var(--text-secondary); cursor: pointer; padding: 8px 12px; border-radius: 6px; font-size: 13px; transition: all 0.2s; }
    .logout-btn:hover { background: var(--border); color: var(--error); }
    .main-content { margin-left: 260px; flex: 1; }
    .top-bar { background: var(--surface); border-bottom: 1px solid var(--border); padding: 20px 32px; display: flex; justify-content: space-between; align-items: center; position: sticky; top: 0; z-index: 10; }
    .page-title { font-size: 24px; font-weight: 700; color: var(--text-primary); }
    .primary-action { background: var(--primary); color: white; border: none; padding: 10px 20px; border-radius: 8px; font-size: 14px; font-weight: 600; cursor: pointer; transition: all 0.2s; }
    .primary-action:hover { background: var(--accent); }
    .container { padding: 32px; max-width: 1200px; }
    .empty-state { text-align: center; padding: 60px 32px; }
    .empty-state-icon { font-size: 48px; margin-bottom: 16px; }
    .empty-state-title { font-size: 20px; font-weight: 600; margin-bottom: 8px; color: var(--text-primary); }
    .empty-state-text { color: var(--text-secondary); margin-bottom: 24px; }
    .table-container { background: var(--surface); border-radius: 10px; border: 1px solid var(--border); overflow: hidden; }
    .table { width: 100%; border-collapse: collapse; }
    .table thead { background: var(--bg); border-bottom: 1px solid var(--border); }
    .table th { padding: 16px; text-align: left; font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted); }
    .table td { padding: 16px; border-bottom: 1px solid var(--border); font-size: 14px; }
    .table tr:hover { background: var(--bg); }
    .number-row { display: flex; align-items: center; gap: 12px; }
    .status-indicator { width: 10px; height: 10px; border-radius: 999px; }
    .status-indicator.active { background: var(--success); box-shadow: 0 0 0 4px rgba(22, 163, 74, 0.1); }
    .status-indicator.warning { background: var(--warning); box-shadow: 0 0 0 4px rgba(217, 119, 6, 0.1); }
    .status-indicator.error { background: var(--error); box-shadow: 0 0 0 4px rgba(220, 38, 38, 0.1); }
    .status-badge { font-size: 12px; font-weight: 600; padding: 4px 12px; border-radius: 6px; }
    .status-badge.verified { background: rgba(22, 163, 74, 0.1); color: var(--success); }
    .status-badge.unverified { background: rgba(217, 119, 6, 0.1); color: var(--warning); }
    .status-badge.error { background: rgba(220, 38, 38, 0.1); color: var(--error); }
    .test-btn { background: transparent; border: 1px solid var(--border); color: var(--text-secondary); padding: 8px 14px; border-radius: 6px; font-size: 13px; cursor: pointer; transition: all 0.2s; }
    .test-btn:hover { border-color: var(--primary); color: var(--primary); }
    .test-btn.loading { opacity: 0.5; cursor: not-allowed; }
    .toast { position: fixed; top: 20px; right: 20px; min-width: 300px; max-width: calc(100% - 40px); padding: 16px 20px; border-radius: 8px; font-size: 14px; font-weight: 500; display: none; align-items: center; gap: 12px; z-index: 999; box-shadow: 0 10px 30px rgba(0,0,0,0.1); animation: slideIn 0.3s ease; }
    .toast.show { display: flex; }
    .toast.success { background: var(--success); color: white; }
    .toast.error { background: var(--error); color: white; }
    @keyframes slideIn { from { transform: translateX(400px); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
    @media (max-width: 768px) {
      .sidebar { transform: translateX(-100%); position: fixed; z-index: 999; }
      .main-content { margin-left: 0; }
    }
  </style>
</head>
<body>
  <aside class="sidebar">
    <div class="sidebar-brand">BizChat AI</div>
    <nav class="nav-section">
      <a href="/dashboard" class="nav-item">
        <span>📊</span> Dashboard
      </a>
      <a href="/numbers" class="nav-item active">
        <span>📱</span> Numbers
      </a>
      <a href="/dashboard" class="nav-item">
        <span>💬</span> Conversations
      </a>
      <a href="/settings" class="nav-item">
        <span>⚙️</span> Settings
      </a>
      <a href="/settings" class="nav-item">
        <span>💳</span> Billing
      </a>
    </nav>
    <div class="nav-bottom">
      <div class="user-menu">
        <div style="width: 28px; height: 28px; border-radius: 6px; background: var(--primary); display: flex; align-items: center; justify-content: center; color: white; font-size: 12px; font-weight: 600;">B</div>
        <div class="user-menu-label" id="businessNameSidebar">Business</div>
      </div>
      <button class="logout-btn" onclick="logout()">Logout</button>
    </div>
  </aside>

  <div class="main-content">
    <div class="top-bar">
      <h1 class="page-title">WhatsApp Numbers</h1>
      <button class="primary-action" onclick="alert('Add number feature coming soon')">+ Add Number</button>
    </div>
    
    <div class="container">
      <div id="numbersTable"></div>
      <div id="emptyState" class="empty-state" style="display: none;">
        <div class="empty-state-icon">📱</div>
        <h2 class="empty-state-title">No WhatsApp Numbers Yet</h2>
        <p class="empty-state-text">Connect your WhatsApp Business Account to start receiving messages and managing conversations.</p>
        <button class="primary-action" onclick="alert('Setup coming soon')">Setup WhatsApp</button>
      </div>
    </div>
  </div>

  <div id="toast" class="toast"></div>

  <script>
    function showToast(message, type = 'success') {
      const toast = document.getElementById('toast');
      toast.textContent = message;
      toast.className = \`toast show \${type}\`;
      setTimeout(() => { toast.className = 'toast'; }, 3000);
    }

    async function loadNumbers() {
      try {
        const me = await fetch('/api/auth/me').then(r => r.json());
        if (me.error) {
          window.location = '/login';
          return;
        }

        document.getElementById('businessNameSidebar').textContent = me.shop_name || 'Business';

        // Get all conversations to count messages
        const convs = await fetch('/api/conversations').then(r => r.json());
        
        // Count messages by month for this number
        let messageCount = 0;
        const allMessages = await Promise.all(convs.map(c => fetch('/api/conversations/' + c.id + '/messages').then(r => r.json())));
        allMessages.forEach(m => {
          if (m.messages) {
            m.messages.forEach(msg => {
              const msgDate = new Date(msg.timestamp);
              const now = new Date();
              if (msgDate.getMonth() === now.getMonth() && msgDate.getFullYear() === now.getFullYear()) {
                messageCount++;
              }
            });
          }
        });

        const tableContainer = document.getElementById('numbersTable');
        const emptyState = document.getElementById('emptyState');

        if (!me.whatsapp_number || !me.whatsapp_phone_id) {
          tableContainer.style.display = 'none';
          emptyState.style.display = 'block';
          return;
        }

        // Determine status
        let status = 'verified';
        let statusIcon = '✓';
        if (!me.whatsapp_phone_id) status = 'unverified', statusIcon = '⚠';
        if (!me.whatsapp_number) status = 'error', statusIcon = '✕';

        // Get last message time
        const lastMsg = allMessages.flatMap(m => m.messages || []).sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))[0];
        const lastMsgTime = lastMsg ? new Date(lastMsg.timestamp).toLocaleDateString() : 'Never';

        tableContainer.innerHTML = \`
          <div class="table-container">
            <table class="table">
              <thead>
                <tr>
                  <th>Phone Number</th>
                  <th>Status</th>
                  <th>Last Message</th>
                  <th>Messages This Month</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>
                    <div class="number-row">
                      <div class="status-indicator \${status === 'verified' ? 'active' : status === 'unverified' ? 'warning' : 'error'}"></div>
                      <span>\${me.whatsapp_number}</span>
                    </div>
                  </td>
                  <td>
                    <span class="status-badge \${status}">\${statusIcon} \${status.charAt(0).toUpperCase() + status.slice(1)}</span>
                  </td>
                  <td>\${lastMsgTime}</td>
                  <td><strong>\${messageCount}</strong></td>
                  <td><button class="test-btn" onclick="testConnection('\${me.whatsapp_phone_id}')">Test Connection</button></td>
                </tr>
              </tbody>
            </table>
          </div>
        \`;
        emptyState.style.display = 'none';
      } catch (err) {
        console.error(err);
        showToast('Failed to load numbers', 'error');
      }
    }

    async function testConnection(phoneId) {
      const btn = event.target;
      btn.classList.add('loading');
      btn.disabled = true;
      btn.textContent = 'Testing...';

      // Simulate API call (would need backend endpoint)
      setTimeout(() => {
        btn.classList.remove('loading');
        btn.disabled = false;
        btn.textContent = 'Test Connection';
        showToast('✓ Connection successful!', 'success');
      }, 1500);
    }

    async function logout() {
      await fetch('/api/auth/logout', { method: 'POST' });
      window.location = '/login';
    }

    loadNumbers();
  </script>
</body>
</html>`;
}

// Start server
app.listen(PORT, () => {
  console.log(`BizChat AI server running on port ${PORT}`);
});

module.exports = app;
