'use strict';
// ── routes/chat.js — Scout AI Coach ──────────────────────────────────────────
// 3-tier routing:
//   Tier 1: llama-3.1-8b-instant  — simple Q&A, report context
//   Tier 2: openai/gpt-oss-20b    — strategy, analysis, message review
//   Tier 3: openai/gpt-oss-120b   — asset generation (Pro capped at Tier 2)

const GROQ_KEYS      = [process.env.GROQ_API_KEY, process.env.GROQ_API_KEY_II, process.env.GROQ_API_KEY_III, process.env.GROQ_API_KEY_IV].filter(Boolean);
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || null;
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'meta-llama/llama-3.3-70b-instruct:free';

const CHAT_SMALL = 'llama-3.1-8b-instant';
const CHAT_MID   = 'openai/gpt-oss-20b';
const CHAT_LARGE = 'openai/gpt-oss-120b';

// ── Keyword routing ───────────────────────────────────────────────────────────
const ASSET_TRIGGERS = [
  'write', 'draft', 'create', 'generate', 'build', 'make me',
  'email sequence', 'landing page', 'lead magnet', 'outreach message',
  'sales page', 'social post', 'ad copy', 'script'
];
const STRATEGY_TRIGGERS = [
  'strategy', 'pricing', 'should i', 'how do i', 'what if', 'compare',
  'analyze', 'review', 'feedback', 'think through', 'best way',
  'approach', 'position', 'compete', 'differentiate'
];

function routeTier(message) {
  const lower = message.toLowerCase();
  if (ASSET_TRIGGERS.some(t => lower.includes(t)))    return 'large';
  if (STRATEGY_TRIGGERS.some(t => lower.includes(t))) return 'mid';
  return 'small';
}

// ── Model caller ──────────────────────────────────────────────────────────────
async function callScout(tier, messages) {
  const model     = tier === 'large' ? CHAT_LARGE : tier === 'mid' ? CHAT_MID : CHAT_SMALL;
  const maxTokens = tier === 'large' ? 3000        : tier === 'mid' ? 1500      : 800;

  for (const key of GROQ_KEYS) {
    try {
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
        body: JSON.stringify({ model, max_completion_tokens: maxTokens, temperature: 0.4, messages })
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(`Groq ${r.status}: ${e?.error?.message || r.statusText}`);
      }
      const data = await r.json();
      return { text: data.choices?.[0]?.message?.content || '', model, tier };
    } catch (e) {
      console.warn(`[Scout] ${model} key=...${key.slice(-4)} failed: ${e.message}`);
    }
  }

  // OpenRouter fallback
  if (OPENROUTER_KEY) {
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENROUTER_KEY}` },
      body: JSON.stringify({ model: OPENROUTER_MODEL, max_tokens: maxTokens, temperature: 0.4, messages })
    });
    const data = await r.json();
    return { text: data.choices?.[0]?.message?.content || '', model: OPENROUTER_MODEL, tier: 'fallback' };
  }

  throw new Error('All Scout models exhausted');
}

// ── System prompts ────────────────────────────────────────────────────────────
const PROCESSES = `
THE 5 PROCESSES OF THE FIRST 30 DAYS:
1. FOUNDATION   — Define offer, identify exact buyer, write positioning, write first outreach message.
                  Complete when: offer named and priced, buyer described in one sentence, message written.
2. OUTREACH     — Build list of 50+ targets, send first 20 messages, track every reply.
                  Complete when: 20+ messages sent, all replies logged.
3. VALIDATION   — Have 3+ real conversations with buyers, collect objections, refine offer.
                  Complete when: 3 conversations done, top 3 objections documented.
4. LAUNCH       — Make first direct offer to warmest leads, attempt first sale.
                  Complete when: at least one direct offer made, result documented.
5. REVIEW       — Assess what worked, what didn't, make go/pivot decision based on numbers.
                  Complete when: decision made and documented.`;

function buildSystemPrompt(report, tier) {
  const nd    = report?.nicheDefinition || {};
  const pfg   = report?.profitFromGaps  || {};
  const tdp   = report?.thirtyDayPlan   || {};
  const gaps  = report?.competitorGaps  || [];
  const niche = report?.niches?.[0]     || {};

  const context = `
