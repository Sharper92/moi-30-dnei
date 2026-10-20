'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Pool } = require('pg');
const Model = require('../dist/habit-model.js');

const base = 'http://127.0.0.1:' + (process.env.PORT || 8080);
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function json(path, options = {}, cookie = '') {
  const response = await fetch(base + path, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  return { response, body: response.status === 204 ? null : await response.json() };
}

async function main() {
  const seeded = await pool.query(
    `SELECT u.username, u.role, u.must_change_password,
            jsonb_array_length(s.state->'habits') AS habits
     FROM users u JOIN user_states s ON s.user_id = u.id
     WHERE u.username_key IN ($1, $2)
     ORDER BY u.created_at, u.username`,
    ['admin', 'лия']
  );
  assert.equal(seeded.rows.length, 2);
  assert.equal(seeded.rows[0].role, 'admin');
  const lia = seeded.rows.find(row => row.username.toLocaleLowerCase('ru-RU') === 'лия');
  assert.ok(lia);
  assert.equal(lia.must_change_password, true);
  assert.equal(lia.habits, 19);

  const adminLogin = await json('/api/auth/login', {
    method: 'POST', body: { username: process.env.ADMIN_USERNAME, password: process.env.ADMIN_PASSWORD }
  });
  assert.equal(adminLogin.response.status, 200);
  assert.equal(adminLogin.body.user.role, 'admin');
  assert.equal(adminLogin.body.user.mustChangePassword, true);
  const adminCookie = adminLogin.response.headers.get('set-cookie').split(';')[0];
  await json('/api/auth/logout', { method: 'POST' }, adminCookie);

  const liaLogin = await json('/api/auth/login', {
    method: 'POST', body: { username: process.env.LIA_USERNAME, password: process.env.LIA_TEMP_PASSWORD }
  });
  assert.equal(liaLogin.response.status, 200);
  assert.equal(liaLogin.body.user.mustChangePassword, true);
  const liaCookie = liaLogin.response.headers.get('set-cookie').split(';')[0];
  const blockedState = await json('/api/state', {}, liaCookie);
  assert.equal(blockedState.response.status, 403);
  assert.equal(blockedState.body.error, 'PASSWORD_CHANGE_REQUIRED');
  await json('/api/auth/logout', { method: 'POST' }, liaCookie);

  const username = 'autotest_' + crypto.randomBytes(5).toString('hex');
  const password = crypto.randomBytes(18).toString('base64url');
  try {
    const registered = await json('/api/auth/register', { method: 'POST', body: { username, password } });
    assert.equal(registered.response.status, 201);
    const cookie = registered.response.headers.get('set-cookie').split(';')[0];
    await pool.query('UPDATE users SET must_change_password = true WHERE username_key = $1', [username]);
    const forced = await json('/api/state', {}, cookie);
    assert.equal(forced.response.status, 403);
    const nextPassword = crypto.randomBytes(18).toString('base64url');
    const changed = await json('/api/auth/change-password', {
      method: 'POST', body: { currentPassword: password, newPassword: nextPassword }
    }, cookie);
    assert.equal(changed.response.status, 200);
    const empty = await json('/api/state', {}, cookie);
    assert.equal(empty.response.status, 200);
    assert.equal(empty.body.state.habits.length, 0);

    const state = Model.addHabit(empty.body.state, {
      name: 'Тестовая привычка', icon: '🌱', group: 'Дом и развитие', days: [0, 1, 2, 3, 4, 5, 6]
    }, empty.body.state.start).state;
    const saved = await json('/api/state', { method: 'PUT', body: { state, revision: empty.body.revision } }, cookie);
    assert.equal(saved.response.status, 200);
    assert.equal(saved.body.state.habits.length, 1);

    const reloaded = await json('/api/state', {}, cookie);
    assert.equal(reloaded.body.state.habits.length, 1);
    console.log('smoke ok: admin, Lia password gate, forced password change, empty state, add habit, persistence');
  } finally {
    await pool.query('DELETE FROM users WHERE username_key = $1', [username.toLocaleLowerCase('ru-RU')]);
    await pool.end();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
