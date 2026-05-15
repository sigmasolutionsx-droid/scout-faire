require('dotenv').config();
const express      = require('express');
const session      = require('express-session');
const passport     = require('passport');
const LocalStrategy = require('passport-local').Strategy;
const bcrypt       = require('bcryptjs');
const ConnectPg    = require('connect-pg-simple');
const { Pool }     = require('pg');
const Stripe       = require('stripe');
const path         = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Database ──────────────────────────────────────────────────────────────────
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      sid    VARCHAR PRIMARY KEY,
      sess   JSONB NOT NULL,
      expire TIMESTAMP NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_expire ON sessions(expire);

    CREATE TABLE IF NOT EXISTS users (
      id                      VARCHAR PRIMARY KEY,
      email                   VARCHAR UNIQUE NOT NULL,
      password_hash           VARCHAR,
      credits                 INTEGER NOT NULL DEFAULT 0,
      free_credits_used       INTEGER NOT NULL DEFAULT 0,
      free_credits_refreshed  TIMESTAMP DEFAULT NOW(),
      subscription_type       VARCHAR,
      subscription_expires    TIMESTAMP,
      created_at              TIMESTAMP DEFAULT NOW()
    );
  `);
  console.log('DB ready');
}

const FREE_CREDITS = 1;

async function getUser(id)           { const r = await pool.query('SELECT * FROM users WHERE id=$1', [id]); return r.rows[0]; }
async function getUserByEmail(email) { const r = await pool.query('SELECT * FROM users WHERE email=$1', [email.toLowerCase()]); return r.rows[0]; }

async function canUseCredit(userId) {
  const u = await getUser(userId);
  if (!u) return false;
  if (u.subscription_type && u.subscription_expires && new Date(u.subscription_expires) > new Date()) return true;
  const now  = new Date();
  const last = u.free_credits_refreshed ? new Date(u.free_credits_refreshed) : null;
  const newMonth = !last || now.getMonth() !== last.getMonth() || now.getFullYear() !== last.getFullYear();
  if (newMonth) {
    await pool.query('UPDATE users SET free_credits_used=1, free_credits_refreshed=NOW() WHERE id=$1', [userId]);
    return true;
  }
  if ((u.free_credits_used || 0) < FREE_CREDITS) {
    await pool.query('UPDATE users SET free_credits_used=free_credits_used+1 WHERE id=$1', [userId]);
    return true;
  }
  if ((u.credits || 0) > 0) {
    await pool.query('UPDATE users SET credits=credits-1 WHERE id=$1', [userId]);
    return true;
  }
  return false;
}

async function setSubscription(userId, type, expiresAt) {
  const r = await pool.query(
    'UPDATE users SET subscription_type=$1, subscription_expires=$2 WHERE id=$3 RETURNING *',
    [type, expiresAt, userId]
  );
  return r.rows[0];
}

// ── Session + Auth ────────────────────────────────────────────────────────────
const PgStore = ConnectPg(session);

app.set('trust proxy', 1);
app.use(session({
  store: new PgStore({ pool, createTableIfMissing: true, tableName: 'sessions', ttl: 7 * 24 * 3600 }),
  secret: process.env.SESSION_SECRET || 'scout-faire-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, secure: process.env.NODE_ENV === 'production', maxAge: 7 * 24 * 3600 * 1000 }
}));
app.use(passport.initialize());
app.use(passport.session());

passport.use(new LocalStrategy({ usernameField: 'email' }, async (email, password, done) => {
  try {
    const user = await getUserByEmail(email);
    if (!user || !user.password_hash) return done(null, false, { message: 'Invalid credentials' });
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return done(null, false, { message: 'Invalid credentials' });
    return done(null, { id: user.id, email: user.email });
  } catch (e) { return done(e); }
}));

passport.serializeUser((user, cb)   => cb(null, user));
passport.deserializeUser((user, cb) => cb(null, user));

const isAuthenticated = (req, res, next) => req.isAuthenticated() ? next() : res.status(401).json({ error: 'Unauthorized' });

// ── Body parsing + static ─────────────────────────────────────────────────────
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Auth Routes ───────────────────────────────────────────────────────────────
app.post('/api/register', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)    return res.status(400).json({ error: 'Email and password required' });
  if (password.length < 8)   return res.status(400).json({ error: 'Password must be at least 8 characters' });
  try {
    if (await getUserByEmail(email)) return res.status(409).json({ error: 'Email already registered' });
    const hash = await bcrypt.hash(password, 12);
    const id   = `user_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    await pool.query('INSERT INTO users (id, email, password_hash) VALUES ($1,$2,$3)', [id, email.toLowerCase(), hash]);
    req.login({ id, email: email.toLowerCase() }, err => {
      if (err) return res.status(500).json({ error: 'Login after register failed' });
      res.json({ success: true });
    });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Registration failed' }); }
});

app.post('/api/login', (req, res, next) => {
  passport.authenticate('local', (err, user, info) => {
    if (err)   return res.status(500).json({ error: 'Server error' });
    if (!user) return res.status(401).json({ error: info?.message || 'Invalid credentials' });
    req.login(user, err2 => {
      if (err2) return res.status(500).json({ error: 'Login failed' });
      res.json({ success: true });
    });
  })(req, res, next);
});

app.get('/api/logout', (req, res) => req.logout(() => res.redirect('/login.html')));

app.get('/api/auth/user', isAuthenticated, async (req, res) => {
  try {
    const u = await getUser(req.user.id);
    if (!u) return res.status(404).json({ error: 'User not found' });
    const now      = new Date();
    const last     = u.free_credits_refreshed ? new Date(u.free_credits_refreshed) : null;
    const newMonth = !last || now.getMonth() !== last.getMonth() || now.getFullYear() !== last.getFullYear();
    const freeLeft = newMonth ? FREE_CREDITS : Math.max(0, FREE_CREDITS - (u.free_credits_used || 0));
    const hasSub   = u.subscription_type && u.subscription_expires && new Date(u.subscription_expires) > now;
    const tier     = hasSub ? u.subscription_type : 'free';
    const limits   = TIER_LIMITS[tier] || TIER_LIMITS.free;
    res.json({
      id: u.id, email: u.email,
      credits: u.credits || 0,
      freeCreditsRemaining: freeLeft,
      subscriptionType:    hasSub ? u.subscription_type : null,
      isPro:               hasSub && u.subscription_type === 'pro',
      isGoldenTicket:      hasSub && u.subscription_type === 'golden_ticket',
      isMonthlyMarketPack: hasSub && u.subscription_type === 'monthly_market_pack',
      isEnterprise:        hasSub && u.subscription_type === 'enterprise',
      seats:               limits.seats,
      activeNiches:        limits.activeNiches,
      hasMonthlyPack:      limits.hasMonthlyPack,
      hasEom:              limits.hasEom,
      hasWordPress:        limits.hasWordPress,
      hasSocialPack:       limits.hasSocialPack,
      hasTraining:         limits.hasTraining,
      hasHosting:          limits.hasHosting
    });
  } catch (e) { res.status(500).json({ error: 'Failed to fetch user' }); }
});

