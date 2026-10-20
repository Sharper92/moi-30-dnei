'use strict';

require('dotenv').config();

const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const HabitModel = require('../dist/habit-model.js');
const defaults = require('../dist/default-habits.js');
const { pool, migrateAndSeed, usernameKey } = require('./db.js');
const { emptyState } = require('./default-state.js');

const app = express();
const port = Number(process.env.PORT || 8080);
const production = process.env.NODE_ENV === 'production';
const sessionDays = Math.max(1, Math.min(90, Number(process.env.SESSION_DAYS || 30)));
const cookieName = 'moi30_session';

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      manifestSrc: ["'self'"],
      workerSrc: ["'self'"]
    }
  }
}));
app.use(express.json({ limit: '512kb' }));
app.use(cookieParser());

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 40, standardHeaders: 'draft-8', legacyHeaders: false });

function validUsername(value) {
  return typeof value === 'string' && /^[\p{L}\p{N}_.-]{3,32}$/u.test(value.trim());
}

function validPassword(value) {
  return typeof value === 'string' && value.length >= 10 && value.length <= 200;
}

function validDisplayName(value) {
  return typeof value === 'string' && value.trim().length >= 1 && value.trim().length <= 64 && !/[\u0000-\u001f\u007f]/u.test(value);
}

function validUserPushSettings(value) {
  return value && /^(?:0[9]|1\d|20):00$/.test(value.time)
    && Array.isArray(value.days) && value.days.length >= 1 && value.days.length <= 7
    && value.days.every((day, index) => Number.isInteger(day) && day >= 1 && day <= 7 && value.days.indexOf(day) === index)
    && typeof value.supportEnabled === 'boolean' && typeof value.inactiveEnabled === 'boolean'
    && (value.pausedUntil == null || value.pausedUntil === '' || /^\d{4}-\d{2}-\d{2}$/.test(value.pausedUntil));
}

function sessionHash(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function publicUser(row) {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name || row.username,
    role: row.role,
    mustChangePassword: row.must_change_password
  };
}

async function issueSession(res, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + sessionDays * 86400000);
  await pool.query('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)', [sessionHash(token), userId, expiresAt]);
  res.cookie(cookieName, token, {
    httpOnly: true,
    secure: production,
    sameSite: 'lax',
    path: '/',
    expires: expiresAt
  });
}

async function authRequired(req, res, next) {
  try {
    const token = req.cookies[cookieName];
    if (!token) return res.status(401).json({ error: 'AUTH_REQUIRED' });
    const result = await pool.query(
      `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.expires_at > now()`,
      [sessionHash(token)]
    );
    if (!result.rowCount) {
      res.clearCookie(cookieName, { path: '/' });
      return res.status(401).json({ error: 'AUTH_REQUIRED' });
    }
    req.user = result.rows[0];
    req.sessionTokenHash = sessionHash(token);
    next();
  } catch (error) {
    next(error);
  }
}

app.get('/api/health', async (req, res, next) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true });
  } catch (error) { next(error); }
});

app.post('/api/auth/register', authLimiter, async (req, res, next) => {
  const username = req.body?.username;
  const password = req.body?.password;
  if (!validUsername(username)) return res.status(400).json({ error: 'INVALID_USERNAME' });
  if (!validPassword(password)) return res.status(400).json({ error: 'INVALID_PASSWORD' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const id = crypto.randomUUID();
    const passwordHash = await bcrypt.hash(password, 12);
    const inserted = await client.query(
      `INSERT INTO users (id, username, username_key, display_name, password_hash, role, must_change_password)
       VALUES ($1, $2, $3, $4, $5, 'user', false) RETURNING *`,
      [id, username.trim(), usernameKey(username), username.trim(), passwordHash]
    );
    await client.query('INSERT INTO user_states (user_id, state, revision) VALUES ($1, $2::jsonb, 0)', [id, JSON.stringify(emptyState())]);
    await client.query('COMMIT');
    await issueSession(res, id);
    res.status(201).json({ user: publicUser(inserted.rows[0]) });
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.code === '23505') return res.status(409).json({ error: 'USERNAME_TAKEN' });
    next(error);
  } finally {
    client.release();
  }
});

app.post('/api/auth/login', authLimiter, async (req, res, next) => {
  try {
    const username = req.body?.username;
    const password = req.body?.password;
    if (!validUsername(username) || typeof password !== 'string') return res.status(401).json({ error: 'INVALID_CREDENTIALS' });
    const result = await pool.query('SELECT * FROM users WHERE username_key = $1', [usernameKey(username)]);
    const user = result.rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: 'INVALID_CREDENTIALS' });
    }
    await issueSession(res, user.id);
    res.json({ user: publicUser(user) });
  } catch (error) { next(error); }
});

app.post('/api/auth/logout', authRequired, async (req, res, next) => {
  try {
    await pool.query('DELETE FROM sessions WHERE token_hash = $1', [req.sessionTokenHash]);
    res.clearCookie(cookieName, { path: '/' });
    res.status(204).end();
  } catch (error) { next(error); }
});

app.get('/api/auth/me', authRequired, (req, res) => res.json({ user: publicUser(req.user) }));

