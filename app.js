const STORAGE_KEY = 'learning-progress-data';

/** @typedef {{ id: string, title: string, note: string, completed: boolean, completedAt: string | null, createdAt: string }} TaskNode */
/** @typedef {{ id: string, title: string, description: string, category: string, deadline: string, color: string, tasks: TaskNode[], createdAt: string, updatedAt: string }} Goal */

/** @type {{ goals: Goal[], filter: string }} */
let state = {
  goals: [],
  filter: 'all',
};

let editingGoalId = null;
let detailGoalId = null;
/** @type {TaskNode[]} */
let editingTasks = [];
let draggedGoalId = null;

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

function uid() {
  return crypto.randomUUID();
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function migrateGoal(goal) {
  const base = {
    id: goal.id || uid(),
    title: goal.title || '',
    description: goal.description || '',
    category: goal.category || '',
    deadline: goal.deadline || '',
    color: goal.color || '#3b82f6',
    tasks: Array.isArray(goal.tasks) ? goal.tasks : [],
    createdAt: goal.createdAt || new Date().toISOString(),
    updatedAt: goal.updatedAt || new Date().toISOString(),
  };

  if (base.tasks.length === 0 && (goal.progressType || goal.target != null)) {
    const label =
      goal.progressType === 'hours'
        ? `完成 ${goal.target || 0} 小时学习目标`
        : `完成 ${goal.target || 100}% 学习目标`;
    base.tasks.push({
      id: uid(),
      title: label,
      note: '',
      completed: !!goal.completed || (goal.current >= goal.target),
      completedAt: goal.completed ? goal.updatedAt || null : null,
      createdAt: base.createdAt,
    });
  }

  return {
    ...base,
    tasks: base.tasks.map((task) => ({
      id: task.id || uid(),
      title: task.title || '',
      note: task.note || '',
      completed: !!task.completed,
      completedAt: task.completedAt || null,
      createdAt: task.createdAt || base.createdAt,
    })),
  };
}

function loadData() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const data = JSON.parse(raw);
      state.goals = Array.isArray(data.goals) ? data.goals.map(migrateGoal) : [];
    }
  } catch {
    state.goals = [];
  }
}

function saveData() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ goals: state.goals }));
}

function getTaskStats(goal) {
  const total = goal.tasks.length;
  const completed = goal.tasks.filter((t) => t.completed).length;
  const pct = total === 0 ? 0 : Math.round((completed / total) * 100);
  return { total, completed, pct };
}

function isCompleted(goal) {
  const { total, completed } = getTaskStats(goal);
  return total > 0 && completed === total;
}

function getNextTask(goal) {
  return goal.tasks.find((t) => !t.completed) || null;
}