// ── Stripe ────────────────────────────────────────────────────────────────────
const PRICING = {
  pro:                 { name: 'Scout-Faire Pro',                    price: 1999,   mode: 'subscription', interval: 'month' },
  golden_ticket:       { name: 'Scout-Faire Golden Ticket',          price: 3700,   mode: 'payment',      credits: 3 },
  monthly_market_pack: { name: 'Scout-Faire Scout Monthly',          price: 7400,   mode: 'subscription', interval: 'month' },
  enterprise:          { name: 'Scout-Faire Enterprise',             price: 119988, mode: 'subscription', interval: 'year'  },
  founders_pack:       { name: 'Scout-Faire Founders Pack',          price: 4998,   mode: 'subscription', interval: 'month' },
  enterprise_annual:   { name: 'Scout-Faire Enterprise Annual',      price: 79700,  mode: 'subscription', interval: 'year'  }
};
const PRICE_IDS = {
  pro:                 process.env.STRIPE_PRICE_PRO                 || null,
  golden_ticket:       process.env.STRIPE_PRICE_GOLDEN_TICKET       || null,
  monthly_market_pack: process.env.STRIPE_PRICE_MONTHLY_MARKET_PACK || null,
  enterprise:          process.env.STRIPE_PRICE_ENTERPRISE          || null,
  founders_pack:       process.env.STRIPE_PRICE_FOUNDERS_PACK       || null,
  enterprise_annual:   process.env.STRIPE_PRICE_ENTERPRISE_ANNUAL   || null
};
// What each tier unlocks — checked by /api/auth/user and the frontend
const TIER_LIMITS = {
  free:                { seats: 1, activeNiches: 1,  hasMonthlyPack: false, hasEom: false, hasWordPress: false, hasSocialPack: false, hasTraining: false, hasHosting: false },
  pro:                 { seats: 1, activeNiches: 3,  hasMonthlyPack: false, hasEom: false, hasWordPress: false, hasSocialPack: false, hasTraining: false, hasHosting: false },
  golden_ticket:       { seats: 1, activeNiches: 1,  hasMonthlyPack: false, hasEom: true,  hasWordPress: true,  hasSocialPack: false, hasTraining: true,  hasHosting: true  },
  monthly_market_pack: { seats: 1, activeNiches: 5,  hasMonthlyPack: true,  hasEom: false, hasWordPress: false, hasSocialPack: true,  hasTraining: false, hasHosting: false },
  enterprise:          { seats: 3, activeNiches: 10, hasMonthlyPack: true,  hasEom: true,  hasWordPress: true,  hasSocialPack: true,  hasTraining: true,  hasHosting: true  },
  founders_pack:       { seats: 2, activeNiches: 5,  hasMonthlyPack: true,  hasEom: true,  hasWordPress: true,  hasSocialPack: true,  hasTraining: true,  hasHosting: true,  isFounder: true },
  enterprise_annual:   { seats: 3, activeNiches: 10, hasMonthlyPack: true,  hasEom: true,  hasWordPress: true,  hasSocialPack: true,  hasTraining: true,  hasHosting: true,  isFounder: true }
};
const verified  = new Set();

app.post('/api/create-checkout-session', async (req, res) => {
  try {
    const { tier } = req.body;
    if (!PRICING[tier]) return res.status(400).json({ error: 'Invalid tier' });
    const stripe    = new Stripe(process.env.STRIPE_SECRET_KEY);
    const base      = process.env.APP_URL || `https://${req.hostname}`;
    const userId    = req.user?.id || 'guest';
    const pid       = PRICE_IDS[tier];
    const p         = PRICING[tier];
    const isOneTime = p.mode === 'payment';
    let cfg;
    if (pid) {
      cfg = { mode: p.mode, line_items: [{ price: pid, quantity: 1 }] };
    } else {
      const priceData = isOneTime
        ? { currency: 'usd', product_data: { name: p.name }, unit_amount: p.price }
        : { currency: 'usd', product_data: { name: p.name }, unit_amount: p.price, recurring: { interval: p.interval || 'month' } };
      cfg = { mode: p.mode, line_items: [{ price_data: priceData, quantity: 1 }] };
    }
    cfg.success_url = `${base}/success.html?session_id={CHECKOUT_SESSION_ID}&tier=${tier}`;
    cfg.cancel_url  = `${base}/pricing.html`;
    cfg.metadata    = { tier, userId };
    const s = await stripe.checkout.sessions.create(cfg);
    res.json({ url: s.url });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Checkout failed' }); }
});

app.post('/api/verify-session', async (req, res) => {
  try {
    const { sessionId } = req.body;
    if (!sessionId)           return res.status(400).json({ error: 'Session ID required' });
    if (verified.has(sessionId)) return res.status(400).json({ error: 'Already verified' });
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const s      = await stripe.checkout.sessions.retrieve(sessionId);
    if (s.payment_status !== 'paid') return res.status(400).json({ error: 'Payment not completed' });
    verified.add(sessionId);
    const tier  = s.metadata?.tier || 'pro';
    const p     = PRICING[tier] || PRICING.pro;
    const email = s.customer_details?.email || s.customer_email;
    let uid     = req.user?.id || s.metadata?.userId;
    if (!uid || uid === 'guest') {
      if (!email) return res.status(400).json({ error: 'No email found' });
      const existing = await getUserByEmail(email);
      uid = existing ? existing.id : `email_${email.toLowerCase().replace(/[^a-z0-9]/g, '_')}`;
      if (!existing) await pool.query('INSERT INTO users (id,email) VALUES ($1,$2) ON CONFLICT DO NOTHING', [uid, email.toLowerCase()]);
    }
    // Golden Ticket is one-time: add credits, no subscription
    if (p.mode === 'payment') {
      const creditsToAdd = p.credits || 1;
      await pool.query('UPDATE users SET credits = COALESCE(credits,0) + $1 WHERE id=$2', [creditsToAdd, uid]);
      const u2 = await getUser(uid);
      return res.json({ verified: true, tier, email, creditsAdded: creditsToAdd, credits: u2?.credits || 0 });
    }
    // Recurring subscriptions — expiry matches billing interval
    const exp = new Date();
    if (p.interval === 'year') exp.setFullYear(exp.getFullYear() + 1);
    else exp.setMonth(exp.getMonth() + 1);
    const u   = await setSubscription(uid, tier, exp);
    res.json({ verified: true, tier, email, subscriptionType: u?.subscription_type });
  } catch (e) { console.error(e); res.status(400).json({ error: 'Verification failed' }); }
});

// ── Multi-Provider LLM Engine ─────────────────────────────────────────────────
//
// Priority order (all driven by .env — nothing is hardcoded):
//   1. Groq        — primary, 4 rotating keys × N models
//   2. OpenRouter  — fallback (free/cheap models only — Hermes 405B etc.)
//
// COST POLICY: OpenAI and Anthropic are intentionally disabled by default.
// At $19.99/mo unlimited, GPT-4o or Claude Sonnet would cost more per report
// than the subscription price. Only enable them if you add per-report credits
// or move to a higher tier. Use OpenRouter free-tier models as the safety net.
//
// .env variables:
//
//   # Groq — primary (rotate across 4 keys to avoid rate limits)
//   GROQ_API_KEY=gsk_...
//   GROQ_API_KEY_II=gsk_...
//   GROQ_API_KEY_III=gsk_...
//   GROQ_API_KEY_IV=gsk_...
//   GROQ_MODEL=openai/gpt-oss-120b              ← your preferred model
//   GROQ_FALLBACK_MODELS=llama-3.1-8b-instant,gemma2-9b-it   ← cheap groq fallbacks
//
//   # OpenRouter — cost-effective fallback (confirmed free model IDs)
//   OPENROUTER_API_KEY=sk-or-...
//   OPENROUTER_MODEL=meta-llama/llama-3.3-70b-instruct:free
//   OPENROUTER_FALLBACK_MODELS=mistralai/mistral-7b-instruct:free,google/gemma-3-27b-it:free
//
//   # OpenAI — disabled by default (too expensive for flat-rate plans)
//   # OPENAI_API_KEY=sk-...
//   # OPENAI_MODEL=gpt-4o-mini                  ← only enable with mini if needed
//
//   # Anthropic — disabled by default (too expensive for flat-rate plans)
//   # ANTHROPIC_API_KEY=sk-ant-...
//   # ANTHROPIC_MODEL=claude-haiku-4-5-20251001 ← only enable with Haiku if needed

const GROQ_KEYS            = [process.env.GROQ_API_KEY, process.env.GROQ_API_KEY_II, process.env.GROQ_API_KEY_III, process.env.GROQ_API_KEY_IV].filter(Boolean);
const GROQ_MODEL           = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';
const GROQ_FALLBACK_MODELS = (process.env.GROQ_FALLBACK_MODELS || 'openai/gpt-oss-20b,qwen/qwen3-32b').split(',').filter(Boolean);

// OpenAI — opt-in only; commented out in .env by default
const OPENAI_KEY             = process.env.OPENAI_API_KEY || null;
const OPENAI_MODEL           = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const OPENAI_FALLBACK_MODELS = (process.env.OPENAI_FALLBACK_MODELS || '').split(',').filter(Boolean);

// Anthropic — opt-in only; commented out in .env by default
const ANTHROPIC_KEY             = process.env.ANTHROPIC_API_KEY || null;
const ANTHROPIC_MODEL           = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';
const ANTHROPIC_FALLBACK_MODELS = (process.env.ANTHROPIC_FALLBACK_MODELS || '').split(',').filter(Boolean);

// OpenRouter — cost-effective fallback; use confirmed valid free model IDs
const OPENROUTER_KEY             = process.env.OPENROUTER_API_KEY || null;
const OPENROUTER_MODEL           = process.env.OPENROUTER_MODEL || 'meta-llama/llama-3.3-70b-instruct:free';
const OPENROUTER_FALLBACK_MODELS = (process.env.OPENROUTER_FALLBACK_MODELS || 'mistralai/mistral-7b-instruct:free,google/gemma-3-27b-it:free').split(',').filter(Boolean);

// ── Per-model output token caps (Groq hard limits) ────────────────────────────
// If a model isn't listed here the passed-in maxTokens is used as-is.
const GROQ_MODEL_MAX_TOKENS = {
  'openai/gpt-oss-120b':                        65536,
  'openai/gpt-oss-20b':                         65536,
  'qwen/qwen3-32b':                             40960,
  'meta-llama/llama-4-scout-17b-16e-instruct':  8192,
  'llama-3.3-70b-versatile':                    32768,
  'llama-3.1-8b-instant':                       131072,
  'gemma2-9b-it':                               8192,
};

// ── Groq free-tier TPM limit is 8,000 per org ─────────────────────────────────
// When the combined prompt exceeds ~6,000 tokens we trim the user prompt so
// that input + output fits within the window. This is a best-effort trim —
// the model will still produce the best report it can with what it receives.
const GROQ_TPM_SAFE_INPUT = 5500; // leave headroom for output

function trimPromptToFit(systemPrompt, userPrompt, maxInputTokens) {
  // Rough token estimate: 1 token ≈ 4 chars
  const systemTokens = Math.ceil(systemPrompt.length / 4);
  const budget       = maxInputTokens - systemTokens - 200; // safety buffer
  if (budget <= 0) return userPrompt;
  const charBudget   = budget * 4;
  if (userPrompt.length <= charBudget) return userPrompt;
  console.warn(`[LLM] Trimming prompt from ${userPrompt.length} to ${charBudget} chars to fit TPM limit`);
  return userPrompt.slice(0, charBudget) + '\n\n[Note: prompt trimmed to fit token limit — complete the JSON schema as fully as possible]';
}

// ── Provider call functions ───────────────────────────────────────────────────

async function callGroq(key, model, systemPrompt, userPrompt, maxTokens, temperature) {
  // Cap output tokens to what this model actually supports
  const modelCap    = GROQ_MODEL_MAX_TOKENS[model] || maxTokens;
  const cappedTokens = Math.min(maxTokens, modelCap);
  // Trim input prompt if needed to stay under free-tier TPM
  const safePrompt  = trimPromptToFit(systemPrompt, userPrompt, GROQ_TPM_SAFE_INPUT);
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
    body: JSON.stringify({
      model, max_completion_tokens: cappedTokens, temperature,
      response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: safePrompt }]
    })
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error(`Groq ${r.status}: ${err?.error?.message || r.statusText}`);
  }
  const data = await r.json();
  return data.choices?.[0]?.message?.content || '';
}

