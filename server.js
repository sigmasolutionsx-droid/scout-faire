const express = require('express');
const cors = require('cors');
const path = require('path');
const { getUncachableStripeClient, getStripePublishableKey } = require('./stripeClient');

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

app.post(
    '/api/stripe/webhook/:uuid',
    express.raw({ type: 'application/json' }),
    async (req, res) => {
        res.status(200).json({ received: true });
    }
);

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

app.get('/api/stripe/config', async (req, res) => {
    try {
        const publishableKey = await getStripePublishableKey();
        res.json({ publishableKey, pricing: PRICING });
    } catch (error) {
        res.status(500).json({ error: 'Failed to get Stripe config' });
    }
});

app.post('/api/create-checkout-session', async (req, res) => {
    try {
        const { plan, sessionId } = req.body;
        const planData = PRICING[plan];
        
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
            success_url: `${baseUrl}/success.html?session_id={CHECKOUT_SESSION_ID}&plan=${plan}&searches=${planData.searches}`,
            cancel_url: `${baseUrl}/pricing.html`,
            metadata: {
                plan,
                searches: planData.searches.toString(),
                clientSessionId: sessionId || ''
            }
        };

        const session = await stripe.checkout.sessions.create(sessionConfig);
        res.json({ url: session.url });
    } catch (error) {
        console.error('Checkout error:', error);
        res.status(500).json({ error: 'Failed to create checkout session' });
    }
});

app.post('/api/buy-additional', async (req, res) => {
    try {
        const stripe = await getUncachableStripeClient();
        const baseUrl = `https://${process.env.REPLIT_DOMAINS?.split(',')[0]}`;
        
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
            success_url: `${baseUrl}/success.html?session_id={CHECKOUT_SESSION_ID}&plan=additional&searches=1`,
            cancel_url: `${baseUrl}/`,
        });

        res.json({ url: session.url });
    } catch (error) {
        console.error('Additional search error:', error);
        res.status(500).json({ error: 'Failed to create checkout' });
    }
});

app.post('/api/analyze', async (req, res) => {
    try {
        const { keywords } = req.body;

        if (!keywords || !keywords.trim()) {
            return res.status(400).json({ error: 'Keywords are required' });
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

        res.json({ analysis });

    } catch (error) {
        console.error('Analysis error:', error);
        res.status(500).json({ 
            error: 'Failed to analyze niche. Please try again.',
            details: error.message 
        });
    }
});

const verifiedSessions = new Set();

app.post('/api/verify-session', async (req, res) => {
    try {
        const { sessionId } = req.body;
        
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

        verifiedSessions.add(sessionId);

        const plan = session.metadata?.plan || 'single';
        const planData = PRICING[plan] || PRICING.single;
        
        res.json({
            verified: true,
            plan,
            searches: planData.searches,
            subscriptionType: planData.type === 'subscription' ? plan : null
        });
    } catch (error) {
        console.error('Session verification error:', error);
        res.status(400).json({ error: 'Invalid session' });
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