function formatProgress(goal) {
  const { total, completed } = getTaskStats(goal);
  if (total === 0) return '尚未添加任务节点';
  return `${completed} / ${total} 节点已完成`;
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

function canReorderGoals() {
  return state.filter === 'all' && state.goals.length > 1;
}

function moveGoalToIndex(fromId, toId) {
  if (fromId === toId) return;
  const fromIdx = state.goals.findIndex((g) => g.id === fromId);
  const toIdx = state.goals.findIndex((g) => g.id === toId);
  if (fromIdx < 0 || toIdx < 0) return;

  const [item] = state.goals.splice(fromIdx, 1);
  state.goals.splice(toIdx, 0, item);
  saveData();
  renderGoals();
  showToast('顺序已更新');
}

function moveGoalByOffset(goalId, offset) {
  const idx = state.goals.findIndex((g) => g.id === goalId);
  const newIdx = idx + offset;
  if (idx < 0 || newIdx < 0 || newIdx >= state.goals.length) return;

  const [item] = state.goals.splice(idx, 1);
  state.goals.splice(newIdx, 0, item);
  saveData();
  renderGoals();
  showToast('顺序已更新');
}

function renderOrderControls(goal, index, total) {
  if (!canReorderGoals()) return '';

  return `
    <div class="goal-order-controls">
      <button type="button" class="drag-handle" draggable="true" data-id="${goal.id}" aria-label="拖动调整顺序" title="拖动调整顺序">⋮⋮</button>
      <div class="order-actions">
        <button type="button" class="icon-btn move-up-btn" data-id="${goal.id}" aria-label="上移" title="上移" ${index === 0 ? 'disabled' : ''}>↑</button>
        <button type="button" class="icon-btn move-down-btn" data-id="${goal.id}" aria-label="下移" title="下移" ${index === total - 1 ? 'disabled' : ''}>↓</button>
      </div>
    </div>
  `;
}

function updateSortHint() {
  const hint = $('#sort-hint');
  if (hint) hint.hidden = !canReorderGoals();
}

function renderStats() {
  const total = state.goals.length;
  const active = state.goals.filter((g) => !isCompleted(g)).length;
  const completed = state.goals.filter((g) => isCompleted(g)).length;
  const doneTasks = state.goals.reduce(
    (sum, g) => sum + g.tasks.filter((t) => t.completed).length,
    0
  );

  $('#stats-bar').innerHTML = `
    <div class="stat-card"><div class="stat-label">全部目标</div><div class="stat-value">${total}</div></div>
    <div class="stat-card"><div class="stat-label">进行中</div><div class="stat-value">${active}</div></div>
    <div class="stat-card"><div class="stat-label">已完成</div><div class="stat-value">${completed}</div></div>
    <div class="stat-card"><div class="stat-label">已完成节点</div><div class="stat-value">${doneTasks}</div></div>
  `;
}

function renderTaskPreview(goal) {
  if (goal.tasks.length === 0) {
    return `<div class="card-no-tasks">还没有任务节点，点击下方「任务节点」添加</div>`;
  }

  const preview = goal.tasks.slice(0, 3);
  const more = goal.tasks.length - preview.length;

  return `
    <div class="card-task-preview">
      ${preview
        .map(
          (task) => `
        <div class="card-task-item${task.completed ? ' done' : ''}">
          <span class="card-task-dot" aria-hidden="true">${task.completed ? '✓' : '○'}</span>
          <span>${escapeHtml(task.title)}</span>
        </div>
      `
        )
        .join('')}
      ${more > 0 ? `<div class="card-task-more">还有 ${more} 个节点…</div>` : ''}
    </div>
  `;
}

function renderGoals() {
  const goals = filteredGoals();
  const grid = $('#goals-grid');
  const empty = $('#empty-state');

  if (state.goals.length === 0) {
    grid.innerHTML = '';
    empty.hidden = false;
    updateSortHint();
    return;
  }

  empty.hidden = true;

  if (goals.length === 0) {
    grid.innerHTML = `<p class="no-logs">当前筛选下没有目标</p>`;
    updateSortHint();
    return;
  }

  grid.innerHTML = goals
    .map((goal, index) => {
      const { pct } = getTaskStats(goal);
      const done = isCompleted(goal);
      const dl = formatDeadline(goal.deadline);
      const nextTask = getNextTask(goal);
      return `
        <article class="goal-card${done ? ' completed' : ''}" data-id="${goal.id}" style="--goal-color:${goal.color}">
          <div class="goal-card-top">
            <div class="goal-title-wrap">
              ${renderOrderControls(goal, index, goals.length)}
              <h3 class="goal-title">${escapeHtml(goal.title)}</h3>
            </div>
            ${goal.category ? `<span class="goal-category">${escapeHtml(goal.category)}</span>` : ''}
          </div>
          ${goal.description ? `<p class="goal-desc">${escapeHtml(goal.description)}</p>` : ''}
          ${renderTaskPreview(goal)}
          <div class="progress-wrap">
            <div class="progress-meta">
              <span>${formatProgress(goal)}</span>
              <span>${pct}%</span>
            </div>
            <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
          </div>
          ${
            nextTask
              ? `<p class="next-task">下一节点：${escapeHtml(nextTask.title)}</p>`
              : goal.tasks.length === 0
                ? `<p class="next-task muted">添加任务节点后开始追踪</p>`
                : `<p class="next-task done">全部节点已完成 🎉</p>`
          }
          <div class="goal-footer">
            ${dl ? `<span class="deadline${dl.overdue ? ' overdue' : ''}">${dl.text}</span>` : '<span></span>'}
            <div class="card-actions">
              <button type="button" class="btn btn-primary btn-sm tasks-btn" data-id="${goal.id}">任务节点</button>
              <button type="button" class="btn btn-ghost btn-sm edit-btn" data-id="${goal.id}">编辑</button>
            </div>
          </div>
        </article>
      `;
    })
    .join('');

  updateSortHint();
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

function renderGoalTaskRows() {
  const list = $('#goal-task-list');
  if (editingTasks.length === 0) {
    list.innerHTML = `<p class="task-empty-hint">还没有节点，点击下方按钮添加</p>`;
    return;
  }

  list.innerHTML = editingTasks
    .map(
      (task, index) => `
      <div class="task-row" data-id="${task.id}">
        <span class="task-index">${index + 1}</span>
        <input type="text" class="task-row-input" value="${escapeHtml(task.title)}" maxlength="80" placeholder="例如：看完第 3 章" />
        <button type="button" class="icon-btn remove-task-row-btn" aria-label="删除节点">✕</button>
      </div>
    `
    )
    .join('');
}

function openGoalModal(goal = null) {
  editingGoalId = goal?.id ?? null;
  const form = $('#goal-form');
  form.reset();

  $('#goal-modal-title').textContent = goal ? '编辑目标' : '新建目标';
  $('#delete-goal-btn').hidden = !goal;

  editingTasks = goal
    ? goal.tasks.map((t) => ({ ...t }))
    : [{ id: uid(), title: '', note: '', completed: false, completedAt: null, createdAt: new Date().toISOString() }];

  if (goal) {
    form.title.value = goal.title;
    form.description.value = goal.description;
    form.category.value = goal.category;
    form.deadline.value = goal.deadline;
    form.color.value = goal.color;
  } else {
    form.color.value = '#3b82f6';
  }

  renderGoalTaskRows();
  $('#goal-modal').showModal();
}

function collectTasksFromForm() {
  const rows = $$('#goal-task-list .task-row');
  const now = new Date().toISOString();
  const existingMap = new Map(editingTasks.map((t) => [t.id, t]));

  return [...rows]
    .map((row) => {
      const id = row.dataset.id;
      const title = row.querySelector('.task-row-input').value.trim();
      const existing = existingMap.get(id);
      if (!title) return null;
      return {
        id,
        title,
        note: existing?.note || '',
        completed: existing?.completed || false,
        completedAt: existing?.completedAt || null,
        createdAt: existing?.createdAt || now,
      };
    })
    .filter(Boolean);
}

function openDetailModal(goalId) {
  detailGoalId = goalId;
  renderDetailModal();
  $('#detail-modal').showModal();
}

function renderDetailModal() {
  const goal = state.goals.find((g) => g.id === detailGoalId);
  if (!goal) return;

  const { pct } = getTaskStats(goal);
  const pending = goal.tasks.filter((t) => !t.completed);
  const done = goal.tasks.filter((t) => t.completed);

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
    <div class="task-panel">
      <div class="task-panel-head">
        <h4>任务节点</h4>
        <span class="task-panel-count">${goal.tasks.length} 个</span>
      </div>
      <form class="detail-add-task" id="detail-add-task-form">
        <input type="text" name="title" maxlength="80" placeholder="添加新任务节点…" required />
        <button type="submit" class="btn btn-primary btn-sm">添加</button>
      </form>
      ${
        pending.length
          ? `<div class="task-group">
              <div class="task-group-label">待完成 (${pending.length})</div>
              ${pending.map((task) => renderDetailTaskItem(goal, task)).join('')}
            </div>`
          : ''
      }
      ${
        done.length
          ? `<div class="task-group">
              <div class="task-group-label">已完成 (${done.length})</div>
              ${done.map((task) => renderDetailTaskItem(goal, task)).join('')}
            </div>`
          : ''
      }
      ${goal.tasks.length === 0 ? '<p class="no-logs">还没有任务节点，在上方输入框添加第一个吧</p>' : ''}
    </div>
  `;
}

function renderDetailTaskItem(goal, task) {
  return `
    <div class="task-item${task.completed ? ' completed' : ''}" data-task-id="${task.id}">
      <label class="task-check">
        <input type="checkbox" class="task-toggle" data-goal-id="${goal.id}" data-task-id="${task.id}" ${task.completed ? 'checked' : ''} />
        <span class="task-checkmark"></span>
      </label>
      <div class="task-body">
        <span class="task-title">${escapeHtml(task.title)}</span>
        ${task.completed && task.completedAt ? `<span class="task-done-date">完成于 ${task.completedAt.slice(0, 10)}</span>` : ''}
      </div>
      <button type="button" class="icon-btn delete-task-btn" data-goal-id="${goal.id}" data-task-id="${task.id}" aria-label="删除节点">✕</button>
    </div>
  `;
}

function handleGoalSubmit(e) {
  e.preventDefault();
  const form = e.target;
  const now = new Date().toISOString();
  const tasks = collectTasksFromForm();

  const data = {
    title: form.title.value.trim(),
    description: form.description.value.trim(),
    category: form.category.value.trim(),
    deadline: form.deadline.value,
    color: form.color.value,
    tasks,
    updatedAt: now,
  };

  if (editingGoalId) {
    const idx = state.goals.findIndex((g) => g.id === editingGoalId);
    if (idx >= 0) {
      state.goals[idx] = {
        ...state.goals[idx],
        ...data,
      };
      showToast('目标已更新');
    }
  } else {
    state.goals.unshift({
      id: uid(),
      ...data,
      createdAt: now,
    });
    showToast('目标已创建');
  }

  saveData();
  render();
  $('#goal-modal').close();
}

function toggleTask(goalId, taskId, completed) {
  const goal = state.goals.find((g) => g.id === goalId);
  if (!goal) return;

  const task = goal.tasks.find((t) => t.id === taskId);
  if (!task) return;

  task.completed = completed;
  task.completedAt = completed ? todayStr() : null;
  goal.updatedAt = new Date().toISOString();

  saveData();
  render();
  if ($('#detail-modal').open) renderDetailModal();
  showToast(completed ? '节点已完成' : '已标记为未完成');
}

function addTaskToGoal(goalId, title) {
  const goal = state.goals.find((g) => g.id === goalId);
  if (!goal || !title.trim()) return;

  goal.tasks.push({
    id: uid(),
    title: title.trim(),
    note: '',
    completed: false,
    completedAt: null,
    createdAt: new Date().toISOString(),
  });
  goal.updatedAt = new Date().toISOString();

  saveData();
  render();
  if ($('#detail-modal').open) renderDetailModal();
  showToast('任务节点已添加');
}

function deleteTask(goalId, taskId) {
  const goal = state.goals.find((g) => g.id === goalId);
  if (!goal) return;

  goal.tasks = goal.tasks.filter((t) => t.id !== taskId);
  goal.updatedAt = new Date().toISOString();

  saveData();
  render();
  if ($('#detail-modal').open) renderDetailModal();
  showToast('任务节点已删除');
}

function deleteGoal() {
  if (!editingGoalId) return;
  if (!confirm('确定删除这个目标及其所有任务节点吗？')) return;

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

  $('#add-task-row-btn').addEventListener('click', () => {
    editingTasks.push({
      id: uid(),
      title: '',
      note: '',
      completed: false,
      completedAt: null,
      createdAt: new Date().toISOString(),
    });
    renderGoalTaskRows();
    const inputs = $$('#goal-task-list .task-row-input');
    inputs[inputs.length - 1]?.focus();
  });

  $('#goal-task-list').addEventListener('click', (e) => {
    const btn = e.target.closest('.remove-task-row-btn');
    if (!btn) return;
    const row = btn.closest('.task-row');
    editingTasks = editingTasks.filter((t) => t.id !== row.dataset.id);
    renderGoalTaskRows();
  });

  $('#goal-task-list').addEventListener('input', (e) => {
    if (!e.target.classList.contains('task-row-input')) return;
    const row = e.target.closest('.task-row');
    const task = editingTasks.find((t) => t.id === row.dataset.id);
    if (task) task.title = e.target.value;
  });

  $('#close-goal-modal').addEventListener('click', () => $('#goal-modal').close());
  $('#cancel-goal-btn').addEventListener('click', () => $('#goal-modal').close());
  $('#delete-goal-btn').addEventListener('click', deleteGoal);

  $('#close-detail-modal').addEventListener('click', () => $('#detail-modal').close());

  $('#detail-body').addEventListener('submit', (e) => {
    if (e.target.id !== 'detail-add-task-form') return;
    e.preventDefault();
    const input = e.target.querySelector('input[name="title"]');
    addTaskToGoal(detailGoalId, input.value);
    input.value = '';
  });

  $('#detail-body').addEventListener('change', (e) => {
    if (!e.target.classList.contains('task-toggle')) return;
    toggleTask(e.target.dataset.goalId, e.target.dataset.taskId, e.target.checked);
  });

  $('#detail-body').addEventListener('click', (e) => {
    const btn = e.target.closest('.delete-task-btn');
    if (!btn) return;
    if (!confirm('确定删除这个任务节点吗？')) return;
    deleteTask(btn.dataset.goalId, btn.dataset.taskId);
  });

  $('#goals-grid').addEventListener('click', (e) => {
    const moveUpBtn = e.target.closest('.move-up-btn');
    const moveDownBtn = e.target.closest('.move-down-btn');
    const tasksBtn = e.target.closest('.tasks-btn');
    const editBtn = e.target.closest('.edit-btn');
    const card = e.target.closest('.goal-card');

    if (moveUpBtn) {
      e.stopPropagation();
      moveGoalByOffset(moveUpBtn.dataset.id, -1);
      return;
    }
    if (moveDownBtn) {
      e.stopPropagation();
      moveGoalByOffset(moveDownBtn.dataset.id, 1);
      return;
    }
    if (tasksBtn) {
      e.stopPropagation();
      openDetailModal(tasksBtn.dataset.id);
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

  const grid = $('#goals-grid');

  grid.addEventListener('dragstart', (e) => {
    const handle = e.target.closest('.drag-handle');
    if (!handle || !canReorderGoals()) return;

    draggedGoalId = handle.dataset.id;
    const card = handle.closest('.goal-card');
    card?.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', draggedGoalId);
  });

  grid.addEventListener('dragend', (e) => {
    draggedGoalId = null;
    $$('.goal-card').forEach((card) => card.classList.remove('dragging', 'drag-over'));
  });

  grid.addEventListener('dragover', (e) => {
    if (!draggedGoalId || !canReorderGoals()) return;
    const card = e.target.closest('.goal-card');
    if (!card || card.dataset.id === draggedGoalId) return;

    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    $$('.goal-card').forEach((el) => el.classList.remove('drag-over'));
    card.classList.add('drag-over');
  });

  grid.addEventListener('dragleave', (e) => {
    const card = e.target.closest('.goal-card');
    if (card) card.classList.remove('drag-over');
  });

  grid.addEventListener('drop', (e) => {
    if (!draggedGoalId || !canReorderGoals()) return;
    const card = e.target.closest('.goal-card');
    if (!card) return;

    e.preventDefault();
    moveGoalToIndex(draggedGoalId, card.dataset.id);
    draggedGoalId = null;
    $$('.goal-card').forEach((el) => el.classList.remove('drag-over', 'dragging'));
  });
}

function setupPWA() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').then((reg) => {
      reg.addEventListener('updatefound', () => {
        const worker = reg.installing;
        worker?.addEventListener('statechange', () => {
          if (worker.state === 'activated' && navigator.serviceWorker.controller) {
            $('#update-banner').hidden = false;
          }
        });
      });
    }).catch(() => {});
  }

  $('#reload-app-btn')?.addEventListener('click', () => {
    window.location.reload();
  });

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
