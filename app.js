const STORAGE_KEY = 'learning-progress-data';

/** @typedef {{ id: string, date: string, amount: number, note: string }} LogEntry */
/** @typedef {{ id: string, title: string, description: string, category: string, progressType: 'percent' | 'hours', target: number, current: number, deadline: string, color: string, completed: boolean, logs: LogEntry[], createdAt: string, updatedAt: string }} Goal */

/** @type {{ goals: Goal[], filter: string }} */
let state = {
  goals: [],
  filter: 'all',
};

let editingGoalId = null;
let loggingGoalId = null;
let detailGoalId = null;

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

function uid() {
  return crypto.randomUUID();
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function loadData() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const data = JSON.parse(raw);
      state.goals = Array.isArray(data.goals) ? data.goals : [];
    }
  } catch {
    state.goals = [];
  }
}

function saveData() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ goals: state.goals }));
}

function getProgress(goal) {
  if (goal.target <= 0) return 0;
  return Math.min(100, Math.round((goal.current / goal.target) * 100));
}

function isCompleted(goal) {
  return goal.completed || goal.current >= goal.target;
}

function formatProgress(goal) {
  const unit = goal.progressType === 'hours' ? '小时' : '%';
  if (goal.progressType === 'percent') {
    return `${goal.current}% / ${goal.target}%`;
  }
  return `${goal.current} / ${goal.target} ${unit}`;
}

function formatDeadline(deadline) {
  if (!deadline) return '';
  const d = new Date(deadline + 'T00:00:00');
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.ceil((d - today) / 86400000);
  const dateStr = d.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
  if (diff < 0) return { text: `已逾期 ${Math.abs(diff)} 天`, overdue: true };
  if (diff === 0) return { text: '今天截止', overdue: false };
  if (diff <= 7) return { text: `${dateStr} · 剩 ${diff} 天`, overdue: false };
  return { text: dateStr, overdue: false };
}

function showToast(msg, type = 'success') {
  const container = $('#toast-container');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => el.remove(), 2800);
}

function filteredGoals() {
  switch (state.filter) {
    case 'active':
      return state.goals.filter((g) => !isCompleted(g));
    case 'completed':
      return state.goals.filter((g) => isCompleted(g));
    default:
      return state.goals;
  }
}

function renderStats() {
  const total = state.goals.length;
  const active = state.goals.filter((g) => !isCompleted(g)).length;
  const completed = state.goals.filter((g) => isCompleted(g)).length;
  const totalHours = state.goals
    .filter((g) => g.progressType === 'hours')
    .reduce((sum, g) => sum + g.current, 0);

  $('#stats-bar').innerHTML = `
    <div class="stat-card"><div class="stat-label">全部目标</div><div class="stat-value">${total}</div></div>
    <div class="stat-card"><div class="stat-label">进行中</div><div class="stat-value">${active}</div></div>
    <div class="stat-card"><div class="stat-label">已完成</div><div class="stat-value">${completed}</div></div>
    <div class="stat-card"><div class="stat-label">累计学时</div><div class="stat-value">${totalHours}<span style="font-size:0.9rem;font-weight:400;color:var(--text-muted)"> h</span></div></div>
  `;
}