app.post('/api/auth/change-password', authRequired, authLimiter, async (req, res, next) => {
  try {
    const currentPassword = req.body?.currentPassword;
    const newPassword = req.body?.newPassword;
    if (!(await bcrypt.compare(String(currentPassword || ''), req.user.password_hash))) {
      return res.status(400).json({ error: 'WRONG_PASSWORD' });
    }
    if (!validPassword(newPassword)) return res.status(400).json({ error: 'INVALID_PASSWORD' });
    if (await bcrypt.compare(newPassword, req.user.password_hash)) return res.status(400).json({ error: 'PASSWORD_UNCHANGED' });
    const passwordHash = await bcrypt.hash(newPassword, 12);
    await pool.query(
      'UPDATE users SET password_hash = $1, must_change_password = false, updated_at = now() WHERE id = $2',
      [passwordHash, req.user.id]
    );
    await pool.query('DELETE FROM sessions WHERE user_id = $1 AND token_hash <> $2', [req.user.id, req.sessionTokenHash]);
    res.json({ ok: true });
  } catch (error) { next(error); }
});

app.get('/api/profile', authRequired, async (req, res, next) => {
  try {
    if (req.user.must_change_password) return res.status(403).json({ error: 'PASSWORD_CHANGE_REQUIRED' });
    const result = await pool.query(
      `SELECT notification_time::text, notification_days, support_enabled, inactive_enabled, paused_until::text
       FROM user_preferences WHERE user_id = $1`, [req.user.id]
    );
    const preferences = result.rows[0];
    res.json({
      user: publicUser(req.user),
      pushSettings: preferences ? {
        time: preferences.notification_time.slice(0, 5),
        days: preferences.notification_days,
        supportEnabled: preferences.support_enabled,
        inactiveEnabled: preferences.inactive_enabled,
        pausedUntil: preferences.paused_until
      } : { time: '18:00', days: [1, 2, 3, 4, 5, 6, 7], supportEnabled: true, inactiveEnabled: true, pausedUntil: null },
      pushDevices: 0
    });
  } catch (error) { next(error); }
});

app.put('/api/profile', authRequired, authLimiter, async (req, res, next) => {
  try {
    const displayName = req.body?.displayName;
    const username = req.body?.username;
    if (!validDisplayName(displayName)) return res.status(400).json({ error: 'INVALID_DISPLAY_NAME' });
    if (!validUsername(username)) return res.status(400).json({ error: 'INVALID_USERNAME' });
    const changed = usernameKey(username) !== req.user.username_key;
    if (changed && !(await bcrypt.compare(String(req.body?.currentPassword || ''), req.user.password_hash))) {
      return res.status(400).json({ error: 'WRONG_PASSWORD' });
    }
    const result = await pool.query(
      `UPDATE users SET display_name = $1, username = $2, username_key = $3, updated_at = now()
       WHERE id = $4 RETURNING *`,
      [displayName.trim(), username.trim(), usernameKey(username), req.user.id]
    );
    res.json({ user: publicUser(result.rows[0]) });
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'USERNAME_TAKEN' });
    next(error);
  }
});

app.put('/api/profile/push-settings', authRequired, async (req, res, next) => {
  try {
    if (!validUserPushSettings(req.body)) return res.status(400).json({ error: 'INVALID_PUSH_SETTINGS' });
    const settings = { ...req.body, pausedUntil: req.body.pausedUntil || null };
    await pool.query(
      `INSERT INTO user_preferences
        (user_id, notification_time, notification_days, support_enabled, inactive_enabled, paused_until)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id) DO UPDATE SET notification_time = EXCLUDED.notification_time,
         notification_days = EXCLUDED.notification_days, support_enabled = EXCLUDED.support_enabled,
         inactive_enabled = EXCLUDED.inactive_enabled, paused_until = EXCLUDED.paused_until, updated_at = now()`,
      [req.user.id, settings.time, settings.days, settings.supportEnabled, settings.inactiveEnabled, settings.pausedUntil]
    );
    res.json({ pushSettings: settings });
  } catch (error) { next(error); }
});

app.get('/api/state', authRequired, async (req, res, next) => {
  try {
    if (req.user.must_change_password) return res.status(403).json({ error: 'PASSWORD_CHANGE_REQUIRED' });
    const result = await pool.query('SELECT state, revision, updated_at FROM user_states WHERE user_id = $1', [req.user.id]);
    res.json(result.rows[0]);
  } catch (error) { next(error); }
});

app.put('/api/state', authRequired, async (req, res, next) => {
  try {
    if (req.user.must_change_password) return res.status(403).json({ error: 'PASSWORD_CHANGE_REQUIRED' });
    const revision = req.body?.revision;
    const sanitized = HabitModel.sanitize(req.body?.state, defaults);
    if (!Number.isInteger(revision) || revision < 0 || !sanitized) return res.status(400).json({ error: 'INVALID_STATE' });
    const result = await pool.query(
      `UPDATE user_states SET state = $1::jsonb, revision = revision + 1, updated_at = now()
       WHERE user_id = $2 AND revision = $3
       RETURNING state, revision, updated_at`,
      [JSON.stringify(sanitized), req.user.id, revision]
    );
    if (!result.rowCount) {
      const current = await pool.query('SELECT state, revision, updated_at FROM user_states WHERE user_id = $1', [req.user.id]);
      return res.status(409).json({ error: 'STATE_CONFLICT', current: current.rows[0] });
    }
    res.json(result.rows[0]);
  } catch (error) { next(error); }
});

app.use(express.static(path.join(__dirname, '..', 'dist'), { index: 'index.html', maxAge: production ? '1h' : 0 }));
app.get('*path', (req, res) => res.sendFile(path.join(__dirname, '..', 'dist', 'index.html')));

app.use((error, req, res, next) => {
  console.error(error);
  if (res.headersSent) return next(error);
  res.status(500).json({ error: 'SERVER_ERROR' });
});

migrateAndSeed()
  .then(() => app.listen(port, () => console.log(`Мои 30 дней: http://0.0.0.0:${port}`)))
  .catch(error => {
    console.error('Не удалось запустить приложение:', error);
    process.exit(1);
  });
