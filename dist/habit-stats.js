(function (root) {
  'use strict';

  const pad = value => String(value).padStart(2, '0');

  function dayString(date) {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }

  function localDate(value) {
    const parts = String(value || '').split('-').map(Number);
    return new Date(parts[0], parts[1] - 1, parts[2], 12);
  }

  function datePlus(value, days) {
    const date = localDate(value);
    date.setDate(date.getDate() + days);
    return dayString(date);
  }

  function dayDiff(left, right) {
    return Math.round((localDate(left) - localDate(right)) / 86400000);
  }

  function elapsed(state, today) {
    return Math.max(0, Math.min(30, dayDiff(today, state.start) + 1));
  }

  function isPlanned(state, habit, index) {
    const date = datePlus(state.start, index);
    return root.HabitModel.isEffectiveOn(habit, date) && habit.days.includes(localDate(date).getDay());
  }

  function day(state, index) {
    const key = datePlus(state.start, index);
    const entry = state.entries[key] || { statuses: {}, gentle: false };
    const planned = state.habits.filter(habit => isPlanned(state, habit, index));
    let done = 0;
    let small = 0;
    for (const habit of planned) {
      const status = entry.statuses[habit.id];
      if (status === 'done') done++;
      if (status === 'small') small++;
    }
    return { done, small, total: planned.length, active: done + small > 0, gentle: Boolean(entry.gentle) };
  }

  function all(state, today) {
    const visible = elapsed(state, today);
    let full = 0;
    let planned = 0;
    let small = 0;
    let active = 0;
    for (let index = 0; index < visible; index++) {
      const stats = day(state, index);
      full += stats.done;
      planned += stats.total;
      small += stats.small;
      if (stats.active) active++;
    }
    const xp = full * 10 + small * 3;
    return {
      visible,
      full,
      planned,
      small,
      active,
      xp,
      allFull: full,
      allSmall: small,
      pct: planned ? Math.round(100 * full / planned) : 0
    };
  }

  function streak(state, today) {
    let at = Math.min(29, dayDiff(today, state.start));
    if (at < 0) return 0;
    if (!day(state, at).active) at--;
    let count = 0;
    for (let index = at; index >= 0 && day(state, index).active; index--) count++;
    return count;
  }

  function habit(state, target, today) {
    let done = 0;
    let total = 0;
    let small = 0;
    for (let index = 0; index < elapsed(state, today); index++) {
      if (!isPlanned(state, target, index)) continue;
      total++;
      const entry = state.entries[datePlus(state.start, index)] || { statuses: {} };
      const status = entry.statuses[target.id];
      if (status === 'done') done++;
      if (status === 'small') small++;
    }
    return { done, total, small, pct: total ? Math.round(100 * done / total) : 0 };
  }

  const api = { dayString, localDate, datePlus, dayDiff, elapsed, isPlanned, day, all, streak, habit };
  root.HabitStats = Object.freeze(api);
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis === 'object' ? globalThis : this);
