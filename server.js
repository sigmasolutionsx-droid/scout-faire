const express = require('express');
const cors = require('cors');
const path = require('path');
const { getUncachableStripeClient, getStripePublishableKey } = require('./stripeClient');
const { setupAuth, isAuthenticated } = require('./server/replitAuth');
const { storage } = require('./server/storage');
const { initializeTables } = require('./server/db');

const app = express();
const PORT = process.env.PORT || 5000;

if (!process.env.ANTHROPIC_API_KEY) {
    console.error('Missing ANTHROPIC_API_KEY');
    process.exit(1);
}

const PRICING = {
    single: { name: 'Single Analysis', price: 299, searches: 1 },
    starter: { name: 'Starter Pack', price: 1000, searches: 5 },
    pro: { name: 'Pro Monthly', price: 1999, searches: 30, type: 'subscription', overage: 99 },
    seikuku: { name: 'Seikuku Precision', price: 3499, searches: -1, type: 'subscription' }
};

const PRICE_IDS = {
    single: process.env.STRIPE_PRICE_SINGLE || null,
    starter: process.env.STRIPE_PRICE_STARTER || null,
    pro: process.env.STRIPE_PRICE_PRO || null,
    seikuku: process.env.STRIPE_PRICE_SEIKUKU || null,
    additional: process.env.STRIPE_PRICE_ADDITIONAL || null
};

app.post(
    '/api/stripe/webhook/:uuid',
    express.raw({ type: 'application/json' }),
    async (req, res) => {
        res.status(200).json({ received: true });
    }
);

app.use(cors());
app.use(express.json());

