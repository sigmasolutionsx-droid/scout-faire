# Scout-Faire

## Overview

Scout-Faire is an AI-powered niche market intelligence tool that analyzes market niches using Claude AI. Users can input keywords to receive detailed market analysis including profitability scores, trends, search volume, competition levels, and buy intent. The application uses a credit-based monetization system with Stripe integration for payments.

## User Preferences

Preferred communication style: Simple, everyday language.

## System Architecture

### Backend Architecture
- **Framework**: Express.js (v5.x) running on Node.js
- **API Pattern**: RESTful endpoints with JSON payloads
- **Port**: Configurable via PORT environment variable, defaults to 5000

### AI Integration
- **Provider**: Anthropic Claude API (claude-sonnet-4-20250514 model)
- **Purpose**: Generates market intelligence analysis from user-provided keywords
- **Response Format**: Structured JSON containing profitability scores, trends, and market insights

### Payment System
- **Provider**: Stripe for payment processing
- **Integration Method**: Uses Replit Connectors for Stripe credential management
- **Checkout Flow**: Server-side session creation with client-side redirect
- **Webhook Handling**: Raw body parsing required before JSON middleware (critical ordering)
- **Environment Handling**: Automatic switching between development/production based on REPLIT_DEPLOYMENT flag

### Pricing Tiers
| Plan | Price | Credits |
|------|-------|---------|
| Single Analysis | $2.99 | 1 search |
| Starter Pack | $10.00 | 5 searches |
| Pro Monthly | $19.99/mo | 30 searches + $0.99 overage |
| Seikuku Precision | $34.99/mo | Unlimited |

### Frontend Architecture
- **Type**: Static HTML/CSS/JavaScript served from `/public` directory
- **Styling**: Custom CSS with gradient theming, some pages use Tailwind CDN
- **React Usage**: Babel-transpiled React components loaded via CDN (not a build step)
- **Pages**: Main app (index.html), pricing page, success/confirmation page

### Session Management
- **Current State**: Session-based tracking via `sessionId` parameter
- **Note**: No database currently configured; credit tracking implementation may need persistent storage

## External Dependencies

### Required Environment Variables
- `ANTHROPIC_API_KEY` - Required for Claude AI API access
- `REPLIT_CONNECTORS_HOSTNAME` - Replit connector service hostname
- `REPL_IDENTITY` or `WEB_REPL_RENEWAL` - Replit authentication tokens
- `REPLIT_DEPLOYMENT` - Set to "1" for production Stripe keys

### Third-Party Services
- **Anthropic Claude API** - AI-powered market analysis generation
- **Stripe** - Payment processing, subscription management, and webhooks
- **Replit Connectors** - Secure credential management for Stripe keys

### NPM Dependencies
- `express` - Web server framework
- `cors` - Cross-origin resource sharing middleware
- `@anthropic-ai/sdk` - Anthropic API client
- `stripe` - Stripe API client
- `stripe-replit-sync` - Replit-specific Stripe synchronization utilities