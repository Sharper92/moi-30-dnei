(function (root) {
  'use strict';

  let api;
  let toast;
  let currentUser = null;
  let overview = null;
  let initialized = false;

  const $ = id => document.getElementById(id);
  const escapeHtml = value => String(value ?? '').replace(/[&<>'"]/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  })[character]);

  function dateText(value) {
    if (!value) return 'ещё не входил(а)';
    const date = new Date(String(value).replace(' ', 'T') + 'Z');
    return Number.isNaN(date.getTime()) ? 'дата неизвестна' : date.toLocaleString('ru-RU', {
      day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'
    });
  }

  function setLoading(loading) {
    $('admin-loading').hidden = !loading;
    $('admin-content').hidden = loading;
  }

  function render() {
    if (!overview) return;
    const stats = overview.stats;
    $('admin-metrics').innerHTML = [
      ['Сейчас активны', stats.active24, 'за последние 24 часа'],
      ['За неделю', stats.active7, 'за последние 7 дней'],
      ['За месяц', stats.active30, 'за последние 30 дней'],
      ['Всего', stats.total, 'обычных пользователей']
    ].map(([label, value, note]) => `<div class="admin-metric"><small>${label}</small><b>${value}</b><span>${note}</span></div>`).join('');

    $('admin-users').innerHTML = overview.users.length ? overview.users.map(user => `
      <div class="admin-user">
        <div class="admin-user-main"><strong>${escapeHtml(user.username)}</strong>
          <small>Последний вход: ${escapeHtml(dateText(user.lastSeenAt))}</small>
          <small>${user.pushDevices ? `Push: ${user.pushDevices} ${user.pushDevices === 1 ? 'устройство' : 'устройства'}` : 'Push не подключён'}${user.mustChangePassword ? ' · ждёт смены пароля' : ''}</small>
        </div>
        <div class="admin-user-actions">
          <button class="btn-outline btn-small" type="button" data-admin-reset="${escapeHtml(user.id)}" data-admin-name="${escapeHtml(user.username)}">Сбросить пароль</button>
          <button class="btn-danger btn-small" type="button" data-admin-delete="${escapeHtml(user.id)}" data-admin-name="${escapeHtml(user.username)}">Удалить</button>
        </div>
      </div>`).join('') : '<div class="empty">Пользователей пока нет.</div>';

    const settings = overview.pushSettings;
    $('admin-max-weekly').value = settings.maxWeekly;
    $('admin-inactivity-days').value = settings.inactivityDays;
    $('admin-support-delay').value = settings.supportDelayHours;
    $('admin-support-enabled').checked = settings.supportEnabled;
    $('admin-inactive-enabled').checked = settings.inactiveEnabled;

    const pushUsers = overview.users.filter(user => user.pushDevices > 0);
    $('admin-push-recipient').innerHTML = '<option value="all">Все пользователи с Push</option>' + pushUsers.map(user =>
      `<option value="${escapeHtml(user.id)}">${escapeHtml(user.username)} · ${user.pushDevices} устр.</option>`
    ).join('');
    $('admin-push-audience').textContent = pushUsers.length
      ? `Push подключён у ${pushUsers.length} из ${overview.users.length} пользователей.`
      : 'Ни у одного пользователя Push пока не подключён.';
  }

  async function load() {
    if (!currentUser || currentUser.role !== 'admin') return;
    setLoading(true);
    $('admin-error').textContent = '';
    try {
      overview = await api.adminOverview();
      render();
    } catch (error) {
      $('admin-error').textContent = 'Не удалось загрузить панель администратора.';
    } finally {
      setLoading(false);
    }
  }

  async function createUser(event) {
    event.preventDefault();
    const input = $('admin-new-username');
    const button = $('admin-create-submit');
    $('admin-create-error').textContent = '';
    $('admin-created-credentials').hidden = true;
    button.disabled = true;
    try {
      const result = await api.adminCreateUser(input.value.trim());
      $('admin-created-login').textContent = result.user.username;
      $('admin-created-password').textContent = result.temporaryPassword;
      $('admin-created-credentials').hidden = false;
      input.value = '';
      toast('Пользователь создан');
      await load();
      $('admin-created-login').textContent = result.user.username;
      $('admin-created-password').textContent = result.temporaryPassword;
      $('admin-created-credentials').hidden = false;
    } catch (error) {
      $('admin-create-error').textContent = error?.code === 'USERNAME_TAKEN'
        ? 'Такой логин уже занят.' : error?.code === 'INVALID_USERNAME'
          ? 'Логин: от 3 до 32 букв, цифр или символов _ . -' : 'Не удалось создать пользователя.';
    } finally {
      button.disabled = false;
    }
  }

  async function deleteUser(button) {
    const username = button.dataset.adminName;
    if (!confirm(`Удалить пользователя «${username}» вместе со всеми привычками и прогрессом?`)) return;
    button.disabled = true;
    try {
      await api.adminDeleteUser(button.dataset.adminDelete);
      toast('Пользователь удалён');
      await load();
    } catch (error) {
      toast('Не удалось удалить пользователя');
      button.disabled = false;
    }
  }

  async function resetPassword(button) {
    const username = button.dataset.adminName;
    if (!confirm(`Сбросить пароль пользователя «${username}»? На всех его устройствах будет выполнен выход.`)) return;
    button.disabled = true;
    try {
      const result = await api.adminResetPassword(button.dataset.adminReset);
      $('admin-reset-login').textContent = result.user.username;
      $('admin-reset-password').textContent = result.temporaryPassword;
      $('admin-reset-credentials').hidden = false;
      toast('Временный пароль создан');
      await load();
    } catch (error) {
      toast('Не удалось сбросить пароль');
      button.disabled = false;
    }
  }

  async function saveSettings(event) {
    event.preventDefault();
    const button = $('admin-push-settings-submit');
    button.disabled = true;
    $('admin-push-settings-error').textContent = '';
    try {
      const result = await api.adminSavePushSettings({
        maxWeekly: Number($('admin-max-weekly').value),
        inactivityDays: Number($('admin-inactivity-days').value),
        supportDelayHours: Number($('admin-support-delay').value),
        supportEnabled: $('admin-support-enabled').checked,
        inactiveEnabled: $('admin-inactive-enabled').checked
      });
      overview.pushSettings = result.pushSettings;
      toast('Настройки уведомлений сохранены');
    } catch (error) {
      $('admin-push-settings-error').textContent = 'Проверь значения и попробуй снова.';
    } finally {
      button.disabled = false;
    }
  }

  async function sendPush(event) {
    event.preventDefault();
    const button = $('admin-push-send');
    const title = $('admin-push-title').value.trim();
    const message = $('admin-push-message').value.trim();
    const recipient = $('admin-push-recipient').value;
    $('admin-push-result').textContent = '';
    button.disabled = true;
    try {
      const result = await api.adminSendPush(recipient, title, message);
      $('admin-push-result').textContent = result.successfulUsers
        ? `Отправлено: ${result.successfulUsers} пользователям, ${result.successfulDevices} устройствам.`
        : 'Сообщение не отправлено: у выбранных пользователей нет активной Push-подписки.';
      if (result.successfulUsers) {
        $('admin-push-title').value = '';
        $('admin-push-message').value = '';
      }
      await load();
    } catch (error) {
      $('admin-push-result').textContent = 'Не удалось отправить сообщение. Проверь текст и попробуй снова.';
    } finally {
      button.disabled = false;
    }
  }

  function init(apiClient, showToast) {
    api = apiClient;
    toast = showToast;
    if (initialized) return;
    initialized = true;
    $('admin-create-form').addEventListener('submit', createUser);
    $('admin-push-settings-form').addEventListener('submit', saveSettings);
    $('admin-push-form').addEventListener('submit', sendPush);
    $('admin-users').addEventListener('click', event => {
      const resetButton = event.target.closest('[data-admin-reset]');
      if (resetButton) { resetPassword(resetButton); return; }
      const deleteButton = event.target.closest('[data-admin-delete]');
      if (deleteButton) deleteUser(deleteButton);
    });
    $('admin-refresh').addEventListener('click', load);
  }

  function setUser(user) {
    currentUser = user;
    const isAdmin = user?.role === 'admin';
    $('admin-nav').classList.toggle('hidden', !isAdmin);
    $('main-nav-inner').classList.toggle('has-admin', isAdmin);
    if (!isAdmin) {
      overview = null;
      $('tab-admin').classList.remove('active');
    }
  }

  root.Moi30Admin = Object.freeze({ init, setUser, load });
})(globalThis);
