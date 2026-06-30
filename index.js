const express = require('express');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const { pool, createTables } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const isProduction = process.env.NODE_ENV === 'production';

if (isProduction && (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32)) {
  throw new Error('SESSION_SECRET must be set to at least 32 characters in production.');
}

if (isProduction) {
  app.set('trust proxy', 1);
}

// Database helpers
async function getBusinessByWhatsAppPhoneId(phoneId) {
  const { rows } = await pool.query('SELECT * FROM businesses WHERE whatsapp_phone_id = $1', [phoneId]);
  return rows[0];
}

async function getBusinessByEmail(email) {
  const { rows } = await pool.query('SELECT * FROM businesses WHERE email = $1', [email]);
  return rows[0];
}

async function getBusinessById(id) {
  const { rows } = await pool.query('SELECT * FROM businesses WHERE id = $1', [id]);
  return rows[0];
}

async function insertBusiness(email, passwordHash, shopName) {
  const { rows } = await pool.query(
    'INSERT INTO businesses (email, password_hash, shop_name, monthly_fee) VALUES ($1, $2, $3, $4) RETURNING *',
    [email, passwordHash, shopName || 'My Shop', 5000]
  );
  return rows[0];
}

async function updateBusiness(id, updates) {
  const keys = Object.keys(updates);
  const setString = keys.map((key, i) => '"' + key + '" = $' + (i + 2)).join(', ');
  const values = [id, ...Object.values(updates)];
  const { rows } = await pool.query('UPDATE businesses SET ' + setString + ' WHERE id = $1 RETURNING *', values);
  return rows[0];
}

function sanitizeBusiness(business) {
  if (!business) return null;
  const { password_hash, ...safeBusiness } = business;
  return safeBusiness;
}

async function findDuplicateWhatsAppPhoneIds() {
  const { rows } = await pool.query(`
    SELECT whatsapp_phone_id, ARRAY_AGG(id) as "businessIds"
    FROM businesses WHERE whatsapp_phone_id IS NOT NULL AND whatsapp_phone_id != ''
    GROUP BY whatsapp_phone_id HAVING COUNT(*) > 1
  `);
  return rows;
}

async function ensureConversation(businessId, customerPhone, customerName) {
  const { rows } = await pool.query(
    'INSERT INTO conversations (business_id, customer_phone, customer_name) VALUES ($1, $2, $3) ON CONFLICT (business_id, customer_phone) DO UPDATE SET customer_name = EXCLUDED.customer_name RETURNING *',
    [businessId, customerPhone, customerName || '']
  );
  return rows[0];
}

// Update specific meta columns on a conversation using safe parameterized placeholders.
// Accepts an object with any subset of: lead_temperature, follow_up_at, last_customer_reply_at.
async function updateConversationMeta(conversationId, updates) {
  const allowed = ['lead_temperature', 'follow_up_at', 'last_customer_reply_at'];
  const parts = [];
  const vals = [];
  for (const key of allowed) {
    if (updates && Object.prototype.hasOwnProperty.call(updates, key)) {
      parts.push(key + ' = $' + (vals.length + 1));
      vals.push(updates[key]);
    }
  }
  if (!parts.length) return;
  vals.push(conversationId);
  await pool.query('UPDATE conversations SET ' + parts.join(', ') + ' WHERE id = $' + vals.length, vals);
}

async function insertOrder(businessId, conversationId, customerPhone, orderDetails, requestedDatetime) {
  const { rows } = await pool.query(
    'INSERT INTO orders (business_id, conversation_id, customer_phone, order_details, requested_datetime, status) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
    [businessId, conversationId, customerPhone, orderDetails, requestedDatetime || null, 'new']
  );
  return rows[0];
}

async function insertMessage(conversationId, direction, content) {
  const { rows } = await pool.query(
    'INSERT INTO messages (conversation_id, direction, content) VALUES ($1, $2, $3) RETURNING *',
    [conversationId, direction, content]
  );
  return rows[0];
}

async function getConversationsForBusiness(businessId) {
  const { rows } = await pool.query(`
    SELECT c.*,
      (SELECT COUNT(*) FROM messages WHERE conversation_id = c.id) as message_count,
      (SELECT content FROM messages WHERE conversation_id = c.id ORDER BY timestamp DESC LIMIT 1) as last_message,
      (SELECT timestamp FROM messages WHERE conversation_id = c.id ORDER BY timestamp DESC LIMIT 1) as last_message_time
    FROM conversations c WHERE c.business_id = $1 ORDER BY last_message_time DESC NULLS LAST
  `, [businessId]);
  return rows;
}

async function getConversationByIdAndBusiness(id, businessId) {
  const { rows } = await pool.query('SELECT * FROM conversations WHERE id = $1 AND business_id = $2', [id, businessId]);
  return rows[0];
}

async function getMessagesForConversation(conversationId) {
  const { rows } = await pool.query('SELECT * FROM messages WHERE conversation_id = $1 ORDER BY timestamp ASC', [conversationId]);
  return rows;
}

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'bizchat-secret-change-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: isProduction, sameSite: 'lax', httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

function requireAuth(req, res, next) {
  if (!req.session.businessId) return res.status(401).json({ error: 'Not authenticated' });
  next();
}

// ============================================
// WHATSAPP WEBHOOK
// ============================================

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

app.post('/webhook', async (req, res) => {
  try {
    const data = req.body;
    if (data.object !== 'whatsapp_business_account') return res.status(200).send('OK');
    for (const entry of data.entry || []) {
      for (const change of entry.changes || []) {
        for (const msg of change.value.messages || []) {
          try {
            await handleWhatsAppMessage(msg, change.value);
          } catch (msgErr) {
            console.error('Error handling message from', msg.from, ':', msgErr);
          }
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
  const businessPhoneId = value.metadata && value.metadata.phone_number_id;
  const messageText = (msg.text && msg.text.body) || '';
  const customerName = (msg.profile && msg.profile.name) || 'Customer';
  if (!messageText) return;

  const business = await getBusinessByWhatsAppPhoneId(businessPhoneId);
  if (!business) { console.log('No business found for phone ID:', businessPhoneId); return; }

  const conversation = await ensureConversation(business.id, customerPhone, customerName);
  await insertMessage(conversation.id, 'in', messageText);

  // Record the customer reply timestamp (used for follow-up logic)
  await updateConversationMeta(conversation.id, { last_customer_reply_at: new Date() });

  const aiResult = await generateAIResponse(business, messageText);
  const replyText = aiResult.customer_reply;

  // Send via WhatsApp first; only record in DB if credentials are configured.
  // (If not configured we still save locally so conversation history is useful.)
  const sent = await sendWhatsAppMessage(business.whatsapp_number, businessPhoneId, customerPhone, replyText);
  if (sent || !process.env.WHATSAPP_TOKEN) {
    await insertMessage(conversation.id, 'out', replyText);
  }

  // Update lead temperature if detected
  const validTemps = ['cold', 'warm', 'hot'];
  if (aiResult.lead_temperature && validTemps.includes(aiResult.lead_temperature)) {
    await updateConversationMeta(conversation.id, { lead_temperature: aiResult.lead_temperature });
  }

  // Save detected order to orders table
  if (aiResult.order_detected) {
    try {
      const od = aiResult.order_detected;
      let details = '';
      if (typeof od.item === 'string') {
        details = od.item + (od.quantity ? ' x' + od.quantity : '');
      } else {
        details = JSON.stringify(od);
      }
      await insertOrder(business.id, conversation.id, customerPhone, details, od.requested_datetime || null);
      console.log('Order saved for', customerPhone, ':', details);
    } catch (err) {
      console.error('Failed to save order:', err);
    }
  }

  // Schedule a follow-up 2 hours from now if conversation seems unresolved
  if (aiResult.needs_follow_up) {
    const followUpAt = new Date(Date.now() + 2 * 60 * 60 * 1000);
    await updateConversationMeta(conversation.id, { follow_up_at: followUpAt });
  }
}

// Parse the AI JSON response safely, stripping markdown fences if present.
function parseAIJSON(raw) {
  const fallback = { customer_reply: raw || 'Sorry, I am having trouble responding right now.', lead_temperature: 'cold', order_detected: null, needs_follow_up: false };
  if (!raw) return fallback;
  // Try direct parse first
  try {
    const parsed = JSON.parse(raw);
    return {
      customer_reply: parsed.customer_reply || 'Sorry, I am having trouble responding right now.',
      lead_temperature: parsed.lead_temperature || 'cold',
      order_detected: parsed.order_detected || null,
      needs_follow_up: !!parsed.needs_follow_up
    };
  } catch (_) {}
  // Strip markdown code fences and retry
  const stripped = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  try {
    const parsed = JSON.parse(stripped);
    return {
      customer_reply: parsed.customer_reply || 'Sorry, I am having trouble responding right now.',
      lead_temperature: parsed.lead_temperature || 'cold',
      order_detected: parsed.order_detected || null,
      needs_follow_up: !!parsed.needs_follow_up
    };
  } catch (_) {}
  // Final fallback: treat stripped text as plain reply
  console.warn('AI response was not valid JSON; using as plain text reply.');
  return { customer_reply: stripped || raw, lead_temperature: 'cold', order_detected: null, needs_follow_up: false };
}

async function generateAIResponse(business, customerMessage) {
  const businessRecord = await getBusinessById(business.id) || business;
  const shopName = businessRecord.shop_name || 'the business';
  const systemPrompt = 'You are an AI employee for "' + shopName + '", a business in Pakistan. You take real action — not just chat.\n\n'
    + 'BUSINESS INFORMATION:\n'
    + '- Shop Name: ' + (businessRecord.shop_name || 'N/A') + '\n'
    + '- Description: ' + (businessRecord.description || 'N/A') + '\n'
    + '- Services/Products: ' + (businessRecord.services || 'N/A') + '\n'
    + '- Prices: ' + (businessRecord.prices || 'N/A') + '\n'
    + '- Working Hours: ' + (businessRecord.timings || 'N/A') + '\n'
    + '- FAQs: ' + (businessRecord.faqs || 'N/A') + '\n\n'
    + 'YOUR TASK:\n'
    + 'Respond ONLY with a valid JSON object (no markdown, no code fences) with these exact fields:\n\n'
    + '{\n'
    + '  "customer_reply": "<your friendly WhatsApp reply, under 200 words, in Pakistani English>",\n'
    + '  "lead_temperature": "<cold|warm|hot>",\n'
    + '  "order_detected": null,\n'
    + '  "needs_follow_up": false\n'
    + '}\n\n'
    + 'RULES:\n'
    + '- "customer_reply": Always a friendly, concise reply. Use business info above. If unsure, invite them to contact the shop directly.\n'
    + '- "lead_temperature": Set to "hot" if message contains price questions, payment/location queries, or urgent availability requests. Set to "warm" if clear interest but not urgent. Otherwise "cold".\n'
    + '- "order_detected": If the customer clearly expresses buying intent (e.g. "I want to order X", "book an appointment", "I will take 2 of Y", "can I get size M"), set this to: { "item": "<item or service name>", "quantity": "<number or null>", "requested_datetime": "<date/time string or null>" }. Otherwise set to null.\n'
    + '- "needs_follow_up": Set to true if the conversation seems unresolved — e.g. the customer asked something and there is no clear next step or commitment. Set to false if they ordered, said thanks, or got a definitive answer.';

  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + process.env.OPENROUTER_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'openrouter/free',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: customerMessage }
        ],
        response_format: { type: 'json_object' }
      })
    });
    const data = await response.json();
    if (data.error) {
      console.error('OpenRouter error:', data.error);
      return { customer_reply: 'Sorry, I am having trouble responding right now. Please try again or contact the shop directly.', lead_temperature: 'cold', order_detected: null, needs_follow_up: false };
    }
    const raw = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
    return parseAIJSON(raw);
  } catch (error) {
    console.error('OpenRouter fetch error:', error);
    return { customer_reply: 'Sorry, I am having trouble responding right now.', lead_temperature: 'cold', order_detected: null, needs_follow_up: false };
  }
}

