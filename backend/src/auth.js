const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const { v4: uuidv4 } = require('uuid');

const router = express.Router();

// ─── In-Memory User Store ─────────────────────────────────────────────────── 
// Production: replace with PostgreSQL / MongoDB
const users = new Map();

// ─── Config ──────────────────────────────────────────────────────────────────
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const APP_DEEP_LINK = process.env.APP_DEEP_LINK || 'nebula://auth';

// ─── Token Utilities ──────────────────────────────────────────────────────────
function generateToken(user) {
  return jwt.sign(
    {
      id: user.id,
      username: user.username,
      avatar: user.avatar || null,
      email: user.email || null,
    },
    JWT_SECRET,
    { expiresIn: '24h' }
  );
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

// ─── Google OAuth Strategy ────────────────────────────────────────────────────
const googleOAuthReady =
  GOOGLE_CLIENT_ID &&
  GOOGLE_CLIENT_SECRET &&
  GOOGLE_CLIENT_ID !== 'your-google-client-id.apps.googleusercontent.com';

if (googleOAuthReady) {
  passport.use(
    new GoogleStrategy(
      {
        clientID: GOOGLE_CLIENT_ID,
        clientSecret: GOOGLE_CLIENT_SECRET,
        callbackURL:
          process.env.GOOGLE_CALLBACK_URL ||
          'http://localhost:3001/api/auth/google/callback',
      },
      (_accessToken, _refreshToken, profile, done) => {
        const email = profile.emails?.[0]?.value || null;
        const googleId = profile.id;

        // Find by googleId first, then by email (account linking)
        let user = [...users.values()].find(
          (u) => u.googleId === googleId || (email && u.email === email)
        );

        if (!user) {
          // Create brand-new user from Google profile
          user = {
            id: uuidv4(),
            username: generateUniqueUsername(
              profile.displayName || email?.split('@')[0] || 'user'
            ),
            email,
            googleId,
            passwordHash: null,
            avatar: profile.photos?.[0]?.value || null,
            createdAt: new Date().toISOString(),
          };
          users.set(user.id, user);
        } else if (!user.googleId) {
          // Link Google to existing password account
          user.googleId = googleId;
          if (!user.avatar) user.avatar = profile.photos?.[0]?.value || null;
          if (!user.email) user.email = email;
        }

        done(null, user);
      }
    )
  );
}

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser((id, done) => done(null, users.get(id) || null));

// ─── Helpers ──────────────────────────────────────────────────────────────────
function generateUniqueUsername(base) {
  // Sanitize: lowercase, replace spaces with underscores, strip special chars
  const clean = base.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
  if (!findUserByUsername(clean)) return clean;
  // Append random suffix until unique
  for (let i = 0; i < 100; i++) {
    const candidate = `${clean}_${Math.floor(Math.random() * 9000) + 1000}`;
    if (!findUserByUsername(candidate)) return candidate;
  }
  return `${clean}_${uuidv4().slice(0, 8)}`;
}

function findUserByUsername(username) {
  return [...users.values()].find(
    (u) => u.username.toLowerCase() === username.toLowerCase()
  );
}

function safeUser(user) {
  return { id: user.id, username: user.username, avatar: user.avatar, email: user.email };
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// POST /api/register
router.post('/register', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password)
      return res.status(400).json({ error: 'Username and password are required' });
    if (username.length < 3 || username.length > 32)
      return res.status(400).json({ error: 'Username must be 3–32 characters' });
    if (!/^[a-zA-Z0-9_]+$/.test(username))
      return res.status(400).json({ error: 'Username can only contain letters, numbers, and underscores' });
    if (password.length < 6)
      return res.status(400).json({ error: 'Password must be at least 6 characters' });

    if (findUserByUsername(username))
      return res.status(409).json({ error: 'Username is already taken' });

    const passwordHash = await bcrypt.hash(password, 10);
    const user = {
      id: uuidv4(),
      username,
      email: null,
      googleId: null,
      passwordHash,
      avatar: null,
      createdAt: new Date().toISOString(),
    };
    users.set(user.id, user);

    const token = generateToken(user);
    res.status(201).json({ token, user: safeUser(user) });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/login
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password)
      return res.status(400).json({ error: 'Username and password are required' });

    const user = findUserByUsername(username);
    if (!user || !user.passwordHash)
      return res.status(401).json({ error: 'Invalid username or password' });

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid)
      return res.status(401).json({ error: 'Invalid username or password' });

    const token = generateToken(user);
    res.json({ token, user: safeUser(user) });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/auth/google  — redirects to Google consent screen
router.get('/auth/google', (req, res, next) => {
  if (!googleOAuthReady) {
    return res.status(503).send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:40px">
        <h2>⚠️ Google OAuth Not Configured</h2>
        <p>Add <code>GOOGLE_CLIENT_ID</code> and <code>GOOGLE_CLIENT_SECRET</code> to <code>backend/.env</code></p>
        <p>See <strong>README.md</strong> for step-by-step setup instructions.</p>
      </body></html>
    `);
  }
  passport.authenticate('google', {
    scope: ['profile', 'email'],
    prompt: 'select_account',
  })(req, res, next);
});

// GET /api/auth/google/callback  — Google redirects here after consent
// Note: router is mounted at /api in server.js, so this registers as /api/auth/google/callback
router.get(
  '/auth/google/callback',
  passport.authenticate('google', {
    session: false,
    failureRedirect: `${APP_DEEP_LINK}?error=auth_failed`,
  }),
  (req, res) => {
    const token = generateToken(req.user);
    // Redirect to Electron deep-link which the main process intercepts
    res.redirect(`${APP_DEEP_LINK}?token=${token}`);
  }
);

// GET /api/me — verify token and return user profile
router.get('/me', (req, res) => {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer '))
    return res.status(401).json({ error: 'Authorization header missing' });

  const user = verifyToken(auth.slice(7));
  if (!user) return res.status(401).json({ error: 'Token invalid or expired' });

  res.json({ user });
});

module.exports = router;
module.exports.verifyToken = verifyToken;