function renderGoals() {
  const goals = filteredGoals();
  const grid = $('#goals-grid');
  const empty = $('#empty-state');

  if (state.goals.length === 0) {
    grid.innerHTML = '';
    empty.hidden = false;
    return;
  }

  empty.hidden = true;

  if (goals.length === 0) {
    grid.innerHTML = `<p class="no-logs">当前筛选下没有目标</p>`;
    return;
  }

  grid.innerHTML = goals
    .map((goal) => {
      const pct = getProgress(goal);
      const done = isCompleted(goal);
      const dl = formatDeadline(goal.deadline);
      return `
        <article class="goal-card${done ? ' completed' : ''}" data-id="${goal.id}" style="--goal-color:${goal.color}">
          <div class="goal-card-top">
            <h3 class="goal-title">${escapeHtml(goal.title)}</h3>
            ${goal.category ? `<span class="goal-category">${escapeHtml(goal.category)}</span>` : ''}
          </div>
          ${goal.description ? `<p class="goal-desc">${escapeHtml(goal.description)}</p>` : ''}
          <div class="progress-wrap">
            <div class="progress-meta">
              <span>${formatProgress(goal)}</span>
              <span>${pct}%</span>
            </div>
            <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
          </div>
          <div class="goal-footer">
            ${dl ? `<span class="deadline${dl.overdue ? ' overdue' : ''}">${dl.text}</span>` : '<span></span>'}
            <div class="card-actions">
              <button type="button" class="btn btn-ghost btn-sm log-btn" data-id="${goal.id}">+ 记录</button>
              <button type="button" class="btn btn-ghost btn-sm edit-btn" data-id="${goal.id}">编辑</button>
            </div>
          </div>
        </article>
      `;
    })
    .join('');
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function render() {
  renderStats();
  renderGoals();
}

function openGoalModal(goal = null) {
  editingGoalId = goal?.id ?? null;
  const form = $('#goal-form');
  form.reset();

  $('#goal-modal-title').textContent = goal ? '编辑目标' : '新建目标';
  $('#delete-goal-btn').hidden = !goal;

  if (goal) {
    form.title.value = goal.title;
    form.description.value = goal.description;
    form.category.value = goal.category;
    form.progressType.value = goal.progressType;
    form.target.value = goal.target;
    form.current.value = goal.current;
    form.deadline.value = goal.deadline;
    form.color.value = goal.color;
  } else {
    form.color.value = '#3b82f6';
    form.target.value = form.progressType.value === 'percent' ? 100 : 50;
  }

  updateTargetLabel();
  $('#goal-modal').showModal();
}

function updateTargetLabel() {
  const type = $('#goal-form').progressType.value;
  $('#target-label').textContent = type === 'hours' ? '目标时长（小时）' : '目标百分比（%）';
  const targetInput = $('#goal-form').target;
  if (type === 'percent') {
    targetInput.max = 100;
    if (+targetInput.value > 100) targetInput.value = 100;
  } else {
    targetInput.removeAttribute('max');
  }
}

function openLogModal(goalId) {
  loggingGoalId = goalId;
  const goal = state.goals.find((g) => g.id === goalId);
  if (!goal) return;

  const form = $('#log-form');
  form.reset();
  form.date.value = todayStr();
  form.amount.value = goal.progressType === 'hours' ? 1 : 5;

  $('#log-modal-title').textContent = '记录学习';
  $('#log-goal-name').textContent = goal.title;
  $('#log-amount-label').textContent =
    goal.progressType === 'hours' ? '本次学习（小时）' : '进度增量（%）';

  $('#log-modal').showModal();
}

function openDetailModal(goalId) {
  detailGoalId = goalId;
  const goal = state.goals.find((g) => g.id === goalId);
  if (!goal) return;

  const pct = getProgress(goal);
  const logs = [...goal.logs].sort((a, b) => b.date.localeCompare(a.date));

  $('#detail-title').textContent = goal.title;
  $('#detail-body').innerHTML = `
    <div class="detail-header">
      ${goal.category ? `<span class="goal-category" style="--goal-color:${goal.color}">${escapeHtml(goal.category)}</span>` : ''}
      ${goal.description ? `<p class="detail-desc">${escapeHtml(goal.description)}</p>` : ''}
    </div>
    <div class="detail-progress" style="--goal-color:${goal.color}">
      <div class="progress-meta"><span>${formatProgress(goal)}</span><span>${pct}%</span></div>
      <div class="progress-bar" style="margin-top:0.35rem"><div class="progress-fill" style="width:${pct}%"></div></div>
    </div>
    <div class="log-list">
      <h4>学习记录 (${logs.length})</h4>
      ${
        logs.length
          ? logs
              .map(
                (log) => `
            <div class="log-item">
              <span class="log-date">${log.date}</span>
              <span class="log-amount">+${log.amount}${goal.progressType === 'hours' ? 'h' : '%'}</span>
              <span class="log-note">${escapeHtml(log.note || '—')}</span>
            </div>
          `
              )
              .join('')
          : '<p class="no-logs">还没有学习记录，点击「+ 记录」开始吧</p>'
      }
    </div>
  `;

  $('#detail-modal').showModal();
}

function handleGoalSubmit(e) {
  e.preventDefault();
  const form = e.target;
  const now = new Date().toISOString();

  const data = {
    title: form.title.value.trim(),
    description: form.description.value.trim(),
    category: form.category.value.trim(),
    progressType: form.progressType.value,
    target: Math.max(1, +form.target.value),
    current: Math.max(0, +form.current.value),
    deadline: form.deadline.value,
    color: form.color.value,
  };

  if (editingGoalId) {
    const idx = state.goals.findIndex((g) => g.id === editingGoalId);
    if (idx >= 0) {
      state.goals[idx] = {
        ...state.goals[idx],
        ...data,
        completed: data.current >= data.target,
        updatedAt: now,
      };
      showToast('目标已更新');
    }
  } else {
    state.goals.unshift({
      id: uid(),
      ...data,
      completed: data.current >= data.target,
      logs: [],
      createdAt: now,
      updatedAt: now,
    });
    showToast('目标已创建');
  }

  saveData();
  render();
  $('#goal-modal').close();
}

function handleLogSubmit(e) {
  e.preventDefault();
  const form = e.target;
  const goal = state.goals.find((g) => g.id === loggingGoalId);
  if (!goal) return;

  const amount = +form.amount.value;
  const entry = {
    id: uid(),
    date: form.date.value,
    amount,
    note: form.note.value.trim(),
  };

  goal.logs.push(entry);
  goal.current = Math.min(goal.target, goal.current + amount);
  goal.completed = goal.current >= goal.target;
  goal.updatedAt = new Date().toISOString();

  saveData();
  render();
  $('#log-modal').close();
  showToast(`已记录 +${amount}${goal.progressType === 'hours' ? ' 小时' : '%'}`);
}

function deleteGoal() {
  if (!editingGoalId) return;
  if (!confirm('确定删除这个目标及其所有记录吗？')) return;

  state.goals = state.goals.filter((g) => g.id !== editingGoalId);
  saveData();
  render();
  $('#goal-modal').close();
  showToast('目标已删除');
}

function bindEvents() {
  $('#add-goal-btn').addEventListener('click', () => openGoalModal());
  $('#empty-add-btn').addEventListener('click', () => openGoalModal());

  $$('.filter-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      $$('.filter-tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      state.filter = tab.dataset.filter;
      renderGoals();
    });
  });

  $('#goal-form').addEventListener('submit', handleGoalSubmit);
  $('#log-form').addEventListener('submit', handleLogSubmit);

  $('#goal-form').progressType.addEventListener('change', updateTargetLabel);

  $('#close-goal-modal').addEventListener('click', () => $('#goal-modal').close());
  $('#cancel-goal-btn').addEventListener('click', () => $('#goal-modal').close());
  $('#delete-goal-btn').addEventListener('click', deleteGoal);

  $('#close-log-modal').addEventListener('click', () => $('#log-modal').close());
  $('#cancel-log-btn').addEventListener('click', () => $('#log-modal').close());

  $('#close-detail-modal').addEventListener('click', () => $('#detail-modal').close());

  $('#goals-grid').addEventListener('click', (e) => {
    const logBtn = e.target.closest('.log-btn');
    const editBtn = e.target.closest('.edit-btn');
    const card = e.target.closest('.goal-card');

    if (logBtn) {
      e.stopPropagation();
      openLogModal(logBtn.dataset.id);
      return;
    }
    if (editBtn) {
      e.stopPropagation();
      const goal = state.goals.find((g) => g.id === editBtn.dataset.id);
      openGoalModal(goal);
      return;
    }
    if (card) {
      openDetailModal(card.dataset.id);
    }
  });
}

function setupPWA() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }

  let deferredPrompt = null;
  const installBtn = $('#install-btn');

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    installBtn.hidden = false;
  });

  installBtn.addEventListener('click', async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null;
    installBtn.hidden = true;
  });

  window.addEventListener('appinstalled', () => {
    installBtn.hidden = true;
    showToast('应用已安装到桌面');
  });
}

function init() {
  loadData();
  bindEvents();
  setupPWA();
  render();
}

init();