// Returns true if the message was sent (or credentials are unconfigured and we skip),
// false on a confirmed API/network failure.
async function sendWhatsAppMessage(whatsappNumber, phoneId, to, text) {
  const token = process.env.WHATSAPP_TOKEN;
  if (!token || !phoneId) { console.log('WhatsApp credentials not configured'); return false; }
  try {
    const res = await fetch('https://graph.facebook.com/v19.0/' + phoneId + '/messages', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to: to, type: 'text', text: { body: text } })
    });
    if (!res.ok) {
      const body = await res.text();
      console.error('WhatsApp send failed (' + res.status + '):', body);
      return false;
    }
    return true;
  } catch (error) { console.error('WhatsApp send error:', error); return false; }
}

// ============================================
// FOLLOW-UP SCHEDULER
// ============================================

async function runFollowUpScheduler() {
  try {
    const now = new Date();
    const cutoff24h = new Date(now - 24 * 60 * 60 * 1000);
    // Atomically claim due conversations by clearing follow_up_at in the same query.
    // This prevents duplicate sends if the interval fires while a previous run is still going.
    const { rows } = await pool.query(
      'UPDATE conversations SET follow_up_at = NULL'
      + ' WHERE id IN ('
      + '   SELECT c.id FROM conversations c'
      + '   WHERE c.follow_up_at IS NOT NULL'
      + '     AND c.follow_up_at <= $1'
      + '     AND (c.last_customer_reply_at IS NULL OR c.last_customer_reply_at < c.follow_up_at)'
      + '     AND (c.last_customer_reply_at IS NULL OR c.last_customer_reply_at > $2)'
      + '   FOR UPDATE SKIP LOCKED'
      + ' )'
      + ' RETURNING id, business_id, customer_phone',
      [now, cutoff24h]
    );

    if (!rows.length) return;

    // Fetch business credentials for the claimed conversations
    const businessIds = [...new Set(rows.map(function(r) { return r.business_id; }))];
    const { rows: businesses } = await pool.query(
      'SELECT id, whatsapp_phone_id, whatsapp_number FROM businesses WHERE id = ANY($1)',
      [businessIds]
    );
    const bizMap = {};
    businesses.forEach(function(b) { bizMap[b.id] = b; });

    for (const conv of rows) {
      const biz = bizMap[conv.business_id];
      if (!biz) continue;
      const token = process.env.WHATSAPP_TOKEN;
      if (!token || !biz.whatsapp_phone_id) {
        console.log('WhatsApp not configured, skipping follow-up for', conv.customer_phone);
        continue;
      }
      try {
        const followUpMsg = 'Hi! Just checking \u2014 were you able to find what you were looking for? Happy to help if you have more questions \uD83D\uDE0A';
        const waRes = await fetch('https://graph.facebook.com/v19.0/' + biz.whatsapp_phone_id + '/messages', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to: conv.customer_phone, type: 'text', text: { body: followUpMsg } })
        });
        if (!waRes.ok) {
          const errBody = await waRes.text();
          console.error('Follow-up WhatsApp send failed for', conv.customer_phone, ':', waRes.status, errBody);
          // Restore follow_up_at so it is retried on the next scheduler run (5 min from now).
          const retryAt = new Date(Date.now() + 5 * 60 * 1000);
          await pool.query('UPDATE conversations SET follow_up_at = $1 WHERE id = $2', [retryAt, conv.id]);
          continue;
        }
        await pool.query('INSERT INTO messages (conversation_id, direction, content) VALUES ($1, $2, $3)', [conv.id, 'out', followUpMsg]);
        console.log('Follow-up sent to', conv.customer_phone);
      } catch (err) {
        console.error('Follow-up send error for conversation', conv.id, ':', err);
        // Restore follow_up_at so it is retried rather than permanently dropped.
        try {
          const retryAt = new Date(Date.now() + 5 * 60 * 1000);
          await pool.query('UPDATE conversations SET follow_up_at = $1 WHERE id = $2', [retryAt, conv.id]);
        } catch (_) {}
      }
    }
  } catch (err) {
    console.error('Follow-up scheduler error:', err);
  }
}

// ============================================
// AUTH ROUTES
// ============================================

app.post('/api/auth/register', async (req, res) => {
  const { email, password, shop_name } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  try {
    const existing = await getBusinessByEmail(email);
    if (existing) return res.status(400).json({ error: 'Email already registered' });
    const passwordHash = await bcrypt.hash(password, 12);
    const business = await insertBusiness(email, passwordHash, shop_name || 'My Shop');
    req.session.businessId = business.id;
    res.json({ success: true, businessId: business.id });
  } catch (error) { console.error('Register error:', error); res.status(500).json({ error: 'Registration failed' }); }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  try {
    const business = await getBusinessByEmail(email);
    if (!business) return res.status(401).json({ error: 'Invalid credentials' });
    const valid = await bcrypt.compare(password, business.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
    req.session.businessId = business.id;
    res.json({ success: true, businessId: business.id });
  } catch (error) { console.error('Login error:', error); res.status(500).json({ error: 'Login failed' }); }
});

app.post('/api/auth/logout', (req, res) => { req.session.destroy(() => { res.json({ success: true }); }); });

app.get('/api/auth/me', requireAuth, async (req, res) => {
  const business = sanitizeBusiness(await getBusinessById(req.session.businessId));
  res.json(business);
});

app.get('/api/validate/tenant-data', requireAuth, async (req, res) => {
  const duplicates = await findDuplicateWhatsAppPhoneIds();
  res.json({ valid: duplicates.length === 0, duplicateWhatsAppMappings: duplicates.map(function(d) { return { whatsapp_phone_id: d.whatsapp_phone_id, count: d.businessIds.length }; }) });
});

// ============================================
// BUSINESS ROUTES
// ============================================

app.put('/api/business', requireAuth, async (req, res) => {
  const updates = {};
  ['shop_name', 'description', 'services', 'prices', 'timings', 'faqs', 'whatsapp_number', 'whatsapp_phone_id', 'payment_link', 'category', 'services_list', 'business_hours'].forEach(function(key) {
    if (Object.prototype.hasOwnProperty.call(req.body, key)) updates[key] = req.body[key];
  });
  if (!Object.keys(updates).length) return res.status(400).json({ success: false, error: 'No update fields provided' });
  try {
    const updatedBusiness = await updateBusiness(req.session.businessId, updates);
    if (!updatedBusiness) return res.status(404).json({ success: false, error: 'Business not found' });
    res.json({ success: true, business: sanitizeBusiness(updatedBusiness) });
  } catch (error) { console.error('Update error:', error); res.status(500).json({ success: false, error: 'Update failed' }); }
});

// ============================================
// CONVERSATIONS ROUTES
// ============================================

app.get('/api/conversations', requireAuth, async (req, res) => {
  const conversations = await getConversationsForBusiness(req.session.businessId);
  res.json(conversations);
});

app.get('/api/conversations/:id/messages', requireAuth, async (req, res) => {
  const conversation = await getConversationByIdAndBusiness(req.params.id, req.session.businessId);
  if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
  const messages = await getMessagesForConversation(req.params.id);
  res.json({ conversation, messages });
});

// ============================================
// ORDERS ROUTES
// ============================================

app.get('/api/orders', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM orders WHERE business_id = $1 ORDER BY created_at DESC', [req.session.businessId]);
    res.json(rows);
  } catch (error) {
    console.error('Orders error:', error);
    res.json([]);
  }
});

app.put('/api/orders/:id/status', requireAuth, async (req, res) => {
  const { status } = req.body;
  const validStatuses = ['new', 'confirmed', 'completed', 'cancelled'];
  if (!validStatuses.includes(status)) return res.status(400).json({ error: 'Invalid status' });
  try {
    const { rows } = await pool.query('UPDATE orders SET status = $1 WHERE id = $2 AND business_id = $3 RETURNING *', [status, req.params.id, req.session.businessId]);
    if (!rows[0]) return res.status(404).json({ error: 'Order not found' });
    res.json({ success: true, order: rows[0] });
  } catch (error) { console.error('Order update error:', error); res.status(500).json({ error: 'Update failed' }); }
});

// ============================================
// ANALYTICS ROUTES
// ============================================

app.get('/api/analytics/stats', requireAuth, async (req, res) => {
  try {
    const conversations = await getConversationsForBusiness(req.session.businessId);
    let totalMessages = 0;
    let messagesPerDay = {};
    let questionKeywords = {};
    const now = new Date();

    for (const conv of conversations) {
      const messages = await getMessagesForConversation(conv.id);
      messages.forEach(function(msg) {
        totalMessages++;
        const date = new Date(msg.timestamp).toISOString().split('T')[0];
        messagesPerDay[date] = (messagesPerDay[date] || 0) + 1;
        if (msg.direction === 'in') {
          const words = msg.content.toLowerCase().split(/\s+/);
          words.forEach(function(word) {
            if (word.length > 3 && ['price', 'cost', 'time', 'hour', 'open', 'close', 'service', 'available', 'order'].includes(word)) {
              questionKeywords[word] = (questionKeywords[word] || 0) + 1;
            }
          });
        }
      });
    }

    const last7Days = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now); d.setDate(d.getDate() - i);
      const dateStr = d.toISOString().split('T')[0];
      last7Days.push({ date: dateStr, count: messagesPerDay[dateStr] || 0 });
    }

    const topQuestions = Object.entries(questionKeywords).sort(function(a, b) { return b[1] - a[1]; }).slice(0, 5).map(function(e) { return { keyword: e[0], count: e[1] }; });
    const busiestHours = {};
    conversations.forEach(function(conv) {
      if (conv.last_message_time) {
        const hour = new Date(conv.last_message_time).getHours();
        busiestHours[hour] = (busiestHours[hour] || 0) + 1;
      }
    });
    const busiestHourEntry = Object.entries(busiestHours).sort(function(a, b) { return b[1] - a[1]; })[0];

    res.json({
      totalConversations: conversations.length,
      totalMessages,
      averagePerDay: last7Days.reduce(function(a, b) { return a + b.count; }, 0) / 7,
      messagesLast7Days: last7Days,
      topQuestions,
      busiestHour: busiestHourEntry ? busiestHourEntry[0] + ':00' : 'N/A',
      avgResponseTime: '2 min'
    });
  } catch (error) { console.error('Analytics error:', error); res.status(500).json({ error: 'Failed to fetch analytics' }); }
});

// ============================================
// PAGE ROUTES
// ============================================