async function callOpenAI(model, systemPrompt, userPrompt, maxTokens, temperature) {
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_KEY}` },
    body: JSON.stringify({
      model, max_tokens: maxTokens, temperature,
      response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }]
    })
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error(`OpenAI ${r.status}: ${err?.error?.message || r.statusText}`);
  }
  const data = await r.json();
  return data.choices?.[0]?.message?.content || '';
}

async function callAnthropic(model, systemPrompt, userPrompt, maxTokens, temperature) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model, max_tokens: maxTokens, temperature,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }]
    })
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error(`Anthropic ${r.status}: ${err?.error?.message || r.statusText}`);
  }
  const data = await r.json();
  return data.content?.[0]?.text || '';
}

async function callOpenRouter(model, systemPrompt, userPrompt, maxTokens, temperature) {
  const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENROUTER_KEY}`,
      'HTTP-Referer': process.env.APP_URL || 'https://scout-faire.com',
      'X-Title': 'Scout-Faire'
    },
    body: JSON.stringify({
      model, max_tokens: maxTokens, temperature,
      response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }]
    })
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error(`OpenRouter ${r.status}: ${err?.error?.message || r.statusText}`);
  }
  const data = await r.json();
  return data.choices?.[0]?.message?.content || '';
}

// ── Master LLM dispatcher ─────────────────────────────────────────────────────
// Tries every configured provider in priority order.
// Returns the raw text response from the first provider that succeeds.

async function callLLM(systemPrompt, userPrompt, maxTokens = 32000, temperature = 0.35) {
  const errors = [];

  // 1. Groq — try every key × every model
  for (const key of GROQ_KEYS) {
    for (const model of [GROQ_MODEL, ...GROQ_FALLBACK_MODELS]) {
      try {
        console.log(`[LLM] Trying Groq model=${model} key=...${key.slice(-4)}`);
        const text = await callGroq(key, model, systemPrompt, userPrompt, maxTokens, temperature);
        console.log(`[LLM] Groq success model=${model}`);
        return text;
      } catch (e) {
        console.warn(`[LLM] Groq failed model=${model} key=...${key.slice(-4)}: ${e.message}`);
        errors.push(`Groq/${model}: ${e.message}`);
      }
    }
  }

  // 2. OpenAI
  if (OPENAI_KEY) {
    for (const model of [OPENAI_MODEL, ...OPENAI_FALLBACK_MODELS]) {
      try {
        console.log(`[LLM] Trying OpenAI model=${model}`);
        const text = await callOpenAI(model, systemPrompt, userPrompt, maxTokens, temperature);
        console.log(`[LLM] OpenAI success model=${model}`);
        return text;
      } catch (e) {
        console.warn(`[LLM] OpenAI failed model=${model}: ${e.message}`);
        errors.push(`OpenAI/${model}: ${e.message}`);
      }
    }
  }

  // 3. Anthropic
  if (ANTHROPIC_KEY) {
    for (const model of [ANTHROPIC_MODEL, ...ANTHROPIC_FALLBACK_MODELS]) {
      try {
        console.log(`[LLM] Trying Anthropic model=${model}`);
        const text = await callAnthropic(model, systemPrompt, userPrompt, maxTokens, temperature);
        console.log(`[LLM] Anthropic success model=${model}`);
        return text;
      } catch (e) {
        console.warn(`[LLM] Anthropic failed model=${model}: ${e.message}`);
        errors.push(`Anthropic/${model}: ${e.message}`);
      }
    }
  }

  // 4. OpenRouter
  if (OPENROUTER_KEY) {
    for (const model of [OPENROUTER_MODEL, ...OPENROUTER_FALLBACK_MODELS]) {
      try {
        console.log(`[LLM] Trying OpenRouter model=${model}`);
        const text = await callOpenRouter(model, systemPrompt, userPrompt, maxTokens, temperature);
        console.log(`[LLM] OpenRouter success model=${model}`);
        return text;
      } catch (e) {
        console.warn(`[LLM] OpenRouter failed model=${model}: ${e.message}`);
        errors.push(`OpenRouter/${model}: ${e.message}`);
      }
    }
  }

  throw new Error(`All LLM providers exhausted.\n${errors.join('\n')}`);
}

// Keep FALLBACK_MODELS alias so nothing downstream breaks
const FALLBACK_MODELS = GROQ_FALLBACK_MODELS;

