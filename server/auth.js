const passport       = require('passport');
const LocalStrategy  = require('passport-local').Strategy;
const bcrypt         = require('bcryptjs');
const session        = require('express-session');
const connectPg      = require('connect-pg-simple');
const { storage }    = require('./storage');
const { pool }       = require('./db');

function getSession() {
  const PgStore    = connectPg(session);
  const sessionTtl = 7 * 24 * 60 * 60 * 1000;
  return session({
    secret: process.env.SESSION_SECRET || 'scout-faire-secret-change-me',
    store: new PgStore({
      pool,
      createTableIfMissing: true,
      ttl: sessionTtl / 1000,
      tableName: 'sessions',
    }),
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, secure: process.env.NODE_ENV === 'production', maxAge: sessionTtl },
  });
}

async function setupAuth(app) {
  app.set('trust proxy', 1);
  app.use(getSession());
  app.use(passport.initialize());
  app.use(passport.session());

  passport.use(new LocalStrategy({ usernameField: 'email' }, async (email, password, done) => {
    try {
      const user = await storage.getUserByEmail(email.toLowerCase());
      if (!user || !user.passwordHash) return done(null, false, { message: 'Invalid credentials' });
      const match = await bcrypt.compare(password, user.passwordHash);
      if (!match) return done(null, false, { message: 'Invalid credentials' });
      return done(null, { claims: { sub: user.id, email: user.email } });
    } catch (e) {
      return done(e);
    }
  }));

  passport.serializeUser((user, cb) => cb(null, user));
  passport.deserializeUser((user, cb) => cb(null, user));

  /* ── Register ── */
  app.post('/api/register', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    if (password.length < 8)  return res.status(400).json({ error: 'Password must be at least 8 characters' });

    try {
      const existing = await storage.getUserByEmail(email.toLowerCase());
      if (existing) return res.status(409).json({ error: 'Email already registered' });

      const hash = await bcrypt.hash(password, 12);
      const userId = `user_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

      await storage.upsertUser({
        id: userId,
        email: email.toLowerCase(),
        firstName: null,
        lastName: null,
        profileImageUrl: null,
        passwordHash: hash,
      });

      req.login({ claims: { sub: userId, email: email.toLowerCase() } }, err => {
        if (err) return res.status(500).json({ error: 'Login after register failed' });
        res.json({ success: true, redirect: '/' });
      });
    } catch (e) {
      console.error('Register error:', e);
      res.status(500).json({ error: 'Registration failed' });
    }
  });

  /* ── Login ── */
  app.post('/api/login', (req, res, next) => {
    passport.authenticate('local', (err, user, info) => {
      if (err)   return res.status(500).json({ error: 'Server error' });
      if (!user) return res.status(401).json({ error: info?.message || 'Invalid credentials' });
      req.login(user, loginErr => {
        if (loginErr) return res.status(500).json({ error: 'Login failed' });
        res.json({ success: true, redirect: '/' });
      });
    })(req, res, next);
  });

  /* ── Logout ── */
  app.get('/api/logout', (req, res) => {
    req.logout(() => res.redirect('/login.html'));
  });
}

const isAuthenticated = (req, res, next) => {
  if (req.isAuthenticated()) return next();
  res.status(401).json({ message: 'Unauthorized' });
};

module.exports = { setupAuth, isAuthenticated };