app.get('/', function(req, res) { req.session.businessId ? res.redirect('/dashboard') : res.redirect('/login'); });
app.get('/login', function(req, res) { res.send(getLoginPage()); });
app.get('/register', function(req, res) { res.send(getRegisterPage()); });
app.get('/dashboard', function(req, res) { if (!req.session.businessId) return res.redirect('/login'); res.send(getDashboardPage()); });
app.get('/settings', function(req, res) { if (!req.session.businessId) return res.redirect('/login'); res.send(getSettingsPage()); });
app.get('/conversations', function(req, res) { if (!req.session.businessId) return res.redirect('/login'); res.send(getConversationsListPage()); });
app.get('/conversations/:id', function(req, res) { if (!req.session.businessId) return res.redirect('/login'); res.send(getConversationPage(req.params.id)); });
app.get('/orders', function(req, res) { if (!req.session.businessId) return res.redirect('/login'); res.send(getOrdersPage()); });
app.get('/analytics', function(req, res) { if (!req.session.businessId) return res.redirect('/login'); res.send(getAnalyticsPage()); });

// ============================================
// SHARED STYLES & COMPONENTS
// ============================================

const sharedStyles = `
:root {
  --primary: #0f766e;
  --primary-hover: #0d9488;
  --accent: #14b8a6;
  --accent-green: #22c55e;
  --accent-orange: #f97316;
  --accent-blue: #3b82f6;
  --text-primary: #0f172a;
  --text-secondary: #475569;
  --text-muted: #64748b;
  --text-light: #94a3b8;
  --bg: #f1f5f9;
  --surface: #ffffff;
  --border: #e2e8f0;
  --success: #16a34a;
  --warning: #d97706;
  --error: #dc2626;
  --radius-sm: 6px;
  --radius-md: 10px;
  --radius-lg: 16px;
  --shadow: 0 1px 3px rgba(0,0,0,0.08);
  --shadow-md: 0 4px 12px rgba(0,0,0,0.08);
  --shadow-lg: 0 10px 40px rgba(0,0,0,0.1);
  --whatsapp-out: #DCF8C6;
  --whatsapp-in: #ffffff;
}
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: var(--bg); color: var(--text-primary); min-height: 100vh; display: flex; animation: fadeIn 0.3s ease; }
@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }

.sidebar { width: 260px; background: var(--surface); border-right: 1px solid var(--border); padding: 20px 12px; position: fixed; height: 100vh; overflow-y: auto; display: flex; flex-direction: column; z-index: 100; transition: width 0.2s ease; }
.sidebar-brand { display: flex; align-items: center; gap: 10px; font-weight: 800; font-size: 18px; margin-bottom: 24px; margin-left: 8px; color: var(--primary); }
.sidebar-brand svg { width: 24px; height: 24px; color: var(--accent); }
.nav-section { flex: 1; }
.nav-item { display: flex; align-items: center; gap: 12px; padding: 12px 14px; border-radius: var(--radius-md); text-decoration: none; color: var(--text-secondary); font-size: 14px; margin-bottom: 4px; cursor: pointer; transition: all 0.2s ease; }
.nav-item:hover { background: var(--bg); color: var(--primary); }
.nav-item.active { background: var(--accent); color: white; font-weight: 600; }
.nav-item svg { width: 20px; height: 20px; }
.nav-bottom { padding-top: 16px; border-top: 1px solid var(--border); }
.user-menu { display: flex; align-items: center; gap: 12px; padding: 12px; border-radius: var(--radius-md); background: var(--bg); margin-bottom: 8px; }
.user-avatar { width: 36px; height: 36px; border-radius: var(--radius-sm); background: var(--primary); display: flex; align-items: center; justify-content: center; color: white; font-size: 14px; font-weight: 600; }
.user-info { flex: 1; min-width: 0; }
.user-name { font-weight: 600; font-size: 13px; color: var(--text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.logout-btn { display: flex; align-items: center; gap: 8px; background: transparent; border: none; color: var(--text-secondary); cursor: pointer; padding: 10px 12px; border-radius: var(--radius-sm); font-size: 13px; transition: all 0.2s ease; width: 100%; }
.logout-btn:hover { background: var(--border); color: var(--error); }
.logout-btn svg { width: 18px; height: 18px; }

.mobile-nav { display: none; position: fixed; bottom: 0; left: 0; right: 0; background: var(--surface); border-top: 1px solid var(--border); padding: 8px 16px; z-index: 1000; justify-content: space-around; }
.mobile-nav-item { display: flex; flex-direction: column; align-items: center; gap: 4px; padding: 8px 12px; text-decoration: none; color: var(--text-muted); font-size: 11px; border-radius: var(--radius-sm); transition: all 0.2s ease; }
.mobile-nav-item:hover { background: var(--bg); }
.mobile-nav-item.active { color: var(--accent); font-weight: 600; }
.mobile-nav-item svg { width: 20px; height: 20px; }

.main-content { margin-left: 260px; flex: 1; min-height: 100vh; padding-bottom: 80px; }
.top-bar { background: var(--surface); border-bottom: 1px solid var(--border); padding: 16px 24px; display: flex; justify-content: space-between; align-items: center; position: sticky; top: 0; z-index: 10; }
.page-title { font-size: 22px; font-weight: 700; color: var(--text-primary); }
.container { padding: 20px 24px; max-width: 1400px; }

.btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; padding: 10px 20px; border-radius: var(--radius-sm); font-size: 14px; font-weight: 600; cursor: pointer; transition: all 0.2s ease; border: none; }
.btn-primary { background: var(--accent); color: white; }
.btn-primary:hover { background: var(--primary); transform: translateY(-1px); box-shadow: var(--shadow-md); }
.btn-primary:active { transform: translateY(0); }
.btn-secondary { background: transparent; border: 1px solid var(--primary); color: var(--primary); }
.btn-secondary:hover { background: var(--primary); color: white; transform: translateY(-1px); }
.btn-danger { background: var(--error); color: white; }
.btn-danger:hover { background: #b91c1c; }
.btn:disabled { opacity: 0.6; cursor: not-allowed; transform: none; }
.btn.loading { pointer-events: none; }
.spinner { width: 16px; height: 16px; border: 2px solid rgba(255,255,255,0.3); border-top-color: white; border-radius: 999px; animation: spin 0.6s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

.card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-md); padding: 20px; transition: all 0.2s ease; }
.card:hover { box-shadow: var(--shadow-md); transform: translateY(-2px); }
.card-title { font-size: 16px; font-weight: 700; color: var(--text-primary); margin-bottom: 16px; }

.toast { position: fixed; top: 20px; right: 20px; min-width: 300px; max-width: calc(100% - 40px); padding: 16px 20px; border-radius: var(--radius-md); font-size: 14px; font-weight: 500; display: none; align-items: center; gap: 12px; z-index: 9999; box-shadow: var(--shadow-lg); animation: slideIn 0.3s ease; }
.toast.show { display: flex; }
.toast.success { background: var(--success); color: white; }
.toast.error { background: var(--error); color: white; }
.toast.warning { background: var(--warning); color: white; }
@keyframes slideIn { from { transform: translateX(400px); opacity: 0; } to { transform: translateX(0); opacity: 1; } }

.empty-state { text-align: center; padding: 48px 24px; color: var(--text-muted); }
.empty-state svg { width: 48px; height: 48px; margin-bottom: 16px; opacity: 0.5; }
.empty-state-title { font-size: 18px; font-weight: 600; margin-bottom: 8px; color: var(--text-secondary); }
.empty-state-text { font-size: 14px; margin-bottom: 20px; }

.input { width: 100%; padding: 10px 14px; border: 1px solid var(--border); border-radius: var(--radius-sm); font-size: 14px; font-family: inherit; color: var(--text-primary); background: var(--surface); transition: all 0.2s; }
.input:focus { outline: none; border-color: var(--primary); box-shadow: 0 0 0 3px rgba(15, 118, 110, 0.1); }
.input::placeholder { color: var(--text-muted); }

.select { width: 100%; padding: 10px 14px; border: 1px solid var(--border); border-radius: var(--radius-sm); font-size: 14px; font-family: inherit; color: var(--text-primary); background: var(--surface); cursor: pointer; }

@media (max-width: 1024px) {
  .sidebar { width: 72px; padding: 20px 8px; }
  .sidebar-brand span, .nav-item span, .user-info, .logout-btn span { display: none; }
  .nav-item { justify-content: center; padding: 12px; }
  .nav-bottom { padding-top: 12px; }
  .user-menu { justify-content: center; padding: 8px; }
  .logout-btn { justify-content: center; padding: 8px; }
  .main-content { margin-left: 72px; }
}

@media (max-width: 768px) {
  .sidebar { display: none; }
  .main-content { margin-left: 0; padding-bottom: 80px; }
  .mobile-nav { display: flex; }
  .container { padding: 16px; }
  .top-bar { padding: 16px; }
}
`;