// ── Normalize report output to match frontend field expectations ──────────────
function normalizeForFrontend(report, nicheStr) {
  const arr = (v) => Array.isArray(v) ? v : [];
  const str = (v) => (v && typeof v === 'string') ? v : '';
  const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};

  const nd  = obj(report.nicheDefinition);
  const pfg = obj(report.profitFromGaps);
  const mp  = obj(pfg.moneyPath);
  const tdp = obj(report.thirtyDayPlan);
  const bca = obj(report.buyerAndCompetitorAnalysis);

  // Build recommendations from competitorGaps
  const gaps = arr(report.competitorGaps);
  const recommendations = gaps.length
    ? gaps.map(g => `${str(g.competitor)}: ${str(g.whatTheyMiss)}`).filter(Boolean)
    : arr(bca.competitorGaps).map(g => typeof g === 'string' ? g : str(g.gap)).filter(Boolean);

  // Build niches array
  const niches = arr(report.niches).map(n => ({
    keyword:         str(n.keyword) || nicheStr,
    niche:           str(n.keyword) || nicheStr,
    profitability:   Number(n.opportunityScore || n.profitability || n.score || 7),
    score:           Number(n.opportunityScore || n.profitability || n.score || 7),
    trend:           str(n.trend)        || 'stable',
    competition:     str(n.competition) || 'medium',
    buyIntent:       str(n.buyIntent)   || 'medium',
    searchVolume:    str(n.searchVolume) || 'medium',
    confidence:      str(n.confidence)  || 'Medium',
    recommendations,
    opportunity:     str(mp.firstDollar) || str(pfg.positioningStatement) || '',
    riskFlags:       arr(n.riskFlags),
    kpis:            arr(n.kpis),
    // New structured fields for enhanced card rendering
    nicheDefinition:  nd,
    competitorGaps:   gaps,
    biggestGap:       str(report.biggestGap),
    profitFromGaps:   pfg,
    thirtyDayPlan:    tdp,
    socialMedia:      obj(report.socialMediaPackage),
    contentAngles:    arr(report.contentAngles),
    leadMagnet:       obj(report.leadMagnet),
    buyerPain:        str(report.buyerPain),
    strategicWarnings: arr(report.strategicWarnings)
  }));

  if (!niches.length) {
    niches.push({
      keyword: nicheStr, niche: nicheStr,
      profitability: 7, score: 7,
      trend: 'stable', competition: 'medium', buyIntent: 'medium', searchVolume: 'medium',
      confidence: 'Medium', recommendations, opportunity: '',
      riskFlags: [], kpis: [],
      nicheDefinition: nd, competitorGaps: gaps, biggestGap: str(report.biggestGap),
      profitFromGaps: pfg, thirtyDayPlan: tdp,
      socialMedia: obj(report.socialMediaPackage),
      contentAngles: arr(report.contentAngles),
      leadMagnet: obj(report.leadMagnet),
      buyerPain: str(report.buyerPain),
      strategicWarnings: arr(report.strategicWarnings)
    });
  }

  return { ...report, niches };
}
// Use this for any task with a small, predictable output — keyword cleaning,
// classification, validation, formatting. Never use it for full reports.
// Falls back to gpt-oss-20b on Groq if the 8B is rate-limited, then gives up
// (does NOT fall through to OpenRouter — small tasks aren't worth it).
const SMALL_MODEL = 'llama-3.1-8b-instant';

async function callSmallLLM(systemPrompt, userPrompt, maxTokens = 120, temperature = 0.1) {
  for (const key of GROQ_KEYS) {
    try {
      const text = await callGroq(key, SMALL_MODEL, systemPrompt, userPrompt, maxTokens, temperature);
      return text;
    } catch (e) {
      console.warn(`[SmallLLM] llama-3.1-8b key=...${key.slice(-4)} failed: ${e.message}`);
    }
  }
  // Soft fallback to gpt-oss-20b on Groq — still cheap, still fast
  for (const key of GROQ_KEYS) {
    try {
      const text = await callGroq(key, 'openai/gpt-oss-20b', systemPrompt, userPrompt, maxTokens, temperature);
      return text;
    } catch (e) {
      console.warn(`[SmallLLM] gpt-oss-20b fallback key=...${key.slice(-4)} failed: ${e.message}`);
    }
  }
  throw new Error('Small LLM unavailable');
}

function extractJson(text) {
  if (!text) throw new Error('Empty response');
  const c = text.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  try { return JSON.parse(c); } catch (_) {}
  const f = c.indexOf('{'), l = c.lastIndexOf('}');
  if (f === -1 || l <= f) throw new Error('No JSON found');
  return JSON.parse(c.slice(f, l + 1));
}

// extractNiche — uses the 8B exclusively; gracefully returns raw input on failure
async function extractNiche(rawInput) {
  try {
    const text = await callSmallLLM(
      'Extract a clean 3-7 word niche phrase from the user input. Return ONLY valid JSON: {"niche": "your phrase here"}. Examples: {"niche": "HOA management software for property managers"}',
      rawInput,
      120,
      0.1
    );
    const parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
    const cleaned = parsed?.niche?.trim();
    if (cleaned && cleaned.length < 200) {
      console.log(`[extractNiche] "${rawInput.slice(0, 60)}" → "${cleaned}"`);
      return cleaned;
    }
    return rawInput;
  } catch (_) { return rawInput; }
}

