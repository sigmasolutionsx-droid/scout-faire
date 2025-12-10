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
    const { text, prompt } = req.body;

    if (!text && !prompt) {
      return res.status(400).json({ error: 'Text or prompt is required' });
    }

    const userMessage = prompt || `Please analyze the following text:\n\n${text}`;

    const message = await anthropic.messages.create({
      model: DEFAULT_MODEL,
      max_tokens: 1024,
      messages: [{ role: 'user', content: userMessage }],
    });

    const responseText = message.content[0].type === 'text' 
      ? message.content[0].text 
      : '';

    res.json({ 
      result: responseText,
      model: DEFAULT_MODEL,
      usage: message.usage
    });
  } catch (error) {
    console.error('Error calling Anthropic API:', error.message);
    res.status(500).json({ error: 'Failed to analyze text', details: error.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
