(function (root) {
  'use strict';

  class ApiError extends Error {
    constructor(code, status, payload) {
      super(code || 'SERVER_ERROR');
      this.code = code || 'SERVER_ERROR';
      this.status = status;
      this.payload = payload;
    }
  }

  async function request(path, options = {}) {
    const response = await fetch(path, {
      credentials: 'same-origin',
      headers: options.body ? { 'Content-Type': 'application/json', ...(options.headers || {}) } : options.headers,
      ...options,
      body: options.body ? JSON.stringify(options.body) : undefined
    });
    const payload = response.status === 204 ? null : await response.json().catch(() => null);
    if (!response.ok) throw new ApiError(payload?.error, response.status, payload);
    return payload;
  }

  const api = {
    me: () => request('/api/auth/me'),
    login: (username, password) => request('/api/auth/login', { method: 'POST', body: { username, password } }),
    register: (username, password) => request('/api/auth/register', { method: 'POST', body: { username, password } }),
    logout: () => request('/api/auth/logout', { method: 'POST' }),
    changePassword: (currentPassword, newPassword) => request('/api/auth/change-password', { method: 'POST', body: { currentPassword, newPassword } }),
    loadProfile: () => request('/api/profile'),
    saveProfile: (displayName, username, currentPassword) => request('/api/profile', { method: 'PUT', body: { displayName, username, currentPassword } }),
    saveProfilePushSettings: settings => request('/api/profile/push-settings', { method: 'PUT', body: settings }),
    loadState: () => request('/api/state'),
    saveState: (state, revision) => request('/api/state', { method: 'PUT', body: { state, revision } }),
    pushConfig: () => request('/api/push/config'),
    subscribePush: (subscription, timezone) => request('/api/push/subscribe', { method: 'POST', body: { subscription, timezone } }),
    unsubscribePush: (endpoint) => request('/api/push/subscribe', { method: 'DELETE', body: { endpoint } }),
    adminOverview: () => request('/api/admin/overview'),
    adminCreateUser: (username) => request('/api/admin/users', { method: 'POST', body: { username } }),
    adminResetPassword: (userId) => request(`/api/admin/users/${encodeURIComponent(userId)}/reset-password`, { method: 'POST' }),
    adminDeleteUser: (userId) => request(`/api/admin/users/${encodeURIComponent(userId)}`, { method: 'DELETE' }),
    adminSavePushSettings: (settings) => request('/api/admin/push-settings', { method: 'PUT', body: settings }),
    adminSendPush: (recipient, title, message) => request('/api/admin/push-message', { method: 'POST', body: { recipient, title, message } }),
    ApiError
  };

  root.Moi30Api = Object.freeze(api);
})(globalThis);
