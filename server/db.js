'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
const { emptyState, liaState } = require('./default-state.js');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

function usernameKey(value) {
  return String(value).trim().toLocaleLowerCase('ru-RU');
}

async function createSeedUser(client, { username, password, role, mustChangePassword, state }) {
  const passwordHash = await bcrypt.hash(password, 12);
  const id = crypto.randomUUID();
  await client.query(
    `INSERT INTO users (id, username, username_key, password_hash, role, must_change_password)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, username.trim(), usernameKey(username), passwordHash, role, mustChangePassword]
  );
  await client.query(
    'INSERT INTO user_states (user_id, state, revision) VALUES ($1, $2::jsonb, 0)',
    [id, JSON.stringify(state)]
  );
}

async function migrateAndSeed() {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(schema);
    await client.query('SELECT pg_advisory_xact_lock(303030)');
    const count = await client.query('SELECT count(*)::int AS count FROM users');
    if (count.rows[0].count === 0) {
      const adminUsername = process.env.ADMIN_USERNAME || 'admin';
      const adminPassword = process.env.ADMIN_PASSWORD;
      const liaUsername = process.env.LIA_USERNAME || 'Лия';
      const liaPassword = process.env.LIA_TEMP_PASSWORD;
      if (!adminPassword || !liaPassword) {
        throw new Error('ADMIN_PASSWORD и LIA_TEMP_PASSWORD обязательны при первом запуске.');
      }
      await createSeedUser(client, {
        username: adminUsername,
        password: adminPassword,
        role: 'admin',
        mustChangePassword: true,
        state: emptyState()
      });
      await createSeedUser(client, {
        username: liaUsername,
        password: liaPassword,
        role: 'user',
        mustChangePassword: true,
        state: liaState()
      });
    }
    await client.query('DELETE FROM sessions WHERE expires_at <= now()');
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { pool, migrateAndSeed, usernameKey };
