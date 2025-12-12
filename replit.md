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
- **Database**: PostgreSQL (Neon-backed) via Drizzle ORM

### Authentication
- **Provider**: Replit Auth (OpenID Connect)
- **Login Methods**: Google, GitHub, Apple, email/password
- **Session Storage**: PostgreSQL-backed sessions via connect-pg-simple
- **Routes**: `/api/login`, `/api/logout`, `/api/callback`

### AI Integration
- **Provider**: Anthropic Claude API (claude-sonnet-4-20250514 model)
- **Purpose**: Generates market intelligence analysis from user-provided keywords
- **Response Format**: Structured JSON containing profitability scores, trends, and market insights

### Payment System
- **Provider**: Stripe for payment processing
- **Integration Method**: Uses Replit Connectors for Stripe credential management
- **Checkout Flow**: Server-side session creation with client-side redirect
- **Security**: Server-side payment verification before granting credits
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
- **Styling**: Custom CSS with gradient theming
- **Pages**: Main app (index.html), pricing page (pricing.html), success page (success.html)
- **Auth Flow**: Checks `/api/auth/user` to determine login state

### Database Schema
- **users**: id (PK), email, first_name, last_name, profile_image_url, credits, subscription_type, subscription_expires_at, created_at, updated_at
- **sessions**: sid (PK), sess (JSONB), expire

### Key Files
- `server.js` - Main Express server with all API routes
- `server/replitAuth.js` - Replit Auth integration (OIDC)
- `server/storage.js` - Database operations for users/credits
- `server/db.js` - PostgreSQL connection and table initialization
- `shared/schema.js` - Drizzle ORM schema definitions
- `stripeClient.js` - Stripe client with Replit Connector integration

## External Dependencies

### Required Environment Variables
- `ANTHROPIC_API_KEY` - Required for Claude AI API access
- `DATABASE_URL` - PostgreSQL connection string
- `SESSION_SECRET` - Secret for session encryption
- `REPLIT_CONNECTORS_HOSTNAME` - Replit connector service hostname
- `REPL_IDENTITY` or `WEB_REPL_RENEWAL` - Replit authentication tokens
- `REPLIT_DEPLOYMENT` - Set to "1" for production Stripe keys

### Third-Party Services
- **Anthropic Claude API** - AI-powered market analysis generation
- **Stripe** - Payment processing, subscription management
- **Replit Auth** - User authentication via OpenID Connect
- **Replit Connectors** - Secure credential management for Stripe keys

### NPM Dependencies
- `express` - Web server framework
- `cors` - Cross-origin resource sharing middleware
- `@anthropic-ai/sdk` - Anthropic API client
- `stripe` - Stripe API client
- `passport` - Authentication middleware
- `openid-client` - OpenID Connect client
- `express-session` - Session middleware
- `connect-pg-simple` - PostgreSQL session store
- `drizzle-orm` - Database ORM
- `pg` - PostgreSQL client

## Recent Changes (December 2024)
- Added Replit Auth for user authentication
- Integrated PostgreSQL database for persistent user data
- Credits now stored in database instead of localStorage
- Added server-side payment verification for security
- Protected all API endpoints requiring authentication