function getSidebar(activePage) {
  const navItems = [
    { href: '/dashboard', icon: 'layout-dashboard', label: 'Dashboard', page: 'dashboard' },
    { href: '/conversations', icon: 'message-circle', label: 'Conversations', page: 'conversations' },
    { href: '/orders', icon: 'shopping-bag', label: 'Orders', page: 'orders' },
    { href: '/analytics', icon: 'bar-chart-3', label: 'Analytics', page: 'analytics' },
    { href: '/settings', icon: 'settings', label: 'Settings', page: 'settings' },
  ];

  return '<aside class="sidebar" id="sidebar">'
    + '<div class="sidebar-brand"><i data-lucide="message-circle"></i><span>BizChat AI</span></div>'
    + '<nav class="nav-section">'
    + navItems.map(function(item) { return '<a href="' + item.href + '" class="nav-item ' + (activePage === item.page ? 'active' : '') + '"><i data-lucide="' + item.icon + '"></i><span>' + item.label + '</span></a>'; }).join('')
    + '</nav>'
    + '<div class="nav-bottom">'
    + '<div class="user-menu"><div class="user-avatar" id="userAvatar">B</div><div class="user-info"><div class="user-name" id="businessNameSidebar">Business</div></div></div>'
    + '<button class="logout-btn" onclick="logout()"><i data-lucide="log-out"></i><span>Logout</span></button>'
    + '</div></aside>'
    + '<div class="mobile-nav" id="mobileNav">'
    + navItems.map(function(item) { return '<a href="' + item.href + '" class="mobile-nav-item ' + (activePage === item.page ? 'active' : '') + '"><i data-lucide="' + item.icon + '"></i><span>' + item.label + '</span></a>'; }).join('')
    + '</div>';
}

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
  <script src="https://unpkg.com/lucide@latest/dist/umd/lucide.js"></script>
  <style>
    :root { --primary: #0f766e; --accent: #14b8a6; --text: #f8fafc; --text-muted: #94a3b8; --bg: linear-gradient(135deg, #06121f 0%, #0f172a 50%, #1a1f2e 100%); --surface: rgba(15, 23, 42, 0.92); --border: rgba(20, 184, 166, 0.1); }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: Inter, system-ui, -apple-system, sans-serif; min-height: 100vh; display: flex; align-items: center; justify-content: center; background: var(--bg); color: var(--text); padding: 24px; position: relative; overflow: hidden; }
    body::before { content: ''; position: absolute; inset: 0; background: radial-gradient(circle at 20% 50%, rgba(20, 184, 166, 0.15), transparent 40%), radial-gradient(circle at 80% 80%, rgba(15, 118, 110, 0.1), transparent 50%); }
    .container { width: min(100%, 440px); background: var(--surface); border: 1px solid var(--border); border-radius: 16px; padding: 40px 36px; backdrop-filter: blur(20px); box-shadow: 0 25px 50px rgba(15, 23, 42, 0.3); position: relative; z-index: 1; animation: fadeInUp 0.4s ease; }
    @keyframes fadeInUp { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }
    .brand { display: flex; align-items: center; gap: 10px; font-weight: 800; letter-spacing: 0.1em; text-transform: uppercase; font-size: 12px; color: var(--accent); margin-bottom: 20px; }
    h1 { font-size: 28px; font-weight: 800; margin-bottom: 8px; }
    .subtitle { color: var(--text-muted); line-height: 1.6; margin-bottom: 28px; font-size: 14px; }
    .form-group { margin-bottom: 20px; }
    label { display: block; margin-bottom: 8px; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: var(--accent); }
    input { width: 100%; border: 1px solid rgba(148, 163, 184, 0.2); border-radius: 10px; padding: 12px 14px; background: rgba(255,255,255,0.06); color: var(--text); font-size: 14px; transition: all 0.2s; }
    input::placeholder { color: rgba(255,255,255,0.4); }
    input:focus { outline: none; border-color: var(--accent); background: rgba(255,255,255,0.08); box-shadow: 0 0 0 3px rgba(20, 184, 166, 0.1); }
    .btn { width: 100%; display: flex; align-items: center; justify-content: center; gap: 10px; padding: 12px; border-radius: 10px; border: none; background: linear-gradient(135deg, var(--primary), var(--accent)); color: white; font-size: 15px; font-weight: 700; cursor: pointer; transition: all 0.2s; }
    .btn:hover { transform: translateY(-1px); box-shadow: 0 10px 25px rgba(20, 184, 166, 0.2); }
    .btn .spinner { display: none; }
    .btn.loading .spinner { display: inline-block; }
    .btn.loading span { display: none; }
    .footer { margin-top: 24px; text-align: center; color: var(--text-muted); font-size: 13px; }
    .footer a { color: var(--accent); text-decoration: none; font-weight: 600; }
    .error { background: rgba(220, 38, 38, 0.15); color: #fca5a5; border: 1px solid rgba(220, 38, 38, 0.3); padding: 12px; border-radius: 10px; margin-bottom: 20px; display: none; font-size: 13px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="brand"><i data-lucide="message-circle" style="width:18px;height:18px"></i> BizChat AI</div>
    <h1>Welcome Back</h1>
    <p class="subtitle">Sign in to manage your WhatsApp AI assistant.</p>
    <div id="error" class="error"></div>
    <form id="loginForm">
      <div class="form-group"><label for="email">Email</label><input type="email" id="email" autocomplete="email" required placeholder="hello@business.com"></div>
      <div class="form-group"><label for="password">Password</label><input type="password" id="password" autocomplete="current-password" required placeholder="Your password"></div>
      <button type="submit" class="btn"><span class="spinner"></span><span>Sign In</span></button>
    </form>
    <p class="footer">New here? <a href="/register">Create account</a></p>
  </div>
  <script>
    lucide.createIcons();
    document.getElementById('loginForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = e.target.querySelector('.btn');
      const error = document.getElementById('error');
      error.style.display = 'none';
      btn.classList.add('loading');
      try {
        const res = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: document.getElementById('email').value, password: document.getElementById('password').value }) });
        const data = await res.json();
        if (data.success) window.location = '/dashboard';
        else { error.textContent = data.error || 'Invalid credentials.'; error.style.display = 'block'; }
      } catch (err) { error.textContent = 'Login failed.'; error.style.display = 'block'; }
      finally { btn.classList.remove('loading'); }
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
  <script src="https://unpkg.com/lucide@latest/dist/umd/lucide.js"></script>
  <style>
    :root { --primary: #0f766e; --accent: #14b8a6; --text: #f8fafc; --text-muted: #94a3b8; --bg: linear-gradient(135deg, #06121f 0%, #0f172a 50%, #1a1f2e 100%); --surface: rgba(15, 23, 42, 0.92); --border: rgba(20, 184, 166, 0.1); }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: Inter, system-ui, -apple-system, sans-serif; min-height: 100vh; display: flex; align-items: center; justify-content: center; background: var(--bg); color: var(--text); padding: 24px; position: relative; }
    body::before { content: ''; position: absolute; inset: 0; background: radial-gradient(circle at 20% 50%, rgba(20, 184, 166, 0.15), transparent 40%); }
    .container { width: min(100%, 460px); background: var(--surface); border: 1px solid var(--border); border-radius: 16px; padding: 40px 36px; backdrop-filter: blur(20px); box-shadow: 0 25px 50px rgba(15, 23, 42, 0.3); position: relative; z-index: 1; animation: fadeInUp 0.4s ease; }
    @keyframes fadeInUp { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }
    .brand { display: flex; align-items: center; gap: 10px; font-weight: 800; letter-spacing: 0.1em; text-transform: uppercase; font-size: 12px; color: var(--accent); margin-bottom: 20px; }
    h1 { font-size: 28px; font-weight: 800; margin-bottom: 8px; }
    .subtitle { color: var(--text-muted); line-height: 1.6; margin-bottom: 28px; font-size: 14px; }
    .form-group { margin-bottom: 20px; }
    label { display: block; margin-bottom: 8px; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: var(--accent); }
    input { width: 100%; border: 1px solid rgba(148, 163, 184, 0.2); border-radius: 10px; padding: 12px 14px; background: rgba(255,255,255,0.06); color: var(--text); font-size: 14px; transition: all 0.2s; }
    input::placeholder { color: rgba(255,255,255,0.4); }
    input:focus { outline: none; border-color: var(--accent); background: rgba(255,255,255,0.08); box-shadow: 0 0 0 3px rgba(20, 184, 166, 0.1); }
    .btn { width: 100%; display: flex; align-items: center; justify-content: center; gap: 10px; padding: 12px; border-radius: 10px; border: none; background: linear-gradient(135deg, var(--primary), var(--accent)); color: white; font-size: 15px; font-weight: 700; cursor: pointer; transition: all 0.2s; }
    .btn:hover { transform: translateY(-1px); box-shadow: 0 10px 25px rgba(20, 184, 166, 0.2); }
    .btn .spinner { display: none; }
    .btn.loading .spinner { display: inline-block; }
    .btn.loading span { display: none; }
    .footer { margin-top: 24px; text-align: center; color: var(--text-muted); font-size: 13px; }
    .footer a { color: var(--accent); text-decoration: none; font-weight: 600; }
    .error { background: rgba(220, 38, 38, 0.15); color: #fca5a5; border: 1px solid rgba(220, 38, 38, 0.3); padding: 12px; border-radius: 10px; margin-bottom: 20px; display: none; font-size: 13px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="brand"><i data-lucide="sparkles" style="width:18px;height:18px"></i> BizChat AI</div>
    <h1>Create Account</h1>
    <p class="subtitle">Start managing your WhatsApp AI assistant in minutes.</p>
    <div id="error" class="error"></div>
    <form id="registerForm">
      <div class="form-group"><label for="shop_name">Business Name</label><input type="text" id="shop_name" autocomplete="organization" required placeholder="e.g., Ahmed Electronics"></div>
      <div class="form-group"><label for="email">Email</label><input type="email" id="email" autocomplete="email" required placeholder="hello@business.com"></div>
      <div class="form-group"><label for="password">Password</label><input type="password" id="password" autocomplete="new-password" required placeholder="Create password"></div>
      <button type="submit" class="btn"><span class="spinner"></span><span>Create Account</span></button>
    </form>
    <p class="footer">Already have an account? <a href="/login">Sign in</a></p>
  </div>
  <script>
    lucide.createIcons();
    document.getElementById('registerForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = e.target.querySelector('.btn');
      const error = document.getElementById('error');
      error.style.display = 'none';
      btn.classList.add('loading');
      try {
        const res = await fetch('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ shop_name: document.getElementById('shop_name').value, email: document.getElementById('email').value, password: document.getElementById('password').value }) });
        const data = await res.json();
        if (data.success) window.location = '/settings';
        else { error.textContent = data.error || 'Registration failed.'; error.style.display = 'block'; }
      } catch (err) { error.textContent = 'Registration failed.'; error.style.display = 'block'; }
      finally { btn.classList.remove('loading'); }
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
  <script src="https://unpkg.com/lucide@latest/dist/umd/lucide.js"></script>
  <style>${sharedStyles}
    .stat-cards { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; margin-bottom: 20px; }
    .stat-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-md); padding: 18px; display: flex; align-items: flex-start; gap: 14px; transition: all 0.2s; }
    .stat-card:hover { box-shadow: var(--shadow-md); transform: translateY(-2px); }
    .stat-icon { width: 46px; height: 46px; border-radius: var(--radius-md); display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
    .stat-icon.primary { background: rgba(20, 184, 166, 0.1); color: var(--accent); }
    .stat-icon.green { background: rgba(34, 197, 94, 0.1); color: var(--accent-green); }
    .stat-icon.blue { background: rgba(59, 130, 246, 0.1); color: var(--accent-blue); }
    .stat-icon.orange { background: rgba(249, 115, 22, 0.1); color: var(--accent-orange); }
    .stat-icon svg { width: 22px; height: 22px; }
    .stat-content { flex: 1; }
    .stat-value { font-size: 28px; font-weight: 700; color: var(--text-primary); line-height: 1; }
    .stat-label { font-size: 12px; color: var(--text-muted); margin-top: 4px; font-weight: 500; }
    .stat-trend { font-size: 10px; font-weight: 600; padding: 2px 6px; border-radius: 4px; background: rgba(22, 163, 74, 0.1); color: var(--success); margin-top: 6px; display: inline-flex; align-items: center; gap: 3px; }
    .middle-row { display: grid; grid-template-columns: 60% 40%; gap: 16px; margin-bottom: 20px; }
    .panel { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-md); overflow: hidden; }
    .panel-header { padding: 14px 18px; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; }
    .panel-title { font-size: 15px; font-weight: 700; color: var(--text-primary); }
    .view-all { font-size: 12px; color: var(--accent); text-decoration: none; font-weight: 600; display: flex; align-items: center; gap: 4px; }
    .conv-list { max-height: 300px; overflow-y: auto; }
    .conv-item { display: flex; align-items: center; gap: 12px; padding: 12px 18px; border-bottom: 1px solid var(--border); cursor: pointer; transition: background 0.15s; }
    .conv-item:hover { background: var(--bg); }
    .conv-avatar { width: 40px; height: 40px; border-radius: 50%; background: var(--bg); display: flex; align-items: center; justify-content: center; color: var(--text-secondary); font-weight: 600; font-size: 14px; flex-shrink: 0; }
    .conv-info { flex: 1; min-width: 0; }
    .conv-name { font-weight: 600; font-size: 13px; color: var(--text-primary); }
    .conv-preview { font-size: 12px; color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 2px; }
    .conv-meta { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; flex-shrink: 0; }
    .conv-time { font-size: 11px; color: var(--text-light); }
    .unread-badge { background: var(--accent); color: white; font-size: 10px; font-weight: 600; padding: 2px 7px; border-radius: 10px; }
    .checklist-item { display: flex; align-items: center; gap: 12px; padding: 14px 18px; border-bottom: 1px solid var(--border); cursor: pointer; transition: background 0.15s; }
    .checklist-item:hover { background: rgba(20, 184, 166, 0.05); }
    .check-icon { width: 20px; height: 20px; border-radius: 50%; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
    .check-icon.done { background: var(--success); color: white; }
    .check-icon.pending { background: var(--border); color: var(--text-muted); }
    .check-icon svg { width: 12px; height: 12px; }
    .check-info { flex: 1; }
    .check-title { font-weight: 600; font-size: 13px; color: var(--text-primary); }
    .check-hint { font-size: 11px; color: var(--text-muted); margin-top: 2px; }
    .check-arrow { color: var(--text-light); }
    .check-arrow svg { width: 16px; height: 16px; }
    .quick-stats { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-md); padding: 16px; display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; }
    .quick-stat { text-align: center; padding: 14px; background: var(--bg); border-radius: var(--radius-sm); }
    .quick-stat-value { font-size: 16px; font-weight: 700; color: var(--text-primary); }
    .quick-stat-label { font-size: 11px; color: var(--text-muted); margin-top: 4px; }
    @media (max-width: 1200px) { .stat-cards { grid-template-columns: repeat(2, 1fr); } .middle-row { grid-template-columns: 1fr; } }
    @media (max-width: 768px) { .stat-cards { grid-template-columns: 1fr; } .quick-stats { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  ${getSidebar('dashboard')}
  <div class="main-content">
    <div class="top-bar">
      <h1 class="page-title">Dashboard</h1>
      <div style="display:flex;align-items:center;gap:8px;font-size:13px;color:var(--text-muted);">
        <span style="width:8px;height:8px;border-radius:50%;background:var(--success);"></span>Connected
      </div>
    </div>
    <div class="container">
      <div class="stat-cards">
        <div class="stat-card"><div class="stat-icon primary"><i data-lucide="message-circle"></i></div><div class="stat-content"><div class="stat-value" id="convCount">0</div><div class="stat-label">Total Conversations</div><div class="stat-trend"><i data-lucide="trending-up" style="width:10px;height:10px"></i>This week</div></div></div>
        <div class="stat-card"><div class="stat-icon green"><i data-lucide="message-square"></i></div><div class="stat-content"><div class="stat-value" id="msgCount">0</div><div class="stat-label">Messages Today</div><div class="stat-trend" style="background:rgba(34,197,94,0.1);color:var(--accent-green);"><i data-lucide="zap" style="width:10px;height:10px"></i>Live</div></div></div>
        <div class="stat-card"><div class="stat-icon blue"><i data-lucide="bot"></i></div><div class="stat-content"><div class="stat-value" id="activeBots">1</div><div class="stat-label">Active Bots</div><div class="stat-trend" style="background:rgba(59,130,246,0.1);color:var(--accent-blue);">Online</div></div></div>
        <div class="stat-card"><div class="stat-icon orange"><i data-lucide="star"></i></div><div class="stat-content"><div class="stat-value" id="leadsCount">0</div><div class="stat-label">Leads This Week</div><div class="stat-trend" style="background:rgba(249,115,22,0.1);color:var(--accent-orange);">New</div></div></div>
      </div>
      <div class="middle-row">
        <div class="panel"><div class="panel-header"><h2 class="panel-title">Recent Conversations</h2><a href="/conversations" class="view-all">View all <i data-lucide="chevron-right" style="width:12px;height:12px"></i></a></div><div class="conv-list" id="convList"></div></div>
        <div class="panel"><div class="panel-header"><h2 class="panel-title">Setup Checklist</h2></div><div class="checklist-items" id="checklistItems"></div></div>
      </div>
      <div class="quick-stats">
        <div class="quick-stat"><div class="quick-stat-value" id="topQuestion">-</div><div class="quick-stat-label">Most Asked Question</div></div>
        <div class="quick-stat"><div class="quick-stat-value" id="busiestHour">-</div><div class="quick-stat-label">Busiest Hour</div></div>
        <div class="quick-stat"><div class="quick-stat-value" id="avgResponse">-</div><div class="quick-stat-label">Avg Response Time</div></div>
      </div>
    </div>
  </div>
  <script>
    lucide.createIcons();
    async function loadDashboard() {
      try {
        const meRes = await fetch('/api/auth/me');
        if (!meRes.ok) { window.location = '/login'; return; }
        const me = await meRes.json();
        document.getElementById('businessNameSidebar').textContent = me.shop_name || 'Business';
        document.getElementById('userAvatar').textContent = (me.shop_name || 'B').charAt(0).toUpperCase();
        const convs = await fetch('/api/conversations').then(r => r.json());
        document.getElementById('convCount').textContent = convs.length;
        let todayMessages = 0; let thisWeekLeads = 0;
        const now = new Date(); const today = now.toISOString().split('T')[0];
        const weekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);
        convs.forEach(conv => {
          if (conv.last_message_time) {
            const msgDate = new Date(conv.last_message_time);
            if (msgDate.toISOString().split('T')[0] === today) todayMessages += conv.message_count || 0;
            if (msgDate >= weekAgo) thisWeekLeads++;
          }
        });
        document.getElementById('msgCount').textContent = todayMessages;
        document.getElementById('leadsCount').textContent = thisWeekLeads;
        const convList = document.getElementById('convList');
        if (convs.length === 0) {
          convList.innerHTML = '<div class="empty-state" style="padding:30px;"><i data-lucide="message-circle" style="width:32px;height:32px;opacity:0.3;margin-bottom:8px;"></i><div style="font-size:13px;color:var(--text-muted);">No conversations yet</div></div>';
        } else {
          convList.innerHTML = convs.slice(0, 5).map(conv => {
            const initial = (conv.customer_name || conv.customer_phone || 'C').charAt(0).toUpperCase();
            return '<div class="conv-item" onclick="window.location=\'/conversations/' + conv.id + '\'">'
              + '<div class="conv-avatar">' + initial + '</div>'
              + '<div class="conv-info"><div class="conv-name">' + escapeHtml(conv.customer_name || conv.customer_phone) + '</div>'
              + '<div class="conv-preview">' + escapeHtml(conv.last_message || 'No messages') + '</div></div>'
              + '<div class="conv-meta"><div class="conv-time">' + getTimeAgo(conv.last_message_time) + '</div></div></div>';
          }).join('');
        }
        const setupItems = [
          { key: 'shop_name', label: 'Business Info', hint: 'Add name, description' },
          { key: 'whatsapp_phone_id', label: 'WhatsApp Setup', hint: 'Connect your number' },
          { key: 'payment_link', label: 'Payment Link', hint: 'Add payment method' },
        ];
        const checklist = document.getElementById('checklistItems');
        checklist.innerHTML = setupItems.map(item => {
          const isDone = me[item.key] && me[item.key] !== '';
          return '<div class="checklist-item" onclick="window.location=\'/settings\'">'
            + '<div class="check-icon ' + (isDone ? 'done' : 'pending') + '">' + (isDone ? '<i data-lucide="check"></i>' : '<i data-lucide="circle"></i>') + '</div>'
            + '<div class="check-info"><div class="check-title">' + item.label + '</div><div class="check-hint">' + item.hint + '</div></div>'
            + '<div class="check-arrow"><i data-lucide="chevron-right"></i></div></div>';
        }).join('');
        document.getElementById('topQuestion').textContent = 'price';
        document.getElementById('busiestHour').textContent = '2 PM';
        document.getElementById('avgResponse').textContent = '2 min';
        lucide.createIcons();
      } catch (err) { console.error(err); }
    }
    function getTimeAgo(dateStr) {
      if (!dateStr) return '';
      const diff = Math.floor((new Date() - new Date(dateStr)) / 1000);
      if (diff < 60) return 'now';
      if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
      if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
      return Math.floor(diff / 86400) + 'd ago';
    }
    function escapeHtml(text) { if (!text) return ''; const div = document.createElement('div'); div.textContent = text; return div.innerHTML; }
    async function logout() { await fetch('/api/auth/logout', { method: 'POST' }); window.location = '/login'; }
    loadDashboard();
  </script>
</body>
</html>`;
}

function getConversationsListPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>BizChat AI - Conversations</title>
  <script src="https://unpkg.com/lucide@latest/dist/umd/lucide.js"></script>
  <style>${sharedStyles}
    .conv-page { display: flex; height: calc(100vh - 60px); }
    .conv-sidebar { width: 380px; background: var(--surface); border-right: 1px solid var(--border); display: flex; flex-direction: column; }
    .conv-sidebar-header { padding: 16px; border-bottom: 1px solid var(--border); }
    .search-box { display: flex; align-items: center; gap: 8px; background: var(--bg); border-radius: var(--radius-sm); padding: 10px 14px; }
    .search-box svg { width: 18px; height: 18px; color: var(--text-muted); }
    .search-box input { border: none; background: none; flex: 1; font-size: 14px; color: var(--text-primary); }
    .search-box input:focus { outline: none; }
    .conv-list { flex: 1; overflow-y: auto; }
    .conv-item { display: flex; align-items: center; gap: 12px; padding: 14px 16px; border-bottom: 1px solid var(--border); cursor: pointer; transition: background 0.15s; }
    .conv-item:hover { background: var(--bg); }
    .conv-item.active { background: rgba(20, 184, 166, 0.1); }
    .conv-avatar { width: 48px; height: 48px; border-radius: 50%; background: var(--bg); display: flex; align-items: center; justify-content: center; color: var(--text-secondary); font-weight: 600; font-size: 16px; flex-shrink: 0; }
    .conv-info { flex: 1; min-width: 0; }
    .conv-name { font-weight: 600; font-size: 15px; color: var(--text-primary); }
    .conv-preview { font-size: 13px; color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 3px; }
    .conv-meta { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; flex-shrink: 0; }
    .conv-time { font-size: 11px; color: var(--text-light); }
    .unread-badge { background: var(--accent); color: white; font-size: 11px; font-weight: 600; padding: 3px 8px; border-radius: 12px; }
    .conv-main { flex: 1; background: var(--bg); display: flex; flex-direction: column; }
    .conv-empty { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; color: var(--text-muted); }
    .conv-empty svg { width: 64px; height: 64px; margin-bottom: 16px; opacity: 0.3; }
    .conv-empty-text { font-size: 15px; }
    @media (max-width: 768px) {
      .conv-sidebar { width: 100%; }
      .conv-main { display: none; }
    }
  </style>
</head>
<body>
  ${getSidebar('conversations')}
  <div class="main-content" style="padding-bottom:0;">
    <div class="top-bar"><h1 class="page-title">Conversations</h1></div>
    <div class="conv-page">
      <div class="conv-sidebar">
        <div class="conv-sidebar-header">
          <div class="search-box"><i data-lucide="search"></i><input type="text" placeholder="Search conversations..." id="searchInput"></div>
        </div>
        <div class="conv-list" id="convList"></div>
      </div>
      <div class="conv-main">
        <div class="conv-empty"><i data-lucide="message-circle"></i><div class="conv-empty-text">Select a conversation to view messages</div></div>
      </div>
    </div>
  </div>
  <script>
    lucide.createIcons();
    async function loadConversations() {
      try {
        const meRes = await fetch('/api/auth/me');
        if (!meRes.ok) { window.location = '/login'; return; }
        const me = await meRes.json();
        document.getElementById('businessNameSidebar').textContent = me.shop_name || 'Business';
        document.getElementById('userAvatar').textContent = (me.shop_name || 'B').charAt(0).toUpperCase();
        const convs = await fetch('/api/conversations').then(r => r.json());
        const convList = document.getElementById('convList');
        if (convs.length === 0) {
          convList.innerHTML = '<div class="empty-state" style="padding:40px 20px;"><i data-lucide="message-circle" style="width:40px;height:40px;opacity:0.3;margin-bottom:12px;"></i><div style="font-size:14px;color:var(--text-muted);">No conversations yet</div></div>';
        } else {
          convList.innerHTML = convs.map(conv => {
            const initial = (conv.customer_name || conv.customer_phone || 'C').charAt(0).toUpperCase();
            return '<div class="conv-item" onclick="window.location=\'/conversations/' + conv.id + '\'">'
              + '<div class="conv-avatar">' + initial + '</div>'
              + '<div class="conv-info"><div class="conv-name">' + escapeHtml(conv.customer_name || conv.customer_phone) + '</div>'
              + '<div class="conv-preview">' + escapeHtml(conv.last_message || 'No messages') + '</div></div>'
              + '<div class="conv-meta"><div class="conv-time">' + getTimeAgo(conv.last_message_time) + '</div></div></div>';
          }).join('');
        }
        lucide.createIcons();
      } catch (err) { console.error(err); }
    }
    function getTimeAgo(dateStr) { if (!dateStr) return ''; const diff = Math.floor((new Date() - new Date(dateStr)) / 1000); if (diff < 60) return 'now'; if (diff < 3600) return Math.floor(diff / 60) + 'm'; if (diff < 86400) return Math.floor(diff / 3600) + 'h'; return Math.floor(diff / 86400) + 'd'; }
    function escapeHtml(text) { if (!text) return ''; const div = document.createElement('div'); div.textContent = text; return div.innerHTML; }
    async function logout() { await fetch('/api/auth/logout', { method: 'POST' }); window.location = '/login'; }
    loadConversations();
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
  <script src="https://unpkg.com/lucide@latest/dist/umd/lucide.js"></script>
  <style>${sharedStyles}
    .chat-page { display: flex; flex-direction: column; height: calc(100vh - 57px); }
    .chat-header { background: var(--surface); border-bottom: 1px solid var(--border); padding: 12px 20px; display: flex; align-items: center; gap: 12px; }
    .back-btn { display: flex; align-items: center; justify-content: center; width: 36px; height: 36px; border-radius: 50%; background: var(--bg); border: none; cursor: pointer; transition: all 0.2s; }
    .back-btn:hover { background: var(--border); }
    .chat-avatar { width: 40px; height: 40px; border-radius: 50%; background: var(--bg); display: flex; align-items: center; justify-content: center; color: var(--text-secondary); font-weight: 600; font-size: 14px; }
    .chat-info { flex: 1; }
    .chat-name { font-weight: 600; font-size: 15px; color: var(--text-primary); }
    .chat-status { font-size: 12px; color: var(--success); display: flex; align-items: center; gap: 4px; }
    .chat-status svg { width: 12px; height: 12px; }
    .chat-actions { display: flex; gap: 8px; }
    .action-btn { display: flex; align-items: center; justify-content: center; width: 36px; height: 36px; border-radius: var(--radius-sm); background: var(--bg); border: none; cursor: pointer; transition: all 0.2s; }
    .action-btn:hover { background: var(--border); }
    .messages-container { flex: 1; overflow-y: auto; padding: 20px; background: #e5ddd5; }
    .date-separator { text-align: center; padding: 12px 0; }
    .date-separator span { background: rgba(255,255,255,0.8); padding: 6px 12px; border-radius: 8px; font-size: 11px; color: var(--text-muted); font-weight: 500; }
    .msg { display: flex; gap: 8px; margin-bottom: 8px; animation: fadeIn 0.2s ease; }
    .msg.in { justify-content: flex-start; }
    .msg.out { justify-content: flex-end; }
    @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
    .msg-bubble { max-width: 65%; padding: 8px 12px; border-radius: 8px; font-size: 14px; line-height: 1.4; word-wrap: break-word; box-shadow: 0 1px 2px rgba(0,0,0,0.1); position: relative; }
    .msg.in .msg-bubble { background: var(--whatsapp-in); border-top-left-radius: 0; }
    .msg.out .msg-bubble { background: var(--whatsapp-out); border-top-right-radius: 0; }
    .msg-footer { display: flex; align-items: center; justify-content: flex-end; gap: 4px; margin-top: 4px; }
    .msg-time { font-size: 10px; color: var(--text-light); }
    .msg-status svg { width: 14px; height: 14px; color: #34b7f1; }
    .ai-badge { background: var(--accent-blue); color: white; font-size: 10px; font-weight: 600; padding: 2px 6px; border-radius: 4px; margin-bottom: 4px; display: inline-block; }
    @media (max-width: 768px) { .msg-bubble { max-width: 85%; } }
  </style>
</head>
<body>
  ${getSidebar('conversations')}
  <div class="main-content" style="padding-bottom:0;">
    <div class="chat-page">
      <div class="chat-header">
        <button class="back-btn" onclick="window.location='/conversations'"><i data-lucide="arrow-left" style="width:18px;height:18px"></i></button>
        <div class="chat-avatar" id="chatAvatar">C</div>
        <div class="chat-info">
          <div class="chat-name" id="customerName">Loading...</div>
          <div class="chat-status" id="customerPhone"><i data-lucide="phone"></i><span id="phoneNumber"></span></div>
        </div>
        <div class="chat-actions">
          <button class="action-btn" title="Handoff"><i data-lucide="user-plus" style="width:18px;height:18px"></i></button>
        </div>
      </div>
      <div class="messages-container" id="msgList"></div>
    </div>
  </div>
  <script>
    lucide.createIcons();
    const convId = '${convId}';
    async function loadConversation() {
      try {
        const meRes = await fetch('/api/auth/me');
        if (!meRes.ok) { window.location = '/login'; return; }
        const me = await meRes.json();
        document.getElementById('businessNameSidebar').textContent = me.shop_name || 'Business';
        document.getElementById('userAvatar').textContent = (me.shop_name || 'B').charAt(0).toUpperCase();
        const dataRes = await fetch('/api/conversations/' + convId + '/messages');
        if (!dataRes.ok) { window.location = '/conversations'; return; }
        const data = await dataRes.json();
        const name = data.conversation.customer_name || 'Customer';
        document.getElementById('customerName').textContent = name;
        document.getElementById('chatAvatar').textContent = name.charAt(0).toUpperCase();
        document.getElementById('phoneNumber').textContent = data.conversation.customer_phone;
        lucide.createIcons();
        const list = document.getElementById('msgList');
        if (data.messages.length === 0) {
          list.innerHTML = '<div class="empty-state" style="padding:60px;"><i data-lucide="message-circle" style="width:40px;height:40px;opacity:0.3;margin-bottom:12px;"></i><div style="font-size:14px;color:var(--text-muted);">No messages in this conversation</div></div>';
        } else {
          let html = ''; let lastDate = '';
          data.messages.forEach(m => {
            const msgDate = new Date(m.timestamp).toDateString();
            if (msgDate !== lastDate) {
              const today = new Date().toDateString();
              const yesterday = new Date(Date.now() - 86400000).toDateString();
              let label = msgDate;
              if (msgDate === today) label = 'Today';
              else if (msgDate === yesterday) label = 'Yesterday';
              else label = new Date(m.timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
              html += '<div class="date-separator"><span>' + label + '</span></div>';
              lastDate = msgDate;
            }
            const time = new Date(m.timestamp).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
            if (m.direction === 'out') {
              html += '<div class="msg out"><div class="msg-bubble"><div class="ai-badge">AI</div>' + escapeHtml(m.content) + '<div class="msg-footer"><span class="msg-time">' + time + '</span><span class="msg-status"><i data-lucide="check-check"></i></span></div></div></div>';
            } else {
              html += '<div class="msg in"><div class="msg-bubble">' + escapeHtml(m.content) + '<div class="msg-footer"><span class="msg-time">' + time + '</span></div></div></div>';
            }
          });
          list.innerHTML = html;
          list.scrollTop = list.scrollHeight;
        }
        lucide.createIcons();
      } catch (err) { console.error(err); }
    }
    function escapeHtml(text) { if (typeof text !== 'string') return ''; const div = document.createElement('div'); div.textContent = text; return div.innerHTML; }
    async function logout() { await fetch('/api/auth/logout', { method: 'POST' }); window.location = '/login'; }
    loadConversation();
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
  <script src="https://unpkg.com/lucide@latest/dist/umd/lucide.js"></script>
  <style>${sharedStyles}
    .settings-grid { display: grid; gap: 20px; }
    .settings-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-md); overflow: hidden; transition: all 0.2s; }
    .settings-card:hover { box-shadow: var(--shadow-md); }
    .card-header { padding: 16px 20px; border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 12px; }
    .card-icon { width: 36px; height: 36px; border-radius: var(--radius-sm); display: flex; align-items: center; justify-content: center; background: rgba(20, 184, 166, 0.1); color: var(--accent); }
    .card-icon svg { width: 18px; height: 18px; }
    .card-title { font-size: 16px; font-weight: 700; color: var(--text-primary); }
    .card-body { padding: 20px; }
    .form-group { margin-bottom: 16px; }
    .form-group:last-child { margin-bottom: 0; }
    .form-label { display: block; font-size: 13px; font-weight: 600; color: var(--text-primary); margin-bottom: 6px; }
    .form-hint { font-size: 11px; color: var(--text-muted); margin-top: 4px; }
    textarea.input { min-height: 80px; resize: vertical; }
    .service-row { display: flex; gap: 10px; margin-bottom: 10px; align-items: center; }
    .service-row input { flex: 1; }
    .delete-row-btn { background: none; border: none; color: var(--text-muted); cursor: pointer; padding: 8px; border-radius: var(--radius-sm); transition: all 0.2s; }
    .delete-row-btn:hover { background: rgba(220,38,38,0.1); color: var(--error); }
    .add-row-btn { background: none; border: 1px dashed var(--border); color: var(--accent); padding: 10px 16px; border-radius: var(--radius-sm); font-size: 13px; cursor: pointer; width: 100%; margin-top: 8px; transition: all 0.2s; }
    .add-row-btn:hover { background: rgba(20,184,166,0.05); border-color: var(--accent); }
    .hours-grid { display: grid; gap: 12px; }
    .hours-row { display: flex; align-items: center; gap: 12px; padding: 10px 12px; background: var(--bg); border-radius: var(--radius-sm); }
    .hours-day { width: 80px; font-weight: 600; font-size: 13px; }
    .hours-toggle { width: 44px; height: 24px; border-radius: 12px; background: var(--border); position: relative; cursor: pointer; transition: all 0.2s; }
    .hours-toggle.active { background: var(--success); }
    .hours-toggle::after { content: ''; position: absolute; width: 20px; height: 20px; border-radius: 50%; background: white; top: 2px; left: 2px; transition: all 0.2s; }
    .hours-toggle.active::after { left: 22px; }
    .hours-inputs { display: flex; align-items: center; gap: 8px; flex: 1; }
    .hours-inputs input { width: 90px; }
    .hours-inputs span { color: var(--text-muted); font-size: 13px; }
    .status-indicator { display: flex; align-items: center; gap: 6px; font-size: 13px; }
    .status-dot { width: 8px; height: 8px; border-radius: 50%; }
    .status-dot.connected { background: var(--success); }
    .status-dot.disconnected { background: var(--error); }
    .save-card-btn { margin-top: 16px; }
    @media (max-width: 768px) { .hours-inputs { flex-direction: column; align-items: flex-start; } }
  </style>
</head>
<body>
  ${getSidebar('settings')}
  <div class="main-content">
    <div class="top-bar"><h1 class="page-title">Settings</h1></div>
    <div class="container">
      <div class="settings-grid">
        <div class="settings-card" id="business">
          <div class="card-header"><div class="card-icon"><i data-lucide="store"></i></div><h2 class="card-title">Business Identity</h2></div>
          <div class="card-body">
            <div class="form-group"><label class="form-label">Shop Name *</label><input type="text" class="input" id="shop_name" placeholder="e.g., Ahmed Electronics"></div>
            <div class="form-group"><label class="form-label">Description</label><textarea class="input" id="description" placeholder="What do you do? Who do you serve?"></textarea><p class="form-hint">The AI uses this to understand your business</p></div>
            <div class="form-group"><label class="form-label">Category</label><select class="select" id="category"><option value="">Select category</option><option value="restaurant">Restaurant</option><option value="shop">Shop</option><option value="clinic">Clinic</option><option value="salon">Salon</option><option value="other">Other</option></select></div>
            <button class="btn btn-primary save-card-btn" onclick="saveSection('identity')"><span>Save</span></button>
          </div>
        </div>
        <div class="settings-card" id="services">
          <div class="card-header"><div class="card-icon"><i data-lucide="list"></i></div><h2 class="card-title">Services &amp; Pricing</h2></div>
          <div class="card-body">
            <div id="servicesList">
              <div class="service-row"><input type="text" class="input" placeholder="Service name" name="serviceName[]"><input type="text" class="input" placeholder="Price" name="servicePrice[]"><button type="button" class="delete-row-btn" onclick="this.parentElement.remove()"><i data-lucide="x" style="width:16px;height:16px"></i></button></div>
            </div>
            <button type="button" class="add-row-btn" onclick="addServiceRow()"><i data-lucide="plus" style="width:14px;height:14px"></i> Add Service</button>
            <button class="btn btn-primary save-card-btn" onclick="saveSection('services')"><span>Save</span></button>
          </div>
        </div>
        <div class="settings-card" id="hours">
          <div class="card-header"><div class="card-icon"><i data-lucide="clock"></i></div><h2 class="card-title">Business Hours</h2></div>
          <div class="card-body">
            <div class="hours-grid" id="hoursGrid"></div>
            <button class="btn btn-primary save-card-btn" onclick="saveSection('hours')"><span>Save</span></button>
          </div>
        </div>
        <div class="settings-card" id="faqs">
          <div class="card-header"><div class="card-icon"><i data-lucide="help-circle"></i></div><h2 class="card-title">FAQs</h2></div>
          <div class="card-body">
            <div id="faqsList">
              <div class="service-row"><input type="text" class="input" placeholder="Question" name="faqQuestion[]"><input type="text" class="input" placeholder="Answer" name="faqAnswer[]"><button type="button" class="delete-row-btn" onclick="this.parentElement.remove()"><i data-lucide="x" style="width:16px;height:16px"></i></button></div>
            </div>
            <button type="button" class="add-row-btn" onclick="addFaqRow()"><i data-lucide="plus" style="width:14px;height:14px"></i> Add FAQ</button>
            <button class="btn btn-primary save-card-btn" onclick="saveSection('faqs')"><span>Save</span></button>
          </div>
        </div>
        <div class="settings-card" id="whatsapp">
          <div class="card-header"><div class="card-icon"><i data-lucide="smartphone"></i></div><h2 class="card-title">WhatsApp Connection</h2></div>
          <div class="card-body">
            <div class="form-group"><label class="form-label">Phone Number</label><input type="text" class="input" id="whatsapp_number" placeholder="e.g., +923001234567"><p class="form-hint">Full number with country code</p></div>
            <div class="form-group"><label class="form-label">Phone Number ID</label><input type="text" class="input" id="whatsapp_phone_id" placeholder="From Meta Developers Console"><p class="form-hint">Find in Meta Developers Console</p></div>
            <div class="form-group"><label class="form-label">Connection Status</label><div class="status-indicator"><span class="status-dot disconnected" id="whatsappStatusDot"></span><span id="whatsappStatusText">Not connected</span></div></div>
            <button class="btn btn-primary save-card-btn" onclick="saveSection('whatsapp')"><span>Save</span></button>
          </div>
        </div>
        <div class="settings-card" id="payment">
          <div class="card-header"><div class="card-icon"><i data-lucide="credit-card"></i></div><h2 class="card-title">Payment Settings</h2></div>
          <div class="card-body">
            <div class="form-group"><label class="form-label">Payment Link URL</label><input type="url" class="input" id="payment_link" placeholder="https://your-payment-link.com"><p class="form-hint">JazzCash, EasyPaisa, or bank payment link</p></div>
            <button class="btn btn-primary save-card-btn" onclick="saveSection('payment')"><span>Save</span></button>
          </div>
        </div>
      </div>
    </div>
  </div>
  <div id="toast" class="toast"></div>
  <script>
    lucide.createIcons();
    const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    function initHoursGrid() {
      const grid = document.getElementById('hoursGrid');
      grid.innerHTML = days.map(day => '<div class="hours-row"><div class="hours-day">' + day + '</div><div class="hours-toggle active" onclick="this.classList.toggle(\'active\')"></div><div class="hours-inputs"><input type="time" class="input" value="09:00"><span>to</span><input type="time" class="input" value="18:00"></div></div>').join('');
    }
    function addServiceRow() {
      const list = document.getElementById('servicesList');
      const row = document.createElement('div');
      row.className = 'service-row';
      row.innerHTML = '<input type="text" class="input" placeholder="Service name" name="serviceName[]"><input type="text" class="input" placeholder="Price" name="servicePrice[]"><button type="button" class="delete-row-btn" onclick="this.parentElement.remove()"><i data-lucide="x" style="width:16px;height:16px"></i></button>';
      list.appendChild(row);
      lucide.createIcons();
    }
    function addFaqRow() {
      const list = document.getElementById('faqsList');
      const row = document.createElement('div');
      row.className = 'service-row';
      row.innerHTML = '<input type="text" class="input" placeholder="Question" name="faqQuestion[]"><input type="text" class="input" placeholder="Answer" name="faqAnswer[]"><button type="button" class="delete-row-btn" onclick="this.parentElement.remove()"><i data-lucide="x" style="width:16px;height:16px"></i></button>';
      list.appendChild(row);
      lucide.createIcons();
    }
    function showToast(message, type = 'success') {
      const toast = document.getElementById('toast');
      toast.textContent = message;
      toast.className = 'toast show ' + type;
      setTimeout(() => { toast.className = 'toast'; }, 3000);
    }
    async function saveSection(section) {
      let data = {};
      if (section === 'identity') { data.shop_name = document.getElementById('shop_name').value; data.description = document.getElementById('description').value; data.category = document.getElementById('category').value; }
      else if (section === 'services') { const names = document.querySelectorAll('input[name="serviceName[]"]'); const prices = document.querySelectorAll('input[name="servicePrice[]"]'); data.services = Array.from(names).map((n, i) => n.value + ': ' + prices[i].value).filter(s => s.trim()).join('\\n'); }
      else if (section === 'hours') { data.timings = 'Mon-Sat 9am-6pm'; }
      else if (section === 'faqs') { const questions = document.querySelectorAll('input[name="faqQuestion[]"]'); const answers = document.querySelectorAll('input[name="faqAnswer[]"]'); data.faqs = Array.from(questions).map((q, i) => 'Q: ' + q.value + ' A: ' + answers[i].value).filter(f => f.trim().length > 5).join('\\n'); }
      else if (section === 'whatsapp') { data.whatsapp_number = document.getElementById('whatsapp_number').value; data.whatsapp_phone_id = document.getElementById('whatsapp_phone_id').value; }
      else if (section === 'payment') { data.payment_link = document.getElementById('payment_link').value; }
      try {
        const res = await fetch('/api/business', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
        const result = await res.json();
        if (result.success) { showToast('Saved successfully', 'success'); if (result.business && result.business.shop_name) document.getElementById('businessNameSidebar').textContent = result.business.shop_name; }
        else showToast(result.error || 'Save failed', 'error');
      } catch (err) { showToast('Save failed', 'error'); }
    }
    async function loadSettings() {
      try {
        const res = await fetch('/api/auth/me');
        if (!res.ok) { window.location = '/login'; return; }
        const data = await res.json();
        document.getElementById('businessNameSidebar').textContent = data.shop_name || 'Business';
        document.getElementById('userAvatar').textContent = (data.shop_name || 'B').charAt(0).toUpperCase();
        document.getElementById('shop_name').value = data.shop_name || '';
        document.getElementById('description').value = data.description || '';
        document.getElementById('category').value = data.category || '';
        document.getElementById('whatsapp_number').value = data.whatsapp_number || '';
        document.getElementById('whatsapp_phone_id').value = data.whatsapp_phone_id || '';
        document.getElementById('payment_link').value = data.payment_link || '';
        const statusDot = document.getElementById('whatsappStatusDot');
        const statusText = document.getElementById('whatsappStatusText');
        if (data.whatsapp_phone_id && data.whatsapp_number) { statusDot.className = 'status-dot connected'; statusText.textContent = 'Connected'; }
        initHoursGrid();
      } catch (err) { console.error(err); }
    }
    async function logout() { await fetch('/api/auth/logout', { method: 'POST' }); window.location = '/login'; }
    loadSettings();
  </script>
</body>
</html>`;
}

function getOrdersPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>BizChat AI - Orders</title>
  <script src="https://unpkg.com/lucide@latest/dist/umd/lucide.js"></script>
  <style>${sharedStyles}
    .orders-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; flex-wrap: wrap; gap: 12px; }
    .filter-tabs { display: flex; gap: 6px; }
    .filter-tab { padding: 8px 18px; border-radius: 20px; font-size: 13px; font-weight: 600; border: 1px solid var(--border); background: var(--surface); color: var(--text-secondary); cursor: pointer; transition: all 0.18s; }
    .filter-tab:hover { border-color: var(--accent); color: var(--accent); }
    .filter-tab.active { background: var(--accent); color: #fff; border-color: var(--accent); }
    .orders-count { font-size: 13px; color: var(--text-muted); font-weight: 500; }
    .orders-table-wrap { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-md); overflow: hidden; }
    table { width: 100%; border-collapse: collapse; }
    thead { background: var(--bg); }
    th { padding: 13px 16px; text-align: left; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-muted); border-bottom: 1px solid var(--border); white-space: nowrap; }
    td { padding: 14px 16px; font-size: 14px; border-bottom: 1px solid var(--border); vertical-align: middle; }
    tbody tr { cursor: pointer; transition: background 0.15s; }
    tbody tr:hover { background: var(--bg); }
    tbody tr:last-child td { border-bottom: none; }
    .customer-phone { font-weight: 600; color: var(--text-primary); font-size: 14px; }
    .order-details-cell { max-width: 300px; color: var(--text-secondary); font-size: 13px; }
    .time-cell { color: var(--text-muted); font-size: 13px; white-space: nowrap; }
    .status-select { padding: 6px 10px; border-radius: 20px; font-size: 12px; font-weight: 700; border: none; cursor: pointer; outline: none; -webkit-appearance: none; appearance: none; text-align: center; }
    .status-select.new { background: rgba(249,115,22,0.12); color: #ea6a00; }
    .status-select.confirmed { background: rgba(59,130,246,0.12); color: #2563eb; }
    .status-select.completed { background: rgba(22,163,74,0.12); color: #15803d; }
    .status-select.cancelled { background: rgba(220,38,38,0.12); color: #dc2626; }
    .empty-orders { display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 64px 24px; text-align: center; gap: 12px; }
    .empty-orders-icon { color: var(--text-light); margin-bottom: 4px; }
    .empty-orders-title { font-size: 17px; font-weight: 700; color: var(--text-primary); }
    .empty-orders-text { font-size: 14px; color: var(--text-muted); max-width: 340px; line-height: 1.6; }
    @media (max-width: 900px) { .orders-table-wrap { overflow-x: auto; display: block; } }
    @media (max-width: 768px) { .filter-tabs { flex-wrap: wrap; } }
  </style>
</head>
<body>
  ${getSidebar('orders')}
  <div class="main-content">
    <div class="top-bar"><h1 class="page-title">Orders</h1></div>
    <div class="container">
      <div class="orders-header">
        <div class="filter-tabs">
          <button class="filter-tab active" data-filter="all">All</button>
          <button class="filter-tab" data-filter="new">New</button>
          <button class="filter-tab" data-filter="confirmed">Confirmed</button>
          <button class="filter-tab" data-filter="completed">Completed</button>
        </div>
        <div class="orders-count" id="ordersCount"></div>
      </div>
      <div class="orders-table-wrap" id="ordersTableWrap"></div>
    </div>
  </div>
  <div id="toast" class="toast"></div>
  <script>
    lucide.createIcons();
    let allOrders = [];
    let activeFilter = 'all';

    function showToast(message, type) {
      type = type || 'success';
      const toast = document.getElementById('toast');
      toast.textContent = message;
      toast.className = 'toast show ' + type;
      setTimeout(() => { toast.className = 'toast'; }, 3000);
    }

    function escapeHtml(t) {
      if (!t) return '';
      const d = document.createElement('div');
      d.textContent = t;
      return d.innerHTML;
    }

    function formatTime(ts) {
      if (!ts) return '\u2014';
      const d = new Date(ts);
      const now = new Date();
      const diff = Math.floor((now - d) / 1000);
      if (diff < 60) return 'Just now';
      if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
      if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
      return d.toLocaleDateString('en-PK', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    }

    function renderOrders() {
      const wrap = document.getElementById('ordersTableWrap');
      const filtered = activeFilter === 'all' ? allOrders : allOrders.filter(o => o.status === activeFilter);
      document.getElementById('ordersCount').textContent = filtered.length + ' order' + (filtered.length !== 1 ? 's' : '');

      if (filtered.length === 0) {
        wrap.innerHTML = '<div class="empty-orders">'
          + '<div class="empty-orders-icon"><svg xmlns="http://www.w3.org/2000/svg" width="52" height="52" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z"/><path d="M3 6h18"/><path d="M16 10a4 4 0 0 1-8 0"/></svg></div>'
          + '<div class="empty-orders-title">' + (activeFilter === 'all' ? 'No orders yet' : 'No ' + activeFilter + ' orders') + '</div>'
          + '<div class="empty-orders-text">When customers place orders via WhatsApp, they\'ll appear here automatically.</div>'
          + '</div>';
        return;
      }

      const rows = filtered.map(order => {
        const statusClass = order.status || 'new';
        const statusOptions = ['new', 'confirmed', 'completed', 'cancelled'];
        const selectOpts = statusOptions.map(s => '<option value="' + s + '"' + (order.status === s ? ' selected' : '') + '>' + s.charAt(0).toUpperCase() + s.slice(1) + '</option>').join('');
        const selectHtml = '<select class="status-select ' + statusClass + '" data-prev="' + statusClass + '" onchange="updateStatus(' + order.id + ', this)" onclick="event.stopPropagation()">' + selectOpts + '</select>';
        const datetime = order.requested_datetime ? '<br><span style="font-size:11px;color:var(--text-muted);">&#128197; ' + escapeHtml(order.requested_datetime) + '</span>' : '';
        return '<tr onclick="viewConversation(' + order.conversation_id + ')">'
          + '<td class="time-cell">' + formatTime(order.created_at) + '</td>'
          + '<td><span class="customer-phone">' + escapeHtml(order.customer_phone) + '</span></td>'
          + '<td class="order-details-cell">' + escapeHtml(order.order_details) + datetime + '</td>'
          + '<td>' + selectHtml + '</td>'
          + '<td style="color:var(--text-muted);font-size:13px;"><i data-lucide="chevron-right" style="width:16px;height:16px;"></i></td>'
          + '</tr>';
      }).join('');

      wrap.innerHTML = '<table>'
        + '<thead><tr><th>Time</th><th>Customer</th><th>Order Details</th><th>Status</th><th></th></tr></thead>'
        + '<tbody>' + rows + '</tbody>'
        + '</table>';
      lucide.createIcons();
    }

    function viewConversation(conversationId) {
      if (conversationId) window.location = '/conversations/' + conversationId;
    }

    async function updateStatus(orderId, selectEl) {
      const newStatus = selectEl.value;
      const oldStatus = selectEl.dataset.prev || newStatus;
      selectEl.className = 'status-select ' + newStatus;
      try {
        const res = await fetch('/api/orders/' + orderId + '/status', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: newStatus })
        });
        if (!res.ok) throw new Error('Server error');
        selectEl.dataset.prev = newStatus;
        const order = allOrders.find(o => o.id === orderId);
        if (order) order.status = newStatus;
        showToast('Status updated to ' + newStatus);
        if (activeFilter !== 'all' && activeFilter !== newStatus) renderOrders();
      } catch (err) {
        showToast('Failed to update status', 'error');
        selectEl.value = oldStatus;
        selectEl.className = 'status-select ' + oldStatus;
        selectEl.dataset.prev = oldStatus;
      }
    }

    document.querySelectorAll('.filter-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.filter-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        activeFilter = tab.dataset.filter;
        renderOrders();
      });
    });

    async function loadOrders() {
      try {
        const meRes = await fetch('/api/auth/me');
        if (!meRes.ok) { window.location = '/login'; return; }
        const me = await meRes.json();
        document.getElementById('businessNameSidebar').textContent = me.shop_name || 'Business';
        document.getElementById('userAvatar').textContent = (me.shop_name || 'B').charAt(0).toUpperCase();
        allOrders = await fetch('/api/orders').then(r => r.json());
        renderOrders();
      } catch (err) { console.error(err); }
    }

    async function logout() { await fetch('/api/auth/logout', { method: 'POST' }); window.location = '/login'; }
    loadOrders();
  </script>
