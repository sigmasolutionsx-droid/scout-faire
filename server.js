const express = require('express');
const cors = require('cors');
const path = require('path');
const { runMigrations } = require('stripe-replit-sync');
const { getStripeSync, getUncachableStripeClient, getStripePublishableKey } = require('./stripeClient');
const { WebhookHandlers } = require('./webhookHandlers');

const app = express();
const PORT = process.env.PORT || 5000;
const ANALYSIS_PRICE = '2.99';
const CURRENCY = 'USD';

if (!process.env.ANTHROPIC_API_KEY) {
    console.error('Missing required environment variables');
    console.error('This app requires: ANTHROPIC_API_KEY');
    process.exit(1);
}

async function initStripe() {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
        console.log('DATABASE_URL not found, skipping Stripe initialization');
        return;
    }

    try {
        console.log('Initializing Stripe schema...');
        await runMigrations({ databaseUrl, schema: 'stripe' });
        console.log('Stripe schema ready');

        const stripeSync = await getStripeSync();

        console.log('Setting up managed webhook...');
        const webhookBaseUrl = `https://${process.env.REPLIT_DOMAINS?.split(',')[0]}`;
        const { webhook, uuid } = await stripeSync.findOrCreateManagedWebhook(
            `${webhookBaseUrl}/api/stripe/webhook`,
            {
                enabled_events: ['*'],
                description: 'Managed webhook for Scout-Faire',
            }
        );
        console.log(`Webhook configured: ${webhook.url}`);

        console.log('Syncing Stripe data...');
        stripeSync.syncBackfill()
            .then(() => console.log('Stripe data synced'))
            .catch((err) => console.error('Error syncing Stripe data:', err));
    } catch (error) {
        console.error('Failed to initialize Stripe:', error);
    }
}

initStripe();

app.post(
    '/api/stripe/webhook/:uuid',
    express.raw({ type: 'application/json' }),
    async (req, res) => {
        const signature = req.headers['stripe-signature'];
        if (!signature) {
            return res.status(400).json({ error: 'Missing stripe-signature' });
        }

        try {
            const sig = Array.isArray(signature) ? signature[0] : signature;
            const { uuid } = req.params;
            await WebhookHandlers.processWebhook(req.body, sig, uuid);
            res.status(200).json({ received: true });
        } catch (error) {
            console.error('Webhook error:', error.message);
            res.status(400).json({ error: 'Webhook processing error' });
        }
    }
);

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

app.get('/api/stripe/config', async (req, res) => {
    try {
        const publishableKey = await getStripePublishableKey();
        res.json({ publishableKey, price: ANALYSIS_PRICE, currency: CURRENCY });
    } catch (error) {
        res.status(500).json({ error: 'Failed to get Stripe config' });
    }
});

app.post('/api/create-checkout-session', async (req, res) => {
    try {
        const stripe = await getUncachableStripeClient();
        const baseUrl = `https://${process.env.REPLIT_DOMAINS?.split(',')[0]}`;
        
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [{
                price_data: {
                    currency: CURRENCY.toLowerCase(),
                    product_data: {
                        name: 'Scout-Faire Niche Analysis',
                        description: 'AI-powered market intelligence report',
                    },
                    unit_amount: Math.round(parseFloat(ANALYSIS_PRICE) * 100),
                },
                quantity: 1,
            }],
            mode: 'payment',
            success_url: `${baseUrl}/success?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${baseUrl}/`,
        });

        res.json({ url: session.url });
    } catch (error) {
        console.error('Checkout error:', error);
        res.status(500).json({ error: 'Failed to create checkout session' });
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

app.get('/health', (req, res) => {
    res.json({ status: 'ok', service: 'Scout-Faire API' });
});

app.get('/{*splat}', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Scout-Faire server running on port ${PORT}`);
});
