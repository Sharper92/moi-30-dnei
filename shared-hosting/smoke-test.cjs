'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const Model = require('../dist/habit-model.js');

const base = String(process.env.BASE_URL || '').replace(/\/$/, '');
const adminUsername = process.env.ADMIN_USERNAME;
const adminPassword = process.env.ADMIN_PASSWORD;
const liaUsername = process.env.LIA_USERNAME;
const liaPassword = process.env.LIA_TEMP_PASSWORD;

if (!base || !adminUsername || !adminPassword || !liaUsername || !liaPassword) {
  throw new Error('BASE_URL and initial account credentials are required.');
}

async function request(path, options = {}, cookie = '') {
  const response = await fetch(base + path, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const body = response.status === 204 ? null : await response.json();
  return { response, body };
}

function responseCookie(response) {
  const value = response.headers.get('set-cookie');
  assert.ok(value);
  return value.split(';')[0];
}

async function main() {
  const health = await request('/api/health');
  assert.equal(health.response.status, 200);
  assert.equal(health.body.ok, true);

  const adminLogin = await request('/api/auth/login', {
    method: 'POST', body: { username: adminUsername, password: adminPassword }
  });
  assert.equal(adminLogin.response.status, 200);
  assert.equal(adminLogin.body.user.role, 'admin');
  assert.equal(adminLogin.body.user.mustChangePassword, true);
  await request('/api/auth/logout', { method: 'POST' }, responseCookie(adminLogin.response));

  const liaLogin = await request('/api/auth/login', {
    method: 'POST', body: { username: liaUsername, password: liaPassword }
  });
  assert.equal(liaLogin.response.status, 200);
  assert.equal(liaLogin.body.user.mustChangePassword, true);
  const liaCookie = responseCookie(liaLogin.response);
  const blocked = await request('/api/state', {}, liaCookie);
  assert.equal(blocked.response.status, 403);
  assert.equal(blocked.body.error, 'PASSWORD_CHANGE_REQUIRED');
  await request('/api/auth/logout', { method: 'POST' }, liaCookie);

  const username = 'autotest_' + crypto.randomBytes(5).toString('hex');
  const password = crypto.randomBytes(18).toString('base64url');
  const nextPassword = crypto.randomBytes(18).toString('base64url');
  const registered = await request('/api/auth/register', {
    method: 'POST', body: { username, password }
  });
  assert.equal(registered.response.status, 201);
  assert.equal(registered.body.user.mustChangePassword, false);
  const cookie = responseCookie(registered.response);

  const empty = await request('/api/state', {}, cookie);
  assert.equal(empty.response.status, 200);
  assert.deepEqual(empty.body.state.habits, []);

  const state = Model.addHabit(empty.body.state, {
    name: 'Тестовая привычка',
    icon: '🌱',
    group: 'Дом и развитие',
    days: [0, 1, 2, 3, 4, 5, 6]
  }, empty.body.state.start).state;
  const saved = await request('/api/state', {
    method: 'PUT', body: { state, revision: empty.body.revision }
  }, cookie);
  assert.equal(saved.response.status, 200);
  assert.equal(saved.body.state.habits.length, 1);

  const changed = await request('/api/auth/change-password', {
    method: 'POST', body: { currentPassword: password, newPassword: nextPassword }
  }, cookie);
  assert.equal(changed.response.status, 200);
  await request('/api/auth/logout', { method: 'POST' }, cookie);

  const relogin = await request('/api/auth/login', {
    method: 'POST', body: { username, password: nextPassword }
  });
  assert.equal(relogin.response.status, 200);
  const reloaded = await request('/api/state', {}, responseCookie(relogin.response));
  assert.equal(reloaded.body.state.habits.length, 1);

  console.log(JSON.stringify({ ok: true, temporaryUsername: username }));
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

