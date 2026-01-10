# Scout-Faire

AI-powered niche market intelligence platform that helps entrepreneurs and marketers find profitable opportunities in any market.

## Overview

Scout-Faire analyzes market niches using advanced AI to deliver comprehensive market intelligence including:

- Profitability scores
- Market trends analysis
- Search volume estimates
- Competition levels
- Buy intent indicators
- Competitor gap analysis

## Features

### Free Tier ($0/month)
- 5 comprehensive analyses per month
- Basic market opportunity scores
- Trend indicators
- Monthly credit reset

### Pro Tier ($19.99/month)
- Unlimited analyses (500 fair use)
- Full competitor gap analysis
- PDF & CSV exports
- Priority email support

### Enterprise Tier ($99.99/month)
- 2000 analyses per month
- White-label reports
- Team accounts & collaboration
- API access
- Dedicated account manager

## Tech Stack

- **Backend**: Node.js with Express.js
- **Database**: PostgreSQL (Neon-backed) with Drizzle ORM
- **Authentication**: Replit Auth (OpenID Connect)
- **Payments**: Stripe integration
- **AI**: Claude AI (Anthropic) for market analysis

## Getting Started

1. Clone the repository
2. Install dependencies:
   ```bash
   npm install
   ```
3. Set up environment variables:
   - `DATABASE_URL` - PostgreSQL connection string
   - `ANTHROPIC_API_KEY` - Anthropic API key for AI analysis
   - `SESSION_SECRET` - Secret for session encryption

4. Run the server:
   ```bash
   node server.js
   ```

The application will be available at `http://localhost:5000`

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/login` | GET | Initiate login flow |
| `/api/logout` | GET | End user session |
| `/api/auth/user` | GET | Get current user info |
| `/api/analyze` | POST | Run market analysis |
| `/api/create-checkout-session` | POST | Create Stripe checkout |
| `/api/verify-session` | POST | Verify payment session |

## Project Structure

```
scout-faire/
├── server.js              # Main Express server
├── server/
│   ├── db.js              # Database connection
│   ├── replitAuth.js      # Authentication setup
│   └── storage.js         # Database operations
├── shared/
│   └── schema.js          # Drizzle ORM schema
├── public/
│   ├── index.html         # Main application
│   ├── pricing.html       # Pricing page
│   ├── success.html       # Payment success page
│   ├── logo.png           # Company logo
│   └── *.css/js           # Styles and scripts
└── stripeClient.js        # Stripe integration
```

## License

Proprietary - All rights reserved