function normalizeReport(report, kw, cleanedNiche) {
  const niches = Array.isArray(report.niches) ? report.niches : [];
  const arr    = (v) => Array.isArray(v) ? v : [];
  const str    = (v) => (v && typeof v === 'string') ? v : '';
  const obj    = (v) => (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
  const hi     = obj(report.honestInsight);
  const bca    = obj(report.buyerAndCompetitorAnalysis);
  const omp    = obj(report.offerAndMoneyPath);
  const csp    = obj(report.contentSalesAndPlan);
  const nsl    = obj(report.nextStepAndLaunchPackage);
  return {
    reportTitle:  'SCOUT-FAIRE ENTERPRISE STRATEGIC MARKET BLUEPRINT',
    generatedFor: kw.join(', '),
    cleanedNiche: cleanedNiche || kw.join(', '),
    // Section 1 — Honest Insight (always first)
    honestInsight: {
      verdict:          str(hi.verdict)          || 'TEST FIRST',
      plainEnglishRead: str(hi.plainEnglishRead),
      theGood:          str(hi.theGood),
      theBad:           str(hi.theBad),
      theMoney:         str(hi.theMoney),
      theTrap:          str(hi.theTrap),
      myCall:           str(hi.myCall)
    },
    // Section 2 — Operator Verdict
    operatorVerdict:   str(report.operatorVerdict),
    // Section 3 — Should You Pursue This?
    shouldYouPursue:   str(report.shouldYouPursue),
    // Section 4 — Why / Why Not
    whyOrWhyNot:       str(report.whyOrWhyNot),
    // Section 5 — Best Money Angle
    bestMoneyAngle:    str(report.bestMoneyAngle),
    // Section 6 — What I Would Do First (Days 1–15, one entry per day)
    whatIWouldDoFirst: arr(report.whatIWouldDoFirst),
    // Section 7 — Executive Summary
    executiveSummary:  str(report.executiveSummary),
    // Section 8 — Market Reality Check
    marketRealityCheck: str(report.marketRealityCheck),
    // Section 8b — Niche Intelligence (Enterprise deep-dive)
    nicheIntelligence: (() => {
      const ni = obj(report.nicheIntelligence);
      return {
        marketDynamics:            str(ni.marketDynamics),
        demandSignals:             str(ni.demandSignals),
        seasonality:               str(ni.seasonality),
        buyerPsychology:           str(ni.buyerPsychology),
        pricingCeiling:            str(ni.pricingCeiling),
        underservedSubSegments:    arr(ni.underservedSubSegments),
        platformOpportunities:     arr(ni.platformOpportunities),
        monetizationModelsRanked:  arr(ni.monetizationModelsRanked),
        fastestWedge:              str(ni.fastestWedge)
      };
    })(),
    // Section 9 — Buyer + Competitor Analysis
    buyerAndCompetitorAnalysis: {
      buyerProfile:   str(bca.buyerProfile),
      buyerPain:      str(bca.buyerPain),
      topCompetitors: arr(bca.topCompetitors),
      competitorGaps: arr(bca.competitorGaps)
    },
    // Section 10 — Offer + Money Path
    offerAndMoneyPath: {
      coreOffer:       str(omp.coreOffer),
      offerStack:      arr(omp.offerStack),
      pricingStrategy: str(omp.pricingStrategy),
      moneyPath:       str(omp.moneyPath)
    },
    // Section 11 — Content / Sales
    contentSalesAndPlan: {
      contentAngles: arr(csp.contentAngles),
      salesTactics:  arr(csp.salesTactics)
    },
    // Section 11b — 30-Day Market Attack Plan
    thirtyDayMarketAttackPlan: (() => {
      const p = obj(report.thirtyDayMarketAttackPlan);
      const wk = (w) => {
        const x = obj(w);
        return { objective: str(x.objective), actions: arr(x.actions), assetsToCreate: arr(x.assetsToCreate), whoToContact: str(x.whoToContact), whatToMeasure: str(x.whatToMeasure), weekendDecision: str(x.weekendDecision) };
      };
      return { monthGoal: str(p.monthGoal), week1: wk(p.week1), week2: wk(p.week2), week3: wk(p.week3), week4: wk(p.week4) };
    })(),
    // Section 12 — Monthly Milestones (7 categories + weekly checkpoints)
    monthlyMilestones: (() => {
      const m = obj(report.monthlyMilestones);
      return {
        monthGoal:          str(m.monthGoal),
        setupMilestones:    arr(m.setupMilestones),
        leadGenMilestones:  arr(m.leadGenMilestones),
        salesMilestones:    arr(m.salesMilestones),
        contentMilestones:  arr(m.contentMilestones),
        partnerMilestones:  arr(m.partnerMilestones),
        learningMilestones: arr(m.learningMilestones),
        endOfMonthDecision: str(m.endOfMonthDecision),
        week1Milestones:    arr(m.week1Milestones),
        week2Milestones:    arr(m.week2Milestones),
        week3Milestones:    arr(m.week3Milestones),
        week4Milestones:    arr(m.week4Milestones)
      };
    })(),
    // Monthly Scorecard
    monthlyScorecard: (() => {
      const sc = obj(report.monthlyScorecard);
      const s  = (k) => str(sc[k]);
      return {
        offerClarity:         s('offerClarity'),
        leadMagnetCompletion: s('leadMagnetCompletion'),
        contentPublished:     s('contentPublished'),
        outreachCompleted:    s('outreachCompleted'),
        partnerCampaign:      s('partnerCampaign'),
        leadsGenerated:       s('leadsGenerated'),
        salesConversations:   s('salesConversations'),
        paidConversions:      s('paidConversions'),
        objectionsCollected:  s('objectionsCollected'),
        nextDecisionMade:     s('nextDecisionMade')
      };
    })(),
    // Section 13 — Next Step / Launch Package
    nextStepAndLaunchPackage: {
      immediateNextStep: str(nsl.immediateNextStep),
      launchChecklist:   arr(nsl.launchChecklist)
    },
    // Content Assets (What I Would Do + Article + Example)
    contentAssets: (() => {
      const ca = obj(report.contentAssets);
      const fa = obj(ca.fullArticleAsset);
      return {
        operatorFirstMove: str(ca.operatorFirstMove),
        briefExample:      str(ca.briefExample),
        articleAngles: arr(ca.articleAngles).map(a => {
          const x = obj(a);
          return { title: str(x.title), targetReader: str(x.targetReader), buyerPain: str(x.buyerPain), businessPurpose: str(x.businessPurpose), cta: str(x.cta) };
        }),
        fullArticleAsset: { title: str(fa.title), body: str(fa.body) }
      };
    })(),
    strategicWarnings: arr(report.strategicWarnings),
    niches: niches.map((n, i) => ({
      keyword:             str(n.keyword)      || kw[i] || `Niche ${i + 1}`,
      opportunityScore:    Number(n.opportunityScore ?? n.profitability ?? 0),
      confidence:          str(n.confidence)   || 'Medium',
      trend:               str(n.trend)        || 'stable',
      competition:         str(n.competition)  || 'medium',
      buyIntent:           str(n.buyIntent)    || 'medium',
      gapMonetizationPlan: arr(n.gapMonetizationPlan),
      riskFlags:           arr(n.riskFlags),
      kpis:                arr(n.kpis)
    }))
  };
}

// ════════════════════════════════════════════════════════════════════════════
// SPLIT PROMPT BUILDERS — 3 focused calls, each ~3,000 tokens output max
// Call 1: Niche Definition + Competitor Gaps
// Call 2: How to Profit from the Gaps (offers, money path, positioning)
// Call 3: 30-Day Week-by-Week Plan + Daily Habits
// ════════════════════════════════════════════════════════════════════════════

const SYSTEM_PROMPT = 'You are Scout-Faire. Return only strict JSON matching the requested schema. Never add markdown or backticks.';

// ── CALL 1: Niche Definition + Competitor Gaps ────────────────────────────────
const buildCall1 = (kw, tier) => `You are the lead strategist for Scout-Faire ${tier === 'enterprise' ? 'Enterprise' : 'Monthly'}.

Analyze this niche: ${kw}

RULES: No invented statistics. Name real competitors with real prices. Be specific and direct.

Return ONLY valid JSON:
{
  "nicheDefinition": {
    "whatItIs": "2-3 sentences defining exactly what this niche is, who the buyers are, and why the market exists.",
    "whoIsInIt": "The specific type of person or business that buys in this niche. Role, situation, budget range.",
    "whyItExists": "The core problem or desire that created this market. Be specific.",
    "marketSize": "Honest assessment of how large this market is. Use (unverified estimate) for any numbers.",
    "verdict": "PURSUE | TEST FIRST | WATCH | AVOID | NEEDS LOCAL VALIDATION",
    "verdictReason": "2-3 sentences explaining the verdict in plain language."
  },
  "competitorGaps": [
    {
      "competitor": "Real competitor name",
      "whatTheyDo": "What they offer and at what price",
      "whatTheyMiss": "The specific gap they leave open",
      "whyUnfilled": "Why no one has filled this gap yet",
      "gapSize": "How big this opportunity is — small/medium/large",
      "urgency": "How urgently buyers feel this gap"
    },
    { "competitor": "Competitor 2", "whatTheyDo": "...", "whatTheyMiss": "...", "whyUnfilled": "...", "gapSize": "...", "urgency": "..." },
    { "competitor": "Competitor 3", "whatTheyDo": "...", "whatTheyMiss": "...", "whyUnfilled": "...", "gapSize": "...", "urgency": "..." }
  ],
  "biggestGap": "The single most important gap across all competitors — the one worth building a business around.",
  "buyerPain": "What keeps buyers in this niche up at night. The real emotional and operational pain.",
  "strategicWarnings": ["Specific risk 1", "Risk 2", "Risk 3"],
  "niches": [{
    "keyword": "exact keyword analyzed",
    "opportunityScore": 75,
    "confidence": "High | Medium | Low",
    "trend": "rising | stable | declining",
    "competition": "low | medium | high",
    "buyIntent": "high | medium | low",
    "searchVolume": "high | medium | low",
    "riskFlags": ["Risk 1", "Risk 2"],
    "kpis": ["KPI 1 with number", "KPI 2"]
  }]
}`;

// ── CALL 2: How to Profit from the Gaps ──────────────────────────────────────
const buildCall2 = (kw, tier) => `You are the lead strategist for Scout-Faire ${tier === 'enterprise' ? 'Enterprise' : 'Monthly'}.

Define exactly how to profit from the competitor gaps in this niche: ${kw}

RULES: Every offer must answer WHO buys, WHAT problem it solves, WHY they pay now, HOW they find you, WHAT closes them, HOW MUCH they pay. No banned phrases: "provide value", "go viral", "leverage social media".

Return ONLY valid JSON:
{
  "profitFromGaps": {
    "primaryOffer": {
      "name": "Give the offer a specific name",
      "whatItIs": "Exactly what the buyer gets — list every component",
      "whoBuysIt": "Exact buyer description — role, situation, trigger",
      "price": "$XXX — explain why this price, not lower or higher",
      "howTheyFindYou": "The specific channel and message that reaches them",
      "whatClosesthem": "The exact argument or proof that converts them",
      "timeToFirstSale": "Realistic days to first paying customer"
    },
    "offerStack": [
      "Entry offer — $XX — what it is — who it's for",
      "Core offer — $XXX — what it is — who it's for",
      "Premium offer — $XXXX — what it is — who it's for",
      "Recurring model — $XX/mo — what keeps them paying"
    ],
    "moneyPath": {
      "firstDollar": "Exactly how to get the first paying customer. Name the action, the target, and the message.",
      "firstThousand": "Exactly how to reach $1,000/mo. Name the number of customers, the offer, and the channel.",
      "firstFiveThousand": "Exactly how to reach $5,000/mo. Name what changes — more customers, higher price, or new offer."
    },
    "positioningStatement": "One sentence that explains who you serve, what gap you fill, and why you're different from every competitor.",
    "firstOutreachMessage": "Write the complete first outreach message — subject line and body. Name who receives it. Make it specific to this niche."
  },
  "contentAngles": [
    "Exact article or post title — why it pulls ready-to-buy readers",
    "Angle 2 — same format",
    "Angle 3",
    "Angle 4"
  ],
  "leadMagnet": {
    "name": "Name of the free lead magnet",
    "whatItContains": "Exactly what's inside it — list every section or component",
    "whyTheyWantIt": "Why a cold prospect trades their email for this specific thing"
  }
}`;

// ── CALL 3: 30-Day Week-by-Week Plan ─────────────────────────────────────────
const buildCall3 = (kw, tier) => `You are the lead strategist for Scout-Faire ${tier === 'enterprise' ? 'Enterprise' : 'Monthly'}.

Build a complete 30-day execution plan for this niche: ${kw}

RULES:
- Structure by WEEK not by day. 4 weeks + a daily habits section.
- Each week has: objective, specific tasks to complete that week, what to measure, pass/fail decision.
- Daily habits section lists things done EVERY DAY — short, actionable, specific.
- Week 4 ends with a go/pivot/upgrade decision based on specific numbers.
- No vague tasks. Every task names WHO does it, WHAT exactly, and WHAT the output is.

Return ONLY valid JSON:
{
  "thirtyDayPlan": {
    "monthGoal": "One sentence: the specific outcome that proves this is worth Month 2.",
    "week1": {
      "objective": "Foundation — what gets built this week",
      "tasks": [
        "Task 1 — exactly what, who does it, what it produces",
        "Task 2 — same format",
        "Task 3",
        "Task 4",
        "Task 5"
      ],
      "whatToMeasure": "The specific number or outcome that determines if Week 1 succeeded.",
      "passFailDecision": "Pass = [specific criteria]. Fail = [what to do differently in Week 2]."
    },
    "week2": {
      "objective": "Outreach and first contact — what happens this week",
      "tasks": [
        "Task 1",
        "Task 2",
        "Task 3",
        "Task 4",
        "Task 5"
      ],
      "whatToMeasure": "Specific metric for Week 2 success.",
      "passFailDecision": "Pass = [criteria]. Fail = [adjustment]."
    },
    "week3": {
      "objective": "Validation and first revenue — what happens this week",
      "tasks": [
        "Task 1",
        "Task 2",
        "Task 3",
        "Task 4",
        "Task 5"
      ],
      "whatToMeasure": "Specific metric for Week 3 success.",
      "passFailDecision": "Pass = [criteria]. Fail = [adjustment]."
    },
    "week4": {
      "objective": "Convert and decide — what happens this week",
      "tasks": [
        "Task 1",
        "Task 2",
        "Task 3",
        "Task 4",
        "Task 5"
      ],
      "whatToMeasure": "Specific metric for Week 4 success.",
      "passFailDecision": "Pass = [criteria]. Fail = [adjustment].",
      "endOfMonthDecision": "Go if [specific numbers]. Pivot if [specific numbers]. Upgrade if [specific numbers]."
    },
    "dailyHabits": [
      "Daily: [specific habit] — [why it matters] — [time required]",
      "Daily: [specific habit] — [why it matters] — [time required]",
      "Daily: [specific habit] — [why it matters] — [time required]",
      "Daily: [specific habit] — [why it matters] — [time required]",
      "Daily: [specific habit] — [why it matters] — [time required]"
    ]
  },
  "socialMediaPackage": {
    "strategy": "Which platforms, what content type, what posting cadence, why this niche lives there.",
    "platformFocus": ["Platform 1 — why", "Platform 2 — why"],
    "contentPillars": ["Pillar 1 — topic and buyer pain", "Pillar 2", "Pillar 3"],
    "weekOnePostsCopy": [
      { "platform": "LinkedIn | Facebook | Instagram | X", "day": 1, "copy": "WRITE THE FULL POST. Hook, body, CTA." },
      { "platform": "...", "day": 3, "copy": "WRITE THE FULL POST." },
      { "platform": "...", "day": 5, "copy": "WRITE THE FULL POST." },
      { "platform": "...", "day": 7, "copy": "WRITE THE FULL POST." }
    ],
    "hashtags": ["#relevant", "#niche", "#specific"],
    "engagementTactic": "Exactly how to engage with buyers — what to say, where, how often."
  }
}`;

// Legacy alias
const buildEnterprisePrompt = (kw) => buildCall1(kw, 'enterprise');
const buildMonthlyPrompt    = (kw) => buildCall1(kw, 'monthly');
const buildPrompt           = buildEnterprisePrompt;

// ── FREE prompt — verdict + explanation, no gaps ──────────────────────────────
const buildFreePrompt = (kw) => `You are Scout-Faire. Tell this user if this niche is worth pursuing.

Niche: ${kw}

Return ONLY valid JSON:
{
  "nicheTitle": "Clean 4-8 word name for this niche",
  "verdict": "PURSUE | TEST FIRST | WATCH | AVOID | NEEDS LOCAL VALIDATION",
  "verdictLabel": "One bold bottom-line sentence.",
  "whatThisNicheIs": "2-3 sentences. What is this niche, who are the buyers, why does this market exist. Plain language.",
  "whyItMatters": "1-2 sentences on why this niche is relevant right now.",
  "theGood": "2-3 specific things that make this attractive. Name real signals, not generic statements.",
  "theBad": "2-3 specific risks. Be direct and honest.",
  "theMoney": "Where the fastest revenue actually is in this niche. Name it specifically.",
  "myCall": "The single most important thing to do in the next 7 days.",
  "upgradeTeaser": "One specific sentence on what a Pro report reveals that this cannot — make the person want to upgrade.",
  "niches": [{
    "keyword": "${kw}",
    "opportunityScore": 70,
    "confidence": "High | Medium | Low",
    "trend": "rising | stable | declining",
    "competition": "low | medium | high",
    "buyIntent": "high | medium | low",
    "searchVolume": "high | medium | low",
    "riskFlags": ["Risk 1", "Risk 2"],
    "kpis": ["KPI 1", "KPI 2"]
  }]
}`;

// ── PRO prompt — full analysis with text explanations ────────────────────────
const buildProPrompt = (kw) => `You are Scout-Faire Pro. Give a serious entrepreneur everything they need to evaluate and enter this niche.

Niche: ${kw}

RULES: Name real competitors with real prices. No invented statistics. No vague advice.

Return ONLY valid JSON:
{
  "nicheTitle": "Clean name for this niche",
  "verdict": "PURSUE | TEST FIRST | WATCH | AVOID | NEEDS LOCAL VALIDATION",
  "verdictLabel": "One bold bottom-line sentence.",
  "whatThisNicheIs": "3-4 sentences. What is this niche, who are the buyers, what triggers a purchase, what do they pay.",
  "marketReality": "What is actually happening in this market right now. Demand signals, saturation level, timing, buyer behavior. Be specific.",
  "theGood": "3 specific things that make this attractive. Name real signals and numbers where possible.",
  "theBad": "3 specific risks or challenges. Be direct.",
  "theTrap": "The single most common mistake first-time founders make in this niche.",
  "theMoney": "The fastest path to revenue. Name the offer, the buyer, the price, and the channel.",
  "buyerProfile": "Role, situation, trigger event that makes them ready to buy, typical budget range.",
  "buyerPain": "The specific pain — expensive, recurring, emotional, operational. What keeps them up at night.",
  "topCompetitors": [
    "Real Competitor — what they do, price, specific gap they leave open",
    "Real Competitor — same format",
    "Real Competitor — same format"
  ],
  "competitorGaps": [
    { "gap": "Specific gap", "whyItExists": "Why unfilled", "howToCapture": "Exact move to take it" },
    { "gap": "Gap 2", "whyItExists": "...", "howToCapture": "..." },
    { "gap": "Gap 3", "whyItExists": "...", "howToCapture": "..." }
  ],
  "coreOffer": "Name it. What it includes. Price. Who buys it and why.",
  "offerStack": [
    "Entry — $XX — what it is",
    "Core — $XXX — what it is",
    "Premium — $XXXX — what it is",
    "Recurring — $XX/mo — what keeps them paying"
  ],
  "moneyPath": "Step by step: zero to first dollar, then $1,000/mo, then $5,000/mo. Specific at each step.",
  "contentAngles": ["Exact title that pulls ready-to-buy readers", "Angle 2", "Angle 3", "Angle 4"],
  "myCall": "What to do in the next 7 days. One clear directive.",
  "strategicWarnings": ["Risk 1", "Risk 2", "Risk 3"],
  "niches": [{
    "keyword": "${kw}",
    "opportunityScore": 75,
    "confidence": "High | Medium | Low",
    "trend": "rising | stable | declining",
    "competition": "low | medium | high",
    "buyIntent": "high | medium | low",
    "searchVolume": "high | medium | low",
    "riskFlags": ["Risk 1", "Risk 2"],
    "kpis": ["KPI 1 with number", "KPI 2"]
  }]
}`;

app.post('/api/analyze', isAuthenticated, async (req, res) => {
  try {
    const { keywords } = req.body;
    if (!keywords?.trim()) return res.status(400).json({ error: 'Keywords are required' });
    const ok = await canUseCredit(req.user.id);
    if (!ok) return res.status(402).json({ error: 'No credits remaining. Please upgrade.' });
    const rawKw = keywords.split(',').map(k => k.trim()).filter(Boolean).slice(0, 8);
    if (!rawKw.length) return res.status(400).json({ error: 'Enter at least one keyword.' });

    // Detect user tier
    const u      = await getUser(req.user.id);
    const now    = new Date();
    const hasSub = u?.subscription_type && u?.subscription_expires && new Date(u.subscription_expires) > now;
    const tier   = hasSub ? u.subscription_type : 'free';

    // Clean messy input into proper niche phrases
    const kw       = await Promise.all(rawKw.map(k => extractNiche(k)));
    const nicheStr = kw.join(', ');

    // ── Free and Pro: single call ─────────────────────────────────────────────
    if (tier === 'free' || tier === 'golden_ticket') {
      const text   = await callLLM(SYSTEM_PROMPT, buildFreePrompt(nicheStr), 2000, 0.35);
      const report = normalizeForFrontend(extractJson(text), nicheStr);
      return res.json({ analysis: report, tier: 'free' });
    }

    if (tier === 'pro') {
      const text   = await callLLM(SYSTEM_PROMPT, buildProPrompt(nicheStr), 7000, 0.35);
      const report = normalizeForFrontend(extractJson(text), nicheStr);
      return res.json({ analysis: report, tier: 'pro' });
    }

    // ── Enterprise and Monthly: 3 staggered calls across different keys ──────
    // Running all 3 in parallel on the same key exhausts 8K TPM instantly.
    // Instead we fire them sequentially with a small delay, or the dispatcher
    // will naturally spread them across the 4 rotating keys.
    const reportTier = tier === 'enterprise' ? 'enterprise' : 'monthly';
    console.log(`[Analyze] Running 3-call split for tier=${reportTier} niche="${nicheStr}"`);

    // Sequential with 1s gap — each call uses next key in rotation
    const call1Text = await callLLM(SYSTEM_PROMPT, buildCall1(nicheStr, reportTier), 3500, 0.35);
    await new Promise(r => setTimeout(r, 1000));
    const call2Text = await callLLM(SYSTEM_PROMPT, buildCall2(nicheStr, reportTier), 3500, 0.35);
    await new Promise(r => setTimeout(r, 1000));
    const call3Text = await callLLM(SYSTEM_PROMPT, buildCall3(nicheStr, reportTier), 3500, 0.35);

    const merged = {
      ...extractJson(call1Text),
      ...extractJson(call2Text),
      ...extractJson(call3Text)
    };
    const report = normalizeForFrontend(merged, nicheStr);
    return res.json({ analysis: report, tier: reportTier });

  } catch (e) {
    console.error('Analyze error:', e);
    res.status(500).json({ error: 'Failed to generate report. Please try again.', details: e.message });
  }
});

// ── Business Plan Generator ───────────────────────────────────────────────────
app.post('/api/business-plan', isAuthenticated, async (req, res) => {
  try {
    const { niche, analysis } = req.body;
    if (!niche) return res.status(400).json({ error: 'Niche is required' });

    const ok = await canUseCredit(req.user.id);
    if (!ok) return res.status(402).json({ error: 'No credits remaining. Please upgrade.' });

    const context = analysis ? `
Known intelligence about this niche:
- Opportunity Score: ${analysis.profitability || analysis.score || 'unknown'}
- Trend: ${analysis.trend || 'unknown'}
- Competition: ${analysis.competition || 'unknown'}
- Buy Intent: ${analysis.buyIntent || 'unknown'}
- Biggest Gap: ${analysis.biggestGap || 'unknown'}
- Primary Offer: ${JSON.stringify(analysis.profitFromGaps?.primaryOffer || {})}
` : '';

    const prompt = `You are Scout-Faire. Build a complete actionable business plan for this niche: ${niche}
${context}

Return ONLY valid JSON — no markdown, no backticks:
{
  "executiveSummary": "3-4 sentences. What this business is, who it serves, why it will work, what the operator needs to do first.",
  "whyNow": "1-2 sentences on why this moment is the right time to enter this niche.",
  "phases": [
    {
      "phase": "Phase 1: Foundation (Days 1-7)",
      "timeframe": "Days 1-7",
      "steps": ["Specific action 1", "Action 2", "Action 3", "Action 4", "Action 5"],
      "milestone": "What must be true by end of this phase to continue",
      "budget": "$XXX"
    },
    {
      "phase": "Phase 2: Launch (Days 8-21)",
      "timeframe": "Days 8-21",
      "steps": ["Action 1", "Action 2", "Action 3", "Action 4", "Action 5"],
      "milestone": "What must be true by end of this phase",
      "budget": "$XXX"
    },
    {
      "phase": "Phase 3: Revenue (Days 22-30)",
      "timeframe": "Days 22-30",
      "steps": ["Action 1", "Action 2", "Action 3", "Action 4", "Action 5"],
      "milestone": "First paying customer or validated demand",
      "budget": "$XXX"
    },
    {
      "phase": "Phase 4: Scale (Month 2-3)",
      "timeframe": "Month 2-3",
      "steps": ["Action 1", "Action 2", "Action 3", "Action 4", "Action 5"],
      "milestone": "$X,XXX/mo recurring revenue",
      "budget": "$XXX"
    }
  ],
  "startupCosts": {
    "bootstrap": {
      "total": "$XXX total",
      "breakdown": ["Item — $XX", "Item 2 — $XX", "Item 3 — $XX"]
    },
    "recommended": {
      "total": "$XXX total",
      "breakdown": ["Item — $XX", "Item 2 — $XX", "Item 3 — $XX", "Item 4 — $XX"]
    }
  },
  "actionPlan": {
    "days1to7":   ["Task 1", "Task 2", "Task 3"],
    "days8to14":  ["Task 1", "Task 2", "Task 3"],
    "days15to30": ["Task 1", "Task 2", "Task 3"],
    "days31to60": ["Task 1", "Task 2", "Task 3"],
    "days61to90": ["Task 1", "Task 2", "Task 3"]
  },
  "revenueProjection": {
    "month1": { "range": "$X - $X,XXX", "how": "How you get here — specific actions and customer count" },
    "month3": { "range": "$X,XXX - $X,XXX", "how": "What changes to reach this — more customers, higher price, or new offer" },
    "month6": { "range": "$X,XXX - $XX,XXX", "how": "What the business looks like at 6 months" }
  },
  "risks": [
    { "risk": "Specific risk", "likelihood": "High | Medium | Low", "impact": "High | Medium | Low", "mitigation": "Exactly how to handle it" },
    { "risk": "Risk 2", "likelihood": "...", "impact": "...", "mitigation": "..." },
    { "risk": "Risk 3", "likelihood": "...", "impact": "...", "mitigation": "..." }
  ],
  "successMetrics": [
    "Metric 1 — specific number — by when",
    "Metric 2 — specific number — by when",
    "Metric 3 — specific number — by when",
    "Metric 4 — specific number — by when"
  ],
  "unfairAdvantage": "The one thing this operator can do that no competitor easily copies."
}`;

    const text = await callLLM(SYSTEM_PROMPT, prompt, 4000, 0.35);
    const plan = extractJson(text);
    return res.json({ success: true, plan });
  } catch (e) {
    console.error('Business plan error:', e);
    res.status(500).json({ error: 'Failed to generate business plan.', details: e.message });
  }
});

// ── Scout AI Chat ───────────────────────────────────────────────────────────
require("./routes/chat")(app, { getUser, isAuthenticated });

// ── End-of-Month Interview → Tailored Package ─────────────────────────────────
const EOM_QUESTIONS = [
  'What did you actually complete this month?',
  'Which offer or message got the most attention?',
  'How many people saw the offer?',
  'How many leads, replies, calls, downloads, or purchases came in?',
  'What objections did people give?',
  'What confused people?',
  'What buyer segment responded best?',
  'What buyer segment ignored it?',
  'What part of the plan felt hardest to execute?',
  'What asset do you wish you had?',
  'Did pricing feel too low, too high, or unclear?',
  'Did anyone ask for something slightly different than the offer?',
  'Did you discover a better niche angle?',
  'What proof did you collect?',
  'What should Scout-Faire adjust for next month?'
];

function buildEomPrompt(niche, answers) {
  const qa = EOM_QUESTIONS.map((q, i) => `Q${i+1}: ${q}\nA: ${answers[i] || '(no answer)'}`).join('\n\n');
  return `You are Scout-Faire, generating a tailored next-month strategy package after reviewing a monthly performance interview.

Niche: ${niche}

INTERVIEW ANSWERS:
${qa}

Based on these answers, generate a post-interview tailored package. Be specific — this customer gave you real data. Use it.

RULES:
1. Monthly Performance Summary must reflect what actually happened, not generic encouragement.
2. Best Signal must be the single strongest buyer interest signal mentioned.
3. Weakest Signal must be honest about what failed or produced nothing.
4. Objection Map must turn every real objection into a specific response the customer can use.
5. Updated Buyer Segment must be a decision — not a list of options.
6. Updated Offer Angle must be a repositioning based on the actual feedback received.
7. Next Month Market Pack must include a full outreach message, not just a description of one.
8. Launch Package Recommendation must give a clear yes/not yet/what must change first.

Return ONLY valid JSON:
{
  "monthlyPerformanceSummary": "3-4 sentences. What happened. What was learned. What changed. Written directly to the customer.",
  "bestSignal": "The single strongest sign that buyer interest exists — specific detail from the interview.",
  "weakestSignal": "The part of the offer, market, or message that produced the least. Be direct.",
  "objectionMap": [
    { "objection": "Exact objection heard", "response": "The specific reply or repositioning that addresses it" }
  ],
  "updatedBuyerSegment": "Who to focus on next month and why — based on what actually responded, not theory.",
  "updatedOfferAngle": "How the offer should be repositioned based on what buyers said, asked for, or were confused by.",
  "nextMonthMarketPack": {
    "buyerAngle": "Updated buyer angle for this month — who they are and what they care about right now.",
    "leadMagnetImprovement": "What to change or create — specific improvement based on this month's results.",
    "articleAsset": {
      "title": "Specific article title for next month based on objections and buyer questions",
      "body": "Write the complete article. Minimum 500 words. Based on what buyers were confused about or asked about. Useful, publishable, trust-building."
    },
    "outreachMessage": "WRITE THE COMPLETE OUTREACH MESSAGE. Name the recipient type. Write subject line and body. Include the specific angle that worked this month. Include a low-pressure CTA.",
    "campaignTest": "One specific test to run next month — what to change, what to measure, what pass/fail looks like.",
    "metricToWatch": "The one number that will tell them whether Month 2 is working.",
    "decisionToMake": "The decision to make by the end of next month — based on what specific result."
  },
  "launchPackageRecommendation": "YES — ready for full buildout / NOT YET — needs one more month of validation / WHAT MUST CHANGE FIRST — state the exact condition that must be met. Be specific."
}`;
}

const isEnterpriseUser = async (req, res, next) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const u = await getUser(req.user.id);
    const now = new Date();
    const hasSub = u?.subscription_type && u?.subscription_expires && new Date(u.subscription_expires) > now;
    if (hasSub && u.subscription_type === 'enterprise') return next();
    return res.status(403).json({ error: 'Enterprise Yearly membership required for End-of-Month Interview.' });
  } catch (e) { res.status(500).json({ error: 'Auth check failed' }); }
};

