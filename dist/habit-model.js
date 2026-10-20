(function (root) {
  'use strict';

  const GROUPS = ['Забота о себе', 'Уход', 'Духовная практика', 'Дом и развитие'];
  const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
  const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const isId = value => Number.isSafeInteger(value) && value >= 0;

  function isDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const [year, month, day] = value.split('-').map(Number);
    if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31) return false;
    const date = new Date(0);
    date.setUTCHours(0, 0, 0, 0);
    date.setUTCFullYear(year, month - 1, day);
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  }

  function nextDate(value) {
    const date = new Date(value + 'T12:00:00.000Z');
    date.setUTCDate(date.getUTCDate() + 1);
    const result = date.toISOString().slice(0, 10);
    if (!isDate(result)) throw new Error('Не удалось определить дату начала новой привычки.');
    return result;
  }

  function iconText(value) {
    const input = typeof value === 'string' ? value.trim() : '';
    let icon = '';
    // Keep complete Unicode code points while respecting the 16-character field limit.
    for (const character of input) {
      if (icon.length + character.length > 16) break;
      icon += character;
    }
    return icon || '🌱';
  }

  function validName(value) {
    return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 130;
  }

  function validDays(value) {
    return Array.isArray(value) && value.every(day => Number.isInteger(day) && day >= 0 && day <= 6);
  }

  function uniqueDays(days) {
    return [...new Set(days)].sort((a, b) => a - b);
  }

  function init(defs, start) {
    if (!Array.isArray(defs) || !isDate(start)) {
      throw new Error('Не удалось создать трекер: проверьте привычки и дату начала.');
    }
    const habits = defs.map((definition, slot) => {
      if (!Array.isArray(definition) || !validName(definition[1]) || typeof definition[2] !== 'string' || !definition[2].trim()) {
        throw new Error('Некорректная исходная привычка.');
      }
      return {
        id: slot,
        slot,
        name: definition[1].trim(),
        icon: iconText(definition[0]),
        group: definition[2],
        days: [...ALL_DAYS],
        startDate: null,
        endDate: null
      };
    });
    return { version: 5, start, habits, entries: {}, reflections: {} };
  }

  function readLegacyHabits(loaded, seeds, groups) {
    const indexed = new Map();
    for (const habit of loaded.habits) {
      if (!isObject(habit) || !isId(habit.id) || habit.id >= seeds.length) continue;
      if (indexed.has(habit.id)) return null;
      indexed.set(habit.id, habit);
    }
    return seeds.map(seed => {
      const previous = indexed.get(seed.id) || {};
      return {
        ...seed,
        name: validName(previous.name) ? previous.name.trim() : seed.name,
        icon: typeof previous.icon === 'string' ? iconText(previous.icon) : seed.icon,
        group: groups.includes(previous.group) ? previous.group : seed.group,
        days: Array.isArray(previous.days)
          ? uniqueDays(previous.days.filter(day => Number.isInteger(day) && day >= 0 && day <= 6))
          : [...seed.days]
      };
    });
  }

  function validTimelines(habits, slotCount) {
    for (let slot = 0; slot < slotCount; slot++) {
      const versions = habits.filter(habit => habit.slot === slot);
      if (versions.filter(habit => habit.endDate === null).length !== 1) return false;
      // A pending replacement may itself have been replaced before its first day.
      const effective = versions.filter(habit => habit.startDate === null || habit.startDate !== habit.endDate);
      effective.sort((a, b) => {
        if (a.startDate === b.startDate) return a.id - b.id;
        if (a.startDate === null) return -1;
        if (b.startDate === null) return 1;
        return a.startDate < b.startDate ? -1 : 1;
      });
      for (let index = 1; index < effective.length; index++) {
        const previous = effective[index - 1];
        const current = effective[index];
        if (previous.endDate === null || current.startDate === null || previous.endDate > current.startDate) return false;
      }
    }
    return true;
  }

  function readVersionedHabits(loaded, slotCount, groups) {
    const knownIds = new Set();
    const habits = [];
    for (const habit of loaded.habits) {
      if (!isObject(habit) || !isId(habit.id) || knownIds.has(habit.id)
        || !isId(habit.slot) || habit.slot >= slotCount || !validName(habit.name)
        || !groups.includes(habit.group) || !validDays(habit.days)
        || (habit.startDate !== null && !isDate(habit.startDate))
        || (habit.endDate !== null && !isDate(habit.endDate))
        || (habit.startDate !== null && habit.endDate !== null && habit.startDate > habit.endDate)) return null;
      knownIds.add(habit.id);
      habits.push({
        id: habit.id,
        slot: habit.slot,
        name: habit.name.trim(),
        icon: iconText(habit.icon),
        group: habit.group,
        days: uniqueDays(habit.days),
        startDate: habit.startDate,
        endDate: habit.endDate
      });
    }
    return validTimelines(habits, slotCount) ? habits : null;
  }

  function readEntries(source, knownIds) {
    const entries = {};
    if (!isObject(source)) return entries;
    for (const [date, entry] of Object.entries(source)) {
      if (!isDate(date) || !isObject(entry)) continue;
      const statuses = {};
      if (isObject(entry.statuses)) {
        for (const [key, status] of Object.entries(entry.statuses)) {
          const id = Number(key);
          if (/^(0|[1-9]\d*)$/.test(key) && isId(id) && knownIds.has(id) && (status === 'done' || status === 'small')) {
            statuses[key] = status;
          }
        }
      }
      entries[date] = {
        statuses,
        gentle: Boolean(entry.gentle),
        mood: [1, 2, 3, 4, 5].includes(entry.mood) ? entry.mood : null,
        note: typeof entry.note === 'string' ? entry.note : ''
      };
    }
    return entries;
  }

  function sanitize(loaded, defs, groups) {
    try {
      if (!isObject(loaded) || !Array.isArray(loaded.habits) || !isDate(loaded.start)) return null;
      if (loaded.version !== undefined && loaded.version !== 3 && loaded.version !== 4 && loaded.version !== 5) return null;
      const allowedGroups = groups === undefined ? GROUPS : groups;
      if (!Array.isArray(allowedGroups) || !allowedGroups.length
        || allowedGroups.some(group => typeof group !== 'string' || !group.trim())) return null;
      const seeds = init(Array.isArray(defs) ? defs : [], loaded.start);
      if (seeds.habits.some(habit => !allowedGroups.includes(habit.group))) return null;
      const slotCount = loaded.habits.length
        ? Math.max(...loaded.habits.map(habit => isObject(habit) && isId(habit.slot) ? habit.slot : -1)) + 1
        : 0;
      const habits = loaded.version === 3 || loaded.version === undefined
        ? (seeds.habits.length ? readLegacyHabits(loaded, seeds.habits, allowedGroups) : null)
        : readVersionedHabits(loaded, slotCount, allowedGroups);
      if (!habits) return null;
      const knownIds = new Set(habits.map(habit => habit.id));
      const reflections = isObject(loaded.reflections) || Array.isArray(loaded.reflections)
        ? Object.fromEntries(Object.entries(loaded.reflections).filter(([, value]) => typeof value === 'string'))
        : {};
      return {
        version: 5,
        start: loaded.start,
        habits,
        entries: readEntries(loaded.entries, knownIds),
        reflections
      };
    } catch (error) {
      return null;
    }
  }

  function currentHabits(state) {
    if (!state || !Array.isArray(state.habits)) return [];
    return state.habits.filter(habit => habit.endDate === null).sort((a, b) => a.slot - b.slot || a.id - b.id);
  }

  function isEffectiveOn(habit, date) {
    if (!habit || !isDate(date)
      || (habit.startDate !== null && !isDate(habit.startDate))
      || (habit.endDate !== null && !isDate(habit.endDate))) return false;
    return (habit.startDate === null || date >= habit.startDate) && (habit.endDate === null || date < habit.endDate);
  }

  function openHabit(state, id) {
    if (!state || !Array.isArray(state.habits) || !isId(id)) throw new Error('Привычка не найдена.');
    const habit = state.habits.find(item => item.id === id);
    if (!habit || habit.endDate !== null) throw new Error('Эта привычка уже заменена. Выберите её текущую версию.');
    return habit;
  }

  function replacementDate(state, id, today) {
    if (!isDate(today)) throw new Error('Некорректная дата замены привычки.');
    const habit = openHabit(state, id);
    if (habit.startDate !== null) {
      if (!isDate(habit.startDate)) throw new Error('Некорректная дата начала привычки.');
      if (habit.startDate > today) return habit.startDate;
    }
    const entry = state.entries && hasOwn(state.entries, today) ? state.entries[today] : null;
    const status = entry && entry.statuses && hasOwn(entry.statuses, id) ? entry.statuses[id] : null;
    return status === 'done' || status === 'small' ? nextDate(today) : today;
  }

  function replaceHabit(state, id, draft, today) {
    const previous = openHabit(state, id);
    if (!isObject(draft) || !validName(draft.name)) throw new Error('Введите название привычки длиной от 1 до 130 символов.');
    if (!GROUPS.includes(draft.group)) throw new Error('Выберите категорию привычки.');
    if (!validDays(draft.days) || !draft.days.length) throw new Error('Выберите хотя бы один день недели.');
    const startDate = replacementDate(state, id, today);
    const largestId = state.habits.reduce((largest, habit) => Math.max(largest, habit.id), -1);
    if (!isId(largestId) || !Number.isSafeInteger(largestId + 1)) throw new Error('Не удалось создать новую привычку.');
    const habit = {
      id: largestId + 1,
      slot: previous.slot,
      name: draft.name.trim(),
      icon: iconText(draft.icon),
      group: draft.group,
      days: uniqueDays(draft.days),
      startDate,
      endDate: null
    };
    const habits = state.habits.map(item => ({
      ...item,
      days: [...item.days],
      endDate: item.id === id ? startDate : item.endDate
    }));
    habits.push(habit);
    const entries = Object.fromEntries(Object.entries(state.entries || {}).map(([date, entry]) => [
      date, { ...entry, statuses: { ...entry.statuses } }
    ]));
    const nextState = {
      ...state,
      version: 5,
      habits,
      entries,
      reflections: { ...state.reflections }
    };
    return { state: nextState, habit, startDate };
  }

  function addHabit(state, draft, today) {
    if (!state || !Array.isArray(state.habits) || !isDate(today)) throw new Error('Не удалось добавить привычку.');
    if (!isObject(draft) || !validName(draft.name)) throw new Error('Введите название привычки длиной от 1 до 130 символов.');
    if (!GROUPS.includes(draft.group)) throw new Error('Выберите категорию привычки.');
    if (!validDays(draft.days) || !draft.days.length) throw new Error('Выберите хотя бы один день недели.');
    const largestId = state.habits.reduce((largest, habit) => Math.max(largest, habit.id), -1);
    const largestSlot = state.habits.reduce((largest, habit) => Math.max(largest, habit.slot), -1);
    if (!Number.isSafeInteger(largestId + 1) || !Number.isSafeInteger(largestSlot + 1)) throw new Error('Не удалось создать новую привычку.');
    const habit = {
      id: largestId + 1,
      slot: largestSlot + 1,
      name: draft.name.trim(),
      icon: iconText(draft.icon),
      group: draft.group,
      days: uniqueDays(draft.days),
      startDate: today,
      endDate: null
    };
    return {
      state: {
        ...state,
        version: 5,
        habits: [...state.habits.map(item => ({ ...item, days: [...item.days] })), habit],
        entries: Object.fromEntries(Object.entries(state.entries || {}).map(([date, entry]) => [date, { ...entry, statuses: { ...entry.statuses } }])),
        reflections: { ...state.reflections }
      },
      habit
    };
  }

  const api = { init, sanitize, currentHabits, isEffectiveOn, replacementDate, replaceHabit, addHabit };
  root.HabitModel = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis === 'object' ? globalThis : this);
