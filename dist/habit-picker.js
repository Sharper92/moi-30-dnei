(function (root) {
  'use strict';

  const extraHabits = [
    ['📖', 'Читать книгу 20 минут', 'Дом и развитие'],
    ['🗣️', 'Иностранный язык 15 минут', 'Дом и развитие'],
    ['✍️', 'Записать три главных дела', 'Дом и развитие'],
    ['🎨', 'Творчество 20 минут', 'Дом и развитие'],
    ['🎧', 'Послушать обучающий подкаст', 'Дом и развитие'],
    ['📝', 'Подвести итоги дня', 'Дом и развитие'],
    ['🧩', 'Практика нового навыка', 'Дом и развитие'],
    ['🧹', 'Разобрать одну полку', 'Дом и развитие'],
    ['🤸', 'Разминка 5 минут', 'Забота о себе'],
    ['🌤️', 'Прогулка без телефона', 'Забота о себе'],
    ['🛌', 'Подготовиться ко сну заранее', 'Забота о себе'],
    ['🍎', 'Приготовить домашний завтрак', 'Забота о себе'],
    ['🫖', 'Перерыв без экрана', 'Забота о себе'],
    ['🧴', 'Уход за руками', 'Уход'],
    ['🪮', 'Уход за волосами', 'Уход'],
    ['🕯️', 'Пять минут тишины', 'Духовная практика'],
    ['🙏', 'Записать три благодарности', 'Духовная практика'],
    ['📓', 'Дневник размышлений', 'Духовная практика'],
    ['🫶', 'Доброе дело', 'Духовная практика']
  ];
  const icons = ['🌱', '📖', '💪', '🌤️', '🧘', '💧', '🎨', '📝', '🎧', '🧩', '🫶', '🛌', '🧴', '🐕', '🍎', '✨'];
  const weekdays = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
  const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[c]));
  const normalized = value => String(value).trim().toLocaleLowerCase('ru-RU').replace(/\s+/g, ' ');

  function open(options) {
    const { container, habit, currentHabits, defaults, groups, startText, startNote, onReplace } = options;
    const previousFocus = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    let mode = 'catalog';
    let chosen = null;
    let icon = '🌱';
    const selectedDays = new Set(habit.days.length ? habit.days : [0, 1, 2, 3, 4, 5, 6]);
    const usedNames = new Set(currentHabits.map(h => normalized(h.name)));
    const seen = new Set();
    const catalog = [...extraHabits, ...defaults].filter(([, name]) => {
      const key = normalized(name);
      if (seen.has(key) || usedNames.has(key)) return false;
      seen.add(key);
      return true;
    }).map(([ico, name, group]) => ({ icon: ico, name, group }));

    container.innerHTML = `<div class="modal-overlay picker-overlay">
      <section class="modal replacement-modal" role="dialog" aria-modal="true" aria-labelledby="replace-title" aria-describedby="replace-description">
        <div class="picker-heading"><div><h2 class="modal-title" id="replace-title">Заменить привычку</h2><p class="modal-sub" id="replace-description">Вместо «${escape(habit.name)}»</p></div><button type="button" class="picker-close" aria-label="Закрыть">×</button></div>
        <div class="picker-modes" aria-label="Способ выбора привычки"><button type="button" data-picker-mode="catalog" aria-pressed="true" aria-controls="picker-catalog">Из каталога</button><button type="button" data-picker-mode="custom" aria-pressed="false" aria-controls="picker-custom">Своя привычка</button></div>
        <div class="picker-body">
          <div id="picker-catalog">
            <div class="picker-filters"><label class="picker-label">Поиск<input type="search" id="picker-search" class="name-input" placeholder="Например, читать" autocomplete="off"></label><label class="picker-label">Категория<select id="picker-filter" class="name-input"><option value="">Все категории</option>${groups.map(group => `<option value="${escape(group)}">${escape(group)}</option>`).join('')}</select></label></div>
            <div id="picker-options" class="picker-options" aria-label="Каталог привычек"></div>
          </div>
          <div id="picker-custom" hidden>
            <label class="picker-label" for="picker-name">Название привычки</label><input id="picker-name" class="name-input" maxlength="130" placeholder="Например, играть на гитаре 15 минут" autocomplete="off">
            <label class="picker-label" for="picker-group">Категория</label><select id="picker-group" class="name-input">${groups.map(group => `<option value="${escape(group)}" ${group === habit.group ? 'selected' : ''}>${escape(group)}</option>`).join('')}</select>
            <div class="picker-label" id="picker-icon-label">Значок</div><div class="picker-icons" role="group" aria-labelledby="picker-icon-label">${icons.map(ico => `<button type="button" data-picker-icon="${escape(ico)}" aria-label="Значок ${escape(ico)}" aria-pressed="${ico === icon}">${escape(ico)}</button>`).join('')}</div>
          </div>
          <div class="picker-preview" aria-live="polite"><span id="picker-preview-icon" aria-hidden="true">🌱</span><div><strong id="picker-preview-name">Выбери новую привычку</strong><small id="picker-preview-group">У неё будет собственная история</small></div></div>
          <div class="picker-label" id="picker-days-label">В какие дни выполнять?</div><div class="weekdays" role="group" aria-labelledby="picker-days-label">${weekdays.map((name, i) => `<button type="button" class="weekday ${selectedDays.has((i + 1) % 7) ? 'sel' : ''}" data-picker-day="${(i + 1) % 7}" aria-pressed="${selectedDays.has((i + 1) % 7)}">${name}</button>`).join('')}</div>
          <div class="notice"><strong>${escape(startText)}</strong><div>${escape(startNote)}</div><div>Отметки и опыт прежней привычки сохранятся в истории.</div></div>
          <p id="picker-error" class="picker-error" role="alert" hidden></p>
        </div>
        <div class="picker-footer"><button type="button" id="picker-cancel" class="btn-outline">Отмена</button><button type="button" id="picker-submit" class="btn" disabled>Заменить привычку</button></div>
      </section>
    </div>`;

    const find = id => container.querySelector('#' + id);
    const modal = container.querySelector('.replacement-modal');
    document.body.style.overflow = 'hidden';

    function close(replaced = false) {
      container.innerHTML = '';
      document.body.style.overflow = previousOverflow;
      const target = replaced === true && options.focusAfterReplace ? options.focusAfterReplace() : previousFocus;
      if (target && target.isConnected) target.focus();
      else document.querySelector('#habit-settings button')?.focus();
    }
    function draft() {
      const data = mode === 'catalog' ? chosen : { name: find('picker-name').value.trim(), icon, group: find('picker-group').value };
      return data ? { ...data, days: [...selectedDays].sort() } : null;
    }
    function updatePreview() {
      const value = draft();
      find('picker-preview-name').textContent = value?.name || 'Выбери новую привычку';
      find('picker-preview-icon').textContent = value?.icon || '🌱';
      find('picker-preview-group').textContent = value?.name ? value.group : 'У неё будет собственная история';
      find('picker-submit').disabled = !value?.name || !selectedDays.size;
      find('picker-error').hidden = true;
      if (!selectedDays.size) {
        find('picker-error').textContent = 'Выбери хотя бы один день недели.';
        find('picker-error').hidden = false;
      }
    }
    function renderCatalog() {
      const query = normalized(find('picker-search').value);
      const group = find('picker-filter').value;
      const visible = catalog.map((item, i) => ({ ...item, index: i })).filter(item => (!group || item.group === group) && normalized(item.name).includes(query));
      find('picker-options').innerHTML = visible.length ? visible.map(item => `<button type="button" class="picker-option" data-picker-choice="${item.index}" aria-pressed="${chosen === catalog[item.index]}"><span aria-hidden="true">${escape(item.icon)}</span><span><strong>${escape(item.name)}</strong><small>${escape(item.group)}</small></span><span class="picker-tick" aria-hidden="true">${chosen === catalog[item.index] ? '✓' : '+'}</span></button>`).join('') : '<div class="empty">Ничего не нашлось. Попробуй другой запрос или создай свою привычку.</div>';
    }
    function setMode(next) {
      mode = next;
      find('picker-catalog').hidden = mode !== 'catalog';
      find('picker-custom').hidden = mode !== 'custom';
      container.querySelectorAll('[data-picker-mode]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.pickerMode === mode)));
      updatePreview();
      if (mode === 'custom') find('picker-name').focus();
    }

    container.querySelector('.picker-overlay').addEventListener('click', event => { if (event.target === event.currentTarget) close(); });
    container.querySelector('.picker-close').onclick = close;
    find('picker-cancel').onclick = close;
    container.querySelectorAll('[data-picker-mode]').forEach(button => { button.onclick = () => setMode(button.dataset.pickerMode); });
    find('picker-search').addEventListener('input', renderCatalog);
    find('picker-filter').addEventListener('change', renderCatalog);
    find('picker-name').addEventListener('input', updatePreview);
    find('picker-group').addEventListener('change', updatePreview);
    find('picker-options').addEventListener('click', event => {
      const button = event.target.closest('[data-picker-choice]');
      if (!button) return;
      chosen = catalog[Number(button.dataset.pickerChoice)];
      renderCatalog();
      updatePreview();
      find('picker-options').querySelector(`[data-picker-choice="${button.dataset.pickerChoice}"]`)?.focus();
    });
    container.querySelectorAll('[data-picker-icon]').forEach(button => {
      button.onclick = () => {
        icon = button.dataset.pickerIcon;
        container.querySelectorAll('[data-picker-icon]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
        updatePreview();
      };
    });
    container.querySelectorAll('[data-picker-day]').forEach(button => {
      button.onclick = () => {
        const day = Number(button.dataset.pickerDay);
        if (selectedDays.has(day)) selectedDays.delete(day); else selectedDays.add(day);
        button.classList.toggle('sel', selectedDays.has(day));
        button.setAttribute('aria-pressed', String(selectedDays.has(day)));
        updatePreview();
      };
    });
    find('picker-submit').onclick = () => {
      const value = draft();
      if (!value || !value.name || !value.days.length) return;
      if (usedNames.has(normalized(value.name))) {
        find('picker-error').textContent = 'Такая привычка уже есть в плане. Выбери другую или уточни название.';
        find('picker-error').hidden = false;
        return;
      }
      try {
        if (onReplace(value) !== false) close(true);
      } catch (error) {
        find('picker-error').textContent = error.message || 'Не удалось заменить привычку. Попробуй ещё раз.';
        find('picker-error').hidden = false;
      }
    };
    modal.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); close(); return; }
      if (event.key !== 'Tab') return;
      const focusable = [...modal.querySelectorAll('button, input, select, textarea')].filter(element => !element.disabled && !element.closest('[hidden]'));
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    });
    renderCatalog();
    find('picker-search').focus();
  }

  root.HabitPicker = Object.freeze({ open });
})(globalThis);
