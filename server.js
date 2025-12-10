const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 5000;

// The newest Anthropic model is "claude-sonnet-4-20250514"
const DEFAULT_MODEL = "claude-sonnet-4-20250514";

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/analyze', async (req, res) => {
  try {
    const { text, niche } = req.body;

    const nicheToScore = niche || text;

    if (!nicheToScore) {
      return res.status(400).json({ error: 'Niche concept is required' });
    }

    const systemPrompt = `You are a business niche analyst. Score the given niche concept on a scale of 1-10 for each category. Provide your response in the following JSON format:
{
  "niche": "the niche name",
  "scores": {
    "marketDemand": { "score": 1-10, "reasoning": "brief explanation" },
    "competition": { "score": 1-10, "reasoning": "brief explanation (higher = less competition, better)" },
    "profitPotential": { "score": 1-10, "reasoning": "brief explanation" },
    "scalability": { "score": 1-10, "reasoning": "brief explanation" },
    "uniqueness": { "score": 1-10, "reasoning": "brief explanation" }
  },
  "overallScore": 1-10,
  "summary": "2-3 sentence overall assessment",
  "recommendations": ["actionable tip 1", "actionable tip 2", "actionable tip 3"]
}`;

    const message = await anthropic.messages.create({
      model: DEFAULT_MODEL,
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: 'user', content: `Score this niche concept: ${nicheToScore}` }],
    });

    const responseText = message.content[0].type === 'text' 
      ? message.content[0].text 
      : '';

    let parsed;
    try {
      parsed = JSON.parse(responseText);
    } catch {
      parsed = { rawResponse: responseText };
    }

    res.json({ 
      result: parsed,
      model: DEFAULT_MODEL,
      usage: message.usage
    });
  } catch (error) {
    console.error('Error calling Anthropic API:', error.message);
    res.status(500).json({ error: 'Failed to score niche', details: error.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
