const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 5000;
const ANALYSIS_PRICE = '2.99';
const CURRENCY = 'USD';

if (!process.env.ANTHROPIC_API_KEY || !process.env.PAYPAL_CLIENT_ID || !process.env.PAYPAL_CLIENT_SECRET) {
    console.error('Missing required environment variables');
    console.error('This app requires: ANTHROPIC_API_KEY, PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET');
    process.exit(1);
}

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// API endpoint for niche analysis
app.post('/api/analyze', async (req, res) => {
    try {
        const { keywords } = req.body;

        if (!keywords || !keywords.trim()) {
            return res.status(400).json({ error: 'Keywords are required' });
        }

        // Split keywords by comma
        const keywordList = keywords.split(',').map(k => k.trim()).filter(k => k);

        // Call Claude API for analysis
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
        
        // Parse the JSON response
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

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ status: 'ok', service: 'Scout-Faire API' });
});

// Serve the frontend
app.get('/{*splat}', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Scout-Faire server running on port ${PORT}`);
});