async function startServer() {
    initializeTables().catch(err => console.error('DB init error:', err.message));

    try {
        await setupAuth(app);
        console.log('Auth initialized');
    } catch (error) {
        console.error('Auth setup error:', error.message);
    }

    app.use(express.static('public'));

    app.get('/api/auth/user', isAuthenticated, async (req, res) => {
        try {
            const userId = req.user.claims.sub;
            const user = await storage.getUser(userId);
            res.json(user);
        } catch (error) {
            console.error("Error fetching user:", error);
            res.status(500).json({ message: "Failed to fetch user" });
        }
    });

    app.get('/api/stripe/config', async (req, res) => {
        try {
            const publishableKey = await getStripePublishableKey();
            res.json({ publishableKey, pricing: PRICING });
        } catch (error) {
            res.status(500).json({ error: 'Failed to get Stripe config' });
        }
    });

    app.post('/api/checkout', isAuthenticated, async (req, res) => {
        try {
            const { priceId, plan } = req.body;
            const userId = req.user.claims.sub;
            
            const resolvedPriceId = priceId || PRICE_IDS[plan];
            
            if (!resolvedPriceId) {
                return res.status(400).json({ error: 'Price ID required. Set STRIPE_PRICE_* environment variables or pass priceId directly.' });
            }

            const planData = PRICING[plan] || {};
            const isSubscription = planData.type === 'subscription';

            const stripe = await getUncachableStripeClient();
            const baseUrl = `https://${process.env.REPLIT_DOMAINS?.split(',')[0]}`;
            
            const session = await stripe.checkout.sessions.create({
                mode: isSubscription ? 'subscription' : 'payment',
                line_items: [{ price: resolvedPriceId, quantity: 1 }],
                success_url: `${baseUrl}/success.html?session_id={CHECKOUT_SESSION_ID}&plan=${plan || 'custom'}`,
                cancel_url: `${baseUrl}/pricing.html`,
                metadata: {
                    plan: plan || 'custom',
                    userId
                }
            });

            res.json({ url: session.url, sessionId: session.id });
        } catch (error) {
            console.error('Checkout error:', error);
            res.status(500).json({ error: 'Failed to create checkout session' });
        }
    });

    app.post('/api/create-checkout-session', isAuthenticated, async (req, res) => {
        try {
            const { plan } = req.body;
            const planData = PRICING[plan];
            const userId = req.user.claims.sub;
            
            if (!planData) {
                return res.status(400).json({ error: 'Invalid plan' });
            }

            const stripe = await getUncachableStripeClient();
            const baseUrl = `https://${process.env.REPLIT_DOMAINS?.split(',')[0]}`;
            
            const sessionConfig = {
                payment_method_types: ['card'],
                line_items: [{
                    price_data: {
                        currency: 'usd',
                        product_data: {
                            name: planData.name,
                            description: planData.searches === -1 
                                ? 'Unlimited monthly searches' 
                                : `${planData.searches} ${planData.type === 'subscription' ? 'searches/month' : 'searches'}`,
                        },
                        unit_amount: planData.price,
                        ...(planData.type === 'subscription' && { recurring: { interval: 'month' } })
                    },
                    quantity: 1,
                }],
                mode: planData.type === 'subscription' ? 'subscription' : 'payment',
                success_url: `${baseUrl}/success.html?session_id={CHECKOUT_SESSION_ID}&plan=${plan}`,
                cancel_url: `${baseUrl}/pricing.html`,
                metadata: {
                    plan,
                    searches: planData.searches.toString(),
                    userId
                }
            };

            const session = await stripe.checkout.sessions.create(sessionConfig);
            res.json({ url: session.url });
        } catch (error) {
            console.error('Checkout error:', error);
            res.status(500).json({ error: 'Failed to create checkout session' });
        }
    });

    app.post('/api/buy-additional', isAuthenticated, async (req, res) => {
        try {
            const stripe = await getUncachableStripeClient();
            const baseUrl = `https://${process.env.REPLIT_DOMAINS?.split(',')[0]}`;
            const userId = req.user.claims.sub;
            
            const session = await stripe.checkout.sessions.create({
                payment_method_types: ['card'],
                line_items: [{
                    price_data: {
                        currency: 'usd',
                        product_data: {
                            name: 'Additional Search',
                            description: 'One additional niche analysis',
                        },
                        unit_amount: 99,
                    },
                    quantity: 1,
                }],
                mode: 'payment',
                success_url: `${baseUrl}/success.html?session_id={CHECKOUT_SESSION_ID}&plan=additional`,
                cancel_url: `${baseUrl}/`,
                metadata: { userId, plan: 'additional' }
            });

            res.json({ url: session.url });
        } catch (error) {
            console.error('Additional search error:', error);
            res.status(500).json({ error: 'Failed to create checkout' });
        }
    });

    const verifiedSessions = new Set();

    app.post('/api/verify-session', isAuthenticated, async (req, res) => {
        try {
            const { sessionId } = req.body;
            const userId = req.user.claims.sub;
            
            if (!sessionId) {
                return res.status(400).json({ error: 'Session ID required' });
            }

            if (verifiedSessions.has(sessionId)) {
                return res.status(400).json({ error: 'Session already verified' });
            }

            const stripe = await getUncachableStripeClient();
            const session = await stripe.checkout.sessions.retrieve(sessionId);

            if (session.payment_status !== 'paid') {
                return res.status(400).json({ error: 'Payment not completed' });
            }

            if (session.metadata?.userId !== userId) {
                return res.status(400).json({ error: 'Session mismatch' });
            }

            verifiedSessions.add(sessionId);

            const plan = session.metadata?.plan || 'single';
            const planData = PRICING[plan] || PRICING.single;

            let user;
            if (plan === 'single' || plan === 'additional') {
                user = await storage.addCredits(userId, 1);
            } else if (plan === 'starter') {
                user = await storage.addCredits(userId, 5);
            } else if (plan === 'pro') {
                const expiresAt = new Date();
                expiresAt.setMonth(expiresAt.getMonth() + 1);
                user = await storage.setSubscription(userId, 'pro', expiresAt);
            } else if (plan === 'seikuku') {
                const expiresAt = new Date();
                expiresAt.setMonth(expiresAt.getMonth() + 1);
                user = await storage.setSubscription(userId, 'seikuku', expiresAt);
            }
            
            res.json({
                verified: true,
                plan,
                credits: user?.credits || 0,
                subscriptionType: user?.subscriptionType || null
            });
        } catch (error) {
            console.error('Session verification error:', error);
            res.status(400).json({ error: 'Invalid session' });
        }
    });

    app.post('/api/analyze', isAuthenticated, async (req, res) => {
        try {
            const { keywords } = req.body;
            const userId = req.user.claims.sub;

            if (!keywords || !keywords.trim()) {
                return res.status(400).json({ error: 'Keywords are required' });
            }

            const canUse = await storage.useCredit(userId);
            if (!canUse) {
                return res.status(402).json({ error: 'No credits available. Please purchase more.' });
            }

            const keywordList = keywords.split(',').map(k => k.trim()).filter(k => k);

            const response = await fetch('https://api.anthropic.com/v1/messages', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': process.env.ANTHROPIC_API_KEY,
                    'anthropic-version': '2023-06-01'
                },
                body: JSON.stringify({
                    model: 'claude-sonnet-4-20250514',
                    max_tokens: 4000,
                    messages: [{
                        role: 'user',
                        content: `You are a market intelligence analyst for Scout-Faire. Analyze these niches: ${keywordList.join(', ')}

Return ONLY a JSON object (no markdown, no backticks) with this exact structure:
{
  "overallInsight": "2-3 sentence market overview covering all niches",
  "niches": [
    {
      "keyword": "exact keyword from input",
      "profitability": number 1-10,
      "trend": "rising" | "stable" | "declining",
      "searchVolume": "high" | "medium" | "low",
      "competition": "low" | "medium" | "high",
      "buyIntent": "high" | "medium" | "low",
      "opportunity": "2-3 sentence explanation of the opportunity",
      "recommendations": ["action 1", "action 2", "action 3"]
    }
  ],
  "emergingOpportunities": ["opportunity 1", "opportunity 2", "opportunity 3"]
}

Provide realistic, data-driven analysis based on current market trends.`
                    }]
                })
            });

            if (!response.ok) {
                throw new Error(`Claude API error: ${response.status}`);
            }

            const data = await response.json();
            const analysisText = data.content[0].text;
            const analysis = JSON.parse(analysisText);

            const user = await storage.getUser(userId);
            res.json({ analysis, credits: user?.credits || 0 });

        } catch (error) {
            console.error('Analysis error:', error);
            res.status(500).json({ 
                error: 'Failed to analyze niche. Please try again.',
                details: error.message 
            });
        }
    });

    app.get('/health', (req, res) => {
        res.json({ status: 'ok', service: 'Scout-Faire API' });
    });

    app.get('/{*splat}', (req, res) => {
        res.sendFile(path.join(__dirname, 'public', 'index.html'));
    });

    app.listen(PORT, '0.0.0.0', () => {
        console.log(`Scout-Faire server running on port ${PORT}`);
    });
}

startServer();