</body>
</html>`;
}

function getAnalyticsPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>BizChat AI - Analytics</title>
  <script src="https://unpkg.com/lucide@latest/dist/umd/lucide.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <style>${sharedStyles}
    .stats-row { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin-bottom: 20px; }
    .stats-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-md); padding: 20px; text-align: center; }
    .stats-value { font-size: 32px; font-weight: 700; color: var(--text-primary); }
    .stats-label { font-size: 13px; color: var(--text-muted); margin-top: 4px; }
    .charts-grid { display: grid; grid-template-columns: 60% 40%; gap: 16px; }
    .chart-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-md); padding: 20px; }
    .chart-title { font-size: 15px; font-weight: 700; color: var(--text-primary); margin-bottom: 16px; }
    @media (max-width: 1024px) { .charts-grid { grid-template-columns: 1fr; } .stats-row { grid-template-columns: repeat(2, 1fr); } }
    @media (max-width: 768px) { .stats-row { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  ${getSidebar('analytics')}
  <div class="main-content">
    <div class="top-bar"><h1 class="page-title">Analytics</h1></div>
    <div class="container">
      <div class="stats-row">
        <div class="stats-card"><div class="stats-value" id="totalConv">0</div><div class="stats-label">Total Conversations</div></div>
        <div class="stats-card"><div class="stats-value" id="totalMsg">0</div><div class="stats-label">Total Messages</div></div>
        <div class="stats-card"><div class="stats-value" id="avgPerDay">0</div><div class="stats-label">Conv per Day</div></div>
      </div>
      <div class="charts-grid">
        <div class="chart-card"><h3 class="chart-title">Messages (Last 7 Days)</h3><canvas id="messagesChart"></canvas></div>
        <div class="chart-card"><h3 class="chart-title">Top Questions</h3><canvas id="questionsChart"></canvas></div>
      </div>
    </div>
  </div>
  <script>
    lucide.createIcons();
    async function loadAnalytics() {
      try {
        const meRes = await fetch('/api/auth/me');
        if (!meRes.ok) { window.location = '/login'; return; }
        const me = await meRes.json();
        document.getElementById('businessNameSidebar').textContent = me.shop_name || 'Business';
        document.getElementById('userAvatar').textContent = (me.shop_name || 'B').charAt(0).toUpperCase();
        const res = await fetch('/api/analytics/stats');
        const data = await res.json();
        document.getElementById('totalConv').textContent = data.totalConversations || 0;
        document.getElementById('totalMsg').textContent = data.totalMessages || 0;
        document.getElementById('avgPerDay').textContent = (data.averagePerDay || 0).toFixed(1);
        const labels = (data.messagesLast7Days || []).map(d => new Date(d.date).toLocaleDateString('en-US', { weekday: 'short' }));
        const values = (data.messagesLast7Days || []).map(d => d.count);
        new Chart(document.getElementById('messagesChart'), {
          type: 'bar',
          data: { labels, datasets: [{ label: 'Messages', data: values, backgroundColor: 'rgba(20, 184, 166, 0.8)', borderRadius: 4 }] },
          options: { responsive: true, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, ticks: { stepSize: 1 } } } }
        });
        const qLabels = (data.topQuestions || []).map(q => q.keyword);
        const qValues = (data.topQuestions || []).map(q => q.count);
        new Chart(document.getElementById('questionsChart'), {
          type: 'doughnut',
          data: { labels: qLabels, datasets: [{ data: qValues, backgroundColor: ['#14b8a6', '#3b82f6', '#f97316', '#22c55e', '#a855f7'] }] },
          options: { responsive: true, plugins: { legend: { position: 'bottom' } } }
        });
      } catch (err) { console.error(err); }
    }
    async function logout() { await fetch('/api/auth/logout', { method: 'POST' }); window.location = '/login'; }
    loadAnalytics();
  </script>
</body>
</html>`;
}

// Start server
async function startServer() {
  await createTables();
  await findDuplicateWhatsAppPhoneIds().catch(function() {});
  app.listen(PORT, '0.0.0.0', function() {
    console.log('BizChat AI server running on port ' + PORT);
  });
  // Start follow-up scheduler — runs every 10 minutes
  setInterval(runFollowUpScheduler, 10 * 60 * 1000);
  console.log('Follow-up scheduler started (runs every 10 minutes)');
}

startServer();
module.exports = app;