app.post('/api/end-of-month-interview', isEnterpriseUser, async (req, res) => {
  try {
    const { niche, answers } = req.body;
    if (!niche || !Array.isArray(answers)) return res.status(400).json({ error: 'niche and answers array required' });

    const text = await callLLM(
      'You are Scout-Faire. Return only strict JSON matching the requested schema.',
      buildEomPrompt(niche, answers),
      16000,
      0.3
    );
    const pkg = extractJson(text);
    return res.json({ package: pkg, niche, generatedAt: new Date().toISOString() });
  } catch (e) {
    console.error('EOM interview error:', e);
    res.status(500).json({ error: 'Failed to generate package', details: e.message });
  }
});

// ── Business Plan Generator ───────────────────────────────────────────────────
// Available to Pro, Monthly, Enterprise, and Golden Ticket users
app.post('/api/business-plan', isAuthenticated, async (req, res) => {
  try {
    const { niche, analysis } = req.body;
    if (!niche) return res.status(400).json({ error: 'niche is required' });

    const u      = await getUser(req.user.id);
    const now    = new Date();
    const hasSub = u?.subscription_type && u?.subscription_expires && new Date(u.subscription_expires) > now;
    const tier   = hasSub ? u.subscription_type : 'free';

    if (tier === 'free') return res.status(402).json({ error: 'Business plan requires a paid plan.' });

    const ok = await canUseCredit(req.user.id);
    if (!ok) return res.status(402).json({ error: 'No credits remaining.' });

    const prompt = `You are Scout-Faire. Build a complete business plan for this niche: ${niche}

${analysis ? `Context from market analysis: verdict=${analysis.nicheDefinition?.verdict||''}, biggest gap=${analysis.biggestGap||''}, primary offer=${analysis.profitFromGaps?.primaryOffer?.name||''}` : ''}

Return ONLY valid JSON:
{
  "phases": [
    {
      "phase": "Phase 1: Foundation (Days 1-30)",
      "goal": "Specific goal for this phase",
      "actions": ["Exact action 1", "Exact action 2", "Exact action 3", "Exact action 4", "Exact action 5"],
      "milestone": "The specific outcome that marks this phase complete",
      "budget": "Estimated cost range for this phase"
    },
    {
      "phase": "Phase 2: Traction (Days 31-60)",
      "goal": "Specific goal",
      "actions": ["Action 1", "Action 2", "Action 3", "Action 4", "Action 5"],
      "milestone": "Phase completion milestone",
      "budget": "Estimated cost range"
    },
    {
      "phase": "Phase 3: Scale (Days 61-90)",
      "goal": "Specific goal",
      "actions": ["Action 1", "Action 2", "Action 3", "Action 4", "Action 5"],
      "milestone": "Phase completion milestone",
      "budget": "Estimated cost range"
    }
  ],
  "actionPlan": {
    "week1": "Exact tasks for week 1 — specific, named, actionable",
    "week2": "Exact tasks for week 2",
    "week3": "Exact tasks for week 3",
    "week4": "Exact tasks for week 4"
  },
  "revenueProjection": {
    "month1": "Realistic revenue range for month 1 and how to achieve it",
    "month2": "Month 2 projection based on month 1 results",
    "month3": "Month 3 projection",
    "breakeven": "When and how breakeven is reached"
  },
  "startupCosts": {
    "essential": "Must-have costs to launch — itemized with amounts",
    "optional": "Nice-to-have costs — itemized",
    "total": "Total estimated startup cost range"
  },
  "risks": [
    { "risk": "Specific risk", "likelihood": "high | medium | low", "mitigation": "Exact mitigation strategy" },
    { "risk": "Risk 2", "likelihood": "...", "mitigation": "..." },
    { "risk": "Risk 3", "likelihood": "...", "mitigation": "..." }
  ],
  "successMetrics": [
    "Metric 1 — specific number and timeframe",
    "Metric 2 — specific number and timeframe",
    "Metric 3 — specific number and timeframe",
    "Metric 4 — specific number and timeframe"
  ]
}`;

    const text = await callLLM(
      'You are Scout-Faire. Return only strict JSON. No markdown, no backticks.',
      prompt,
      5000,
      0.35
    );
    const plan = extractJson(text);
    return res.json({ success: true, plan });
  } catch (e) {
    console.error('Business plan error:', e);
    res.status(500).json({ error: 'Failed to generate business plan', details: e.message });
  }
});

// ── Health + Catch-all ────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok' }));
app.get('/{*path}', (req, res) => {
  const page = req.path.endsWith('.html') ? path.join(__dirname, 'public', path.basename(req.path)) : path.join(__dirname, 'public', 'index.html');
  res.sendFile(page, err => { if (err) res.sendFile(path.join(__dirname, 'public', 'index.html')); });
});

// ── Boot ──────────────────────────────────────────────────────────────────────
initDb().then(() => app.listen(PORT, () => console.log(`Scout-Faire running on port ${PORT}`))).catch(e => { console.error('DB init failed:', e); process.exit(1); });