NICHE: ${niche.keyword || 'Unknown'}
TREND: ${niche.trend || '?'} | COMPETITION: ${niche.competition || '?'} | BUY INTENT: ${niche.buyIntent || '?'}
WHAT IT IS: ${nd.whatItIs || 'Not available'}
WHO BUYS: ${nd.whoIsInIt || 'Not available'}
BIGGEST GAP: ${report?.biggestGap || 'Not available'}
PRIMARY OFFER: ${pfg.primaryOffer?.name || 'Not defined'} at ${pfg.primaryOffer?.price || 'TBD'}
MONTH GOAL: ${tdp.monthGoal || 'Not set'}
GAPS: ${gaps.slice(0,2).map(g => `${g.competitor}: ${g.whatTheyMiss}`).join(' | ') || 'Not available'}`;

  // PRO — process-based guidance only, no day-by-day, no asset generation
  if (tier === 'pro') {
    return `You are Scout — the AI coach inside Scout-Faire Pro.
${context}
${PROCESSES}

RULES FOR PRO MEMBERS:
1. Answer general niche, market, and offer questions directly and honestly.
2. When asked "what's my next step" or "what do I do now":
   - Identify which Process they are likely in
   - List what's left to complete that process
   - Tell them what the next process covers
   - Say whether they sound ready to move on or not
3. Never give day-by-day tasks. Never say "do this today" or "Day 1".
4. If they are stuck — give one unblocking question to think through, then say:
   "If you're still stuck, reply here and the Scout-Faire team will personally reach out within 48 hours."
5. Keep answers under 250 words. Be direct. No preamble.
6. Never say "leverage social media", "provide value", or "go viral".`;
  }

  // ENTERPRISE / MONTHLY — full coaching, next move, asset generation
  return `You are Scout — the AI coach inside Scout-Faire ${tier === 'monthly_market_pack' ? 'Monthly' : 'Enterprise'}.
${context}
${PROCESSES}

RULES FOR ENTERPRISE/MONTHLY MEMBERS:
1. Answer directly. No preamble. No "great question."
2. "What's my next step / what do I do today" → give ONE specific task: what, who, what to say, how long.
3. If they mention their location or situation (courthouse, networking, vendor call) — cluster tasks intelligently.
4. If asked to write something — write it fully. Not an outline. The actual thing.
5. Keep answers under 400 words unless writing an asset.
6. Ask ONE clarifying question if needed — not three.
7. Name the exact platform, message, and action — never vague channel advice.
8. Tie every answer back to which Process they are in and whether this move completes it.`;
}

// ── Route export ──────────────────────────────────────────────────────────────
module.exports = function registerChatRoute(app, { getUser, isAuthenticated }) {
  app.post('/api/chat', isAuthenticated, async (req, res) => {
    try {
      const { message, history = [], reportContext = null } = req.body;
      if (!message?.trim()) return res.status(400).json({ error: 'Message is required' });

      const u      = await getUser(req.user.id);
      const now    = new Date();
      const hasSub = u?.subscription_type && u?.subscription_expires && new Date(u.subscription_expires) > now;
      const tier   = hasSub ? u.subscription_type : 'free';

      // Free and Golden Ticket don't get Scout
      if (tier === 'free' || tier === 'golden_ticket') {
        return res.status(403).json({
          error: 'Scout is available on Pro and above. Upgrade to access your AI coach.'
        });
      }

      // Route — Pro capped at mid (no asset generation)
      const rawTier   = routeTier(message);
      const modelTier = (tier === 'pro' && rawTier === 'large') ? 'mid' : rawTier;
      console.log(`[Scout] tier=${modelTier} plan=${tier} msg="${message.slice(0, 50)}"`);

      const systemPrompt = buildSystemPrompt(reportContext, tier);
      const messages = [
        { role: 'system', content: systemPrompt },
        ...history.slice(-10).map(h => ({ role: h.role, content: h.content })),
        { role: 'user', content: message }
      ];

      const result = await callScout(modelTier, messages);
      return res.json({ reply: result.text, model: result.model, tier: result.tier });

    } catch (e) {
      console.error('[Scout] Error:', e);
      res.status(500).json({ error: 'Scout is unavailable right now. Try again in a moment.' });
    }
  });
};
