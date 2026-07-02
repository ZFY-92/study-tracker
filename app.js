const APP_VERSION = '29';
const STORAGE_KEY = 'learning-progress-data';
const VERSION_KEY = 'learning-progress-app-version';

/** @typedef {{ id: string, title: string, note: string, completed: boolean, completedAt: string | null, createdAt: string }} TaskNode */
/** @typedef {{ id: string, title: string, description: string, category: string, deadline: string, color: string, tasks: TaskNode[], createdAt: string, updatedAt: string }} Goal */
/** @typedef {{ id: string, title: string, completed: boolean, completedAt: string | null, createdAt: string }} DailySubTask */
/** @typedef {{ id: string, title: string, completed: boolean, completedAt: string | null, createdAt: string, source: 'custom' | 'goal', goalId?: string, taskId?: string, carriedFrom?: string, subtasks?: DailySubTask[] }} DailyTask */

/** @typedef {{ wake?: string, bed?: string, duration?: number }} SleepDayRecord */

/** @typedef {'home' | 'goals' | 'goal-detail'} ViewName */
/** @typedef {'learning' | 'today' | 'sleep' | 'profile'} TabName */

/** @type {{ goals: Goal[], dailyTasks: Record<string, DailyTask[]>, sleepRecords: Record<string, SleepDayRecord>, tab: TabName, view: ViewName, filter: string, selectedGoalId: string | null, pinnedGoalId: string | null, selectedDailyDate: string, calendarMonth: string, carryOverDailyTasks: boolean, lastRolloverDate: string, sleepChartRange: 'week' | 'month', sleepChartType: 'wake' | 'bed' | 'duration', sleepPanel: 'record' | 'chart' | 'history', todayCalendarOpen: boolean, expandedSubtaskParentId: string | null }} */
let state = {
  goals: [],
  dailyTasks: {},
  sleepRecords: {},
  tab: 'learning',
  view: 'home',
  filter: 'all',
  selectedGoalId: null,
  pinnedGoalId: null,
  selectedDailyDate: '',
  calendarMonth: '',
  carryOverDailyTasks: true,
  lastRolloverDate: '',
  sleepChartRange: 'week',
  sleepChartType: 'wake',
  sleepPanel: 'record',
  todayCalendarOpen: false,
  expandedSubtaskParentId: null,
};

let editingGoalId = null;
/** @type {TaskNode[]} */
let editingTasks = [];
let draggedGoalId = null;
let swRegistration = null;
let deferredInstallPrompt = null;
/** @type {{ state: 'idle' | 'checking' | 'latest' | 'available' | 'error', remoteVersion: string | null, message: string }} */
let updateCheckStatus = { state: 'idle', remoteVersion: null, message: '点击下方按钮检查更新' };

const FILTER_LABELS = {
  all: '全部目标',
  active: '进行中',
  completed: '已完成',
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

function uid() {
  return crypto.randomUUID();
}

function todayStr() {
  const d = new Date();
  return dateStrFromParts(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

function yesterdayStr() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return dateStrFromParts(d.getFullYear(), d.getMonth() + 1, d.getDate());
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
      completed: !!goal.completed || goal.current >= goal.target,
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
      state.pinnedGoalId = data.pinnedGoalId || null;
      state.dailyTasks = migrateDailyTasks(data.dailyTasks);
      state.sleepRecords = migrateSleepRecords(data.sleepRecords);
      state.carryOverDailyTasks = data.carryOverDailyTasks !== false;
      state.lastRolloverDate = data.lastRolloverDate || '';
    }
  } catch {
    state.goals = [];
    state.pinnedGoalId = null;
    state.dailyTasks = {};
    state.sleepRecords = {};
    state.carryOverDailyTasks = true;
    state.lastRolloverDate = '';
  }

  syncSelectedDailyDate();

  if (state.pinnedGoalId && !state.goals.some((g) => g.id === state.pinnedGoalId)) {
    state.pinnedGoalId = null;
  }
}

function migrateDailyTasks(raw) {
  if (!raw || typeof raw !== 'object') return {};
  /** @type {Record<string, DailyTask[]>} */
  const result = {};
  for (const [date, tasks] of Object.entries(raw)) {
    if (!Array.isArray(tasks)) continue;
    result[date] = tasks.map((task) => {
      const entry = {
        id: task.id || uid(),
        title: task.title || '',
        completed: !!task.completed,
        completedAt: task.completedAt || null,
        createdAt: task.createdAt || new Date().toISOString(),
        source: task.source === 'goal' ? 'goal' : 'custom',
        goalId: task.goalId || undefined,
        taskId: task.taskId || undefined,
        carriedFrom: task.carriedFrom || undefined,
      };
      if (Array.isArray(task.subtasks) && task.subtasks.length) {
        entry.subtasks = task.subtasks.map((sub) => ({
          id: sub.id || uid(),
          title: sub.title || '',
          completed: !!sub.completed,
          completedAt: sub.completedAt || null,
          createdAt: sub.createdAt || entry.createdAt,
        }));
      }
      return entry;
    });
  }
  return result;
}

function migrateSleepRecords(raw) {
  if (!raw || typeof raw !== 'object') return {};
  /** @type {Record<string, SleepDayRecord>} */
  const result = {};
  for (const [date, record] of Object.entries(raw)) {
    if (!record || typeof record !== 'object') continue;
    const entry = {};
    if (typeof record.wake === 'string' && /^\d{2}:\d{2}$/.test(record.wake)) entry.wake = record.wake;
    if (typeof record.bed === 'string' && /^\d{2}:\d{2}$/.test(record.bed)) entry.bed = record.bed;
    if (typeof record.duration === 'number' && record.duration > 0 && record.duration <= 24 * 60) {
      entry.duration = Math.round(record.duration);
    }
    if (entry.wake || entry.bed || entry.duration != null) result[date] = entry;
  }
  return result;
}

function saveData() {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      goals: state.goals,
      pinnedGoalId: state.pinnedGoalId,
      dailyTasks: state.dailyTasks,
      sleepRecords: state.sleepRecords,
      carryOverDailyTasks: state.carryOverDailyTasks,
      lastRolloverDate: state.lastRolloverDate,
    })
  );
}

function syncSelectedDailyDate() {
  const today = todayStr();
  if (!state.selectedDailyDate || state.selectedDailyDate > today) {
    state.selectedDailyDate = today;
  }
  state.calendarMonth = state.selectedDailyDate.slice(0, 7);
}

function isDuplicateDailyTask(tasks, task) {
  return tasks.some((existing) => {
    if (task.source === 'goal' && task.goalId && task.taskId) {
      return existing.source === 'goal' && existing.goalId === task.goalId && existing.taskId === task.taskId;
    }
    return existing.source === 'custom' && existing.title.trim() === task.title.trim();
  });
}

function rolloverIncompleteDailyTasks(options = {}) {
  const { silent = false, force = false } = options;
  const today = todayStr();

  if (!state.carryOverDailyTasks) return 0;
  if (!force && state.lastRolloverDate === today) return 0;

  state.lastRolloverDate = today;

  const yesterday = yesterdayStr();
  const incomplete = (state.dailyTasks[yesterday] || []).filter((t) => !isDailyTaskDone(t));

  if (incomplete.length === 0) {
    saveData();
    return 0;
  }

  const todayTasks = ensureDailyTasks(today);
  const now = new Date().toISOString();
  let added = 0;

  for (const task of incomplete) {
    if (isDuplicateDailyTask(todayTasks, task)) continue;
    /** @type {DailyTask} */
    const entry = {
      id: uid(),
      title: task.title,
      completed: false,
      completedAt: null,
      createdAt: now,
      source: task.source,
      goalId: task.goalId,
      taskId: task.taskId,
      carriedFrom: yesterday,
    };
    if (task.subtasks?.length) {
      entry.subtasks = task.subtasks.map((sub) => ({
        id: uid(),
        title: sub.title,
        completed: false,
        completedAt: null,
        createdAt: now,
      }));
    }
    todayTasks.push(entry);
    added += 1;
  }

  saveData();

  if (added > 0 && !silent) {
    showToast(`已将昨日 ${added} 条未完成任务加入今天`);
  }

  return added;
}

function nowTimeStr() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function parseTimeToMinutes(timeStr, forBed = false) {
  const [h, m] = timeStr.split(':').map(Number);
  let mins = h * 60 + m;
  if (forBed && h < 12) mins += 24 * 60;
  return mins;
}

function formatMinutesAsTime(mins, forBed = false) {
  let value = mins;
  if (forBed && value >= 24 * 60) value -= 24 * 60;
  const h = Math.floor(value / 60) % 24;
  const m = value % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function ensureSleepRecord(date = todayStr()) {
  if (!state.sleepRecords[date]) state.sleepRecords[date] = {};
  return state.sleepRecords[date];
}

function isValidTimeStr(value) {
  return /^\d{2}:\d{2}$/.test(value);
}

function setSleepTime(date, type, time) {
  if (!isValidTimeStr(time)) {
    showToast('请输入有效时间');
    return false;
  }

  const record = ensureSleepRecord(date);
  const hadValue = !!record[type];
  record[type] = time;
  saveData();

  const label = type === 'wake' ? '起床' : '睡觉';
  showToast(hadValue ? `已更新${label}时间为 ${time}` : `已记录${label}时间 ${time}`);
  if (state.tab === 'sleep') renderSleep();
  return true;
}

function deleteSleepTime(date, type) {
  const record = state.sleepRecords[date];
  if (!record?.[type]) return;

  delete record[type];
  if (!record.wake && !record.bed && record.duration == null) {
    delete state.sleepRecords[date];
  }

  saveData();
  const labels = { wake: '起床', bed: '睡觉', duration: '睡眠时长' };
  showToast(`已删除${labels[type] || '记录'}`);
  if (state.tab === 'sleep') renderSleep();
}

function recordSleepTime(type) {
  setSleepTime(todayStr(), type, nowTimeStr());
}

function saveManualSleepTime(date, type, time) {
  if (!time) {
    showToast('请先选择时间');
    return;
  }
  setSleepTime(date, type, time);
}

function offsetDateStr(dateStr, offsetDays) {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, mo - 1, d);
  dt.setDate(dt.getDate() + offsetDays);
  return dateStrFromParts(dt.getFullYear(), dt.getMonth() + 1, dt.getDate());
}

function parseDateTimeMs(dateStr, timeStr) {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const [h, m] = timeStr.split(':').map(Number);
  return new Date(y, mo - 1, d, h, m).getTime();
}

function getSleepDurationMinutes(wakeDate) {
  const wakeRecord = state.sleepRecords[wakeDate];
  if (!wakeRecord?.wake) return null;

  const wakeTs = parseDateTimeMs(wakeDate, wakeRecord.wake);
  const candidates = [];

  const prevDate = offsetDateStr(wakeDate, -1);
  if (state.sleepRecords[prevDate]?.bed) {
    candidates.push(parseDateTimeMs(prevDate, state.sleepRecords[prevDate].bed));
  }
  if (wakeRecord.bed) {
    candidates.push(parseDateTimeMs(wakeDate, wakeRecord.bed));
  }

  let best = null;
  for (const bedTs of candidates) {
    if (bedTs >= wakeTs) continue;
    const duration = Math.round((wakeTs - bedTs) / 60000);
    if (duration >= 30 && duration <= 16 * 60 && (!best || bedTs > best.bedTs)) {
      best = { bedTs, duration };
    }
  }

  return best?.duration ?? null;
}

function getSleepDurationForDate(date) {
  const record = state.sleepRecords[date];
  if (record?.duration != null) {
    return { minutes: record.duration, source: 'manual' };
  }
  const computed = getSleepDurationMinutes(date);
  if (computed != null) return { minutes: computed, source: 'auto' };
  return null;
}

function formatDuration(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}分钟`;
  if (m === 0) return `${h}小时`;
  return `${h}小时${m}分`;
}

function formatDurationChart(minutes) {
  const h = minutes / 60;
  return Number.isInteger(h) ? `${h}h` : `${h.toFixed(1)}h`;
}

function setSleepDuration(date, hours, minutes) {
  const h = Number(hours);
  const m = Number(minutes);
  if (!Number.isFinite(h) || !Number.isFinite(m) || h < 0 || m < 0 || m >= 60) {
    showToast('请输入有效的时长');
    return false;
  }
  const total = Math.round(h * 60 + m);
  if (total <= 0 || total > 24 * 60) {
    showToast('睡眠时长应在 1 分钟到 24 小时之间');
    return false;
  }

  const record = ensureSleepRecord(date);
  const hadValue = record.duration != null;
  record.duration = total;
  saveData();
  showToast(hadValue ? `已更新睡眠时长为 ${formatDuration(total)}` : `已记录睡眠时长 ${formatDuration(total)}`);
  if (state.tab === 'sleep') renderSleep();
  return true;
}

function saveManualSleepDuration(date, hours, minutes) {
  if (hours === '' && minutes === '') {
    showToast('请先输入睡眠时长');
    return;
  }
  setSleepDuration(date, hours || 0, minutes || 0);
}

function getSleepChartDates(range = state.sleepChartRange) {
  const dates = [];

  if (range === 'week') {
    const d = new Date();
    d.setDate(d.getDate() - 6);
    for (let i = 0; i < 7; i += 1) {
      dates.push(dateStrFromParts(d.getFullYear(), d.getMonth() + 1, d.getDate()));
      d.setDate(d.getDate() + 1);
    }
    return dates;
  }

  const d = new Date();
  d.setDate(d.getDate() - 29);
  for (let i = 0; i < 30; i += 1) {
    dates.push(dateStrFromParts(d.getFullYear(), d.getMonth() + 1, d.getDate()));
    d.setDate(d.getDate() + 1);
  }
  return dates;
}

function getRecentSleepDates(limit = 14) {
  const dates = Object.keys(state.sleepRecords).filter((date) => {
    const r = state.sleepRecords[date];
    return r && (r.wake || r.bed || r.duration != null || getSleepDurationMinutes(date) != null);
  });
  dates.sort((a, b) => b.localeCompare(a));
  return dates.slice(0, limit);
}

function formatChartDateLabel(date) {
  return date === todayStr() ? '今天' : date.slice(5).replace('-', '/');
}

function formatChartPointDetail(date, kind, value) {
  const kinds = { wake: '起床', bed: '睡觉', duration: '睡眠时长' };
  const valueText = kind === 'duration' ? formatDuration(Number(value)) : value;
  return `${formatChartDateLabel(date)} · ${kinds[kind] || kind} ${valueText}`;
}

function finalizeChartRange(minM, maxM, referenceMinutes) {
  let min = minM;
  let max = maxM;
  if (referenceMinutes != null) {
    if (referenceMinutes < min) min = referenceMinutes;
    if (referenceMinutes > max) max = referenceMinutes;
  }
  const span = Math.max(max - min, 60);
  min = Math.floor((min - span * 0.15) / 30) * 30;
  max = Math.ceil((max + span * 0.15) / 30) * 30;
  return { minM: min, maxM: max, rangeM: Math.max(max - min, 30) };
}

function buildChartReferenceLine({ minutes, label, minM, rangeM, chartH, pad, width, className }) {
  const y = pad.top + chartH - ((minutes - minM) / rangeM) * chartH;
  return `
    <line x1="${pad.left}" y1="${y}" x2="${width - pad.right}" y2="${y}" class="sleep-ref-line ${className}" />
    <text x="${width - pad.right - 2}" y="${y - 4}" class="sleep-ref-label ${className}" text-anchor="end">${escapeHtml(label)}</text>
  `;
}

function buildSleepChartPoint({ cx, cy, color, date, value, kind }) {
  return `
    <g class="sleep-chart-point" data-date="${date}" data-value="${escapeHtml(value)}" data-kind="${kind}" role="button" tabindex="0" aria-label="${escapeHtml(formatChartPointDetail(date, kind, value))}">
      <circle cx="${cx}" cy="${cy}" r="12" class="sleep-chart-point-hit" />
      <circle cx="${cx}" cy="${cy}" r="4" fill="${color}" class="sleep-chart-point-dot" />
    </g>
  `;
}

function buildSleepTimeChart({ title, color, dates, field, forBed, kind, referenceTime, referenceLabel }) {
  const width = 360;
  const height = 180;
  const pad = { top: 16, right: 16, bottom: 32, left: 48 };
  const chartW = width - pad.left - pad.right;
  const chartH = height - pad.top - pad.bottom;

  const slots = dates.map((date, index) => {
    const value = state.sleepRecords[date]?.[field];
    return { date, index, value: value || null };
  });

  const plotted = slots.filter((slot) => slot.value);
  if (plotted.length === 0) {
    return `
      <article class="sleep-chart-card">
        <h4 class="sleep-chart-title">${escapeHtml(title)}</h4>
        <p class="sleep-chart-empty">暂无数据，点击上方按钮开始记录</p>
      </article>
    `;
  }

  const minuteValues = plotted.map((slot) => parseTimeToMinutes(slot.value, forBed));
  let minM = Math.min(...minuteValues);
  let maxM = Math.max(...minuteValues);
  const refMinutes = referenceTime ? parseTimeToMinutes(referenceTime, forBed) : null;
  const range = finalizeChartRange(minM, maxM, refMinutes);
  minM = range.minM;
  maxM = range.maxM;
  const rangeM = range.rangeM;

  const toX = (index) => pad.left + (dates.length <= 1 ? chartW / 2 : (index / (dates.length - 1)) * chartW);
  const toY = (mins) => pad.top + chartH - ((mins - minM) / rangeM) * chartH;

  const points = plotted
    .map((slot) => {
      const mins = parseTimeToMinutes(slot.value, forBed);
      return `${toX(slot.index)},${toY(mins)}`;
    })
    .join(' ');

  const dots = plotted
    .map((slot) => {
      const mins = parseTimeToMinutes(slot.value, forBed);
      return buildSleepChartPoint({
        cx: toX(slot.index),
        cy: toY(mins),
        color,
        date: slot.date,
        value: slot.value,
        kind,
      });
    })
    .join('');

  const refLine =
    refMinutes != null
      ? buildChartReferenceLine({
          minutes: refMinutes,
          label: referenceLabel || referenceTime,
          minM,
          rangeM,
          chartH,
          pad,
          width,
          className: kind === 'wake' ? 'wake' : 'bed',
        })
      : '';

  const yTicks = 4;
  const yLabels = Array.from({ length: yTicks + 1 }, (_, i) => {
    const mins = minM + (rangeM * i) / yTicks;
    const y = pad.top + chartH - (chartH * i) / yTicks;
    return `
      <line x1="${pad.left}" y1="${y}" x2="${width - pad.right}" y2="${y}" class="sleep-grid-line" />
      <text x="${pad.left - 8}" y="${y + 4}" class="sleep-axis-label" text-anchor="end">${formatMinutesAsTime(Math.round(mins), forBed)}</text>
    `;
  }).join('');

  const xStep = dates.length <= 7 ? 1 : Math.ceil(dates.length / 7);
  const xLabels = dates
    .map((date, index) => {
      if (index % xStep !== 0 && index !== dates.length - 1) return '';
      const label = date.slice(5).replace('-', '/');
      return `<text x="${toX(index)}" y="${height - 8}" class="sleep-axis-label" text-anchor="middle">${label}</text>`;
    })
    .join('');

  return `
    <article class="sleep-chart-card">
      <h4 class="sleep-chart-title">${escapeHtml(title)}</h4>
      <div class="sleep-chart-svg-wrap">
        <svg class="sleep-chart-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(title)}">
          ${yLabels}
          ${refLine}
          <polyline points="${points}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />
          ${dots}
          ${xLabels}
        </svg>
      </div>
      <p class="sleep-chart-detail">点击数据点查看详情</p>
    </article>
  `;
}

function buildSleepDurationChart({ dates, kind = 'duration' }) {
  const width = 360;
  const height = 180;
  const pad = { top: 16, right: 16, bottom: 32, left: 48 };
  const chartW = width - pad.left - pad.right;
  const chartH = height - pad.top - pad.bottom;

  const slots = dates.map((date, index) => {
    const info = getSleepDurationForDate(date);
    return { date, index, minutes: info?.minutes ?? null };
  });

  const plotted = slots.filter((slot) => slot.minutes != null);
  if (plotted.length === 0) {
    return `
      <article class="sleep-chart-card">
        <h4 class="sleep-chart-title">睡眠时长</h4>
        <p class="sleep-chart-empty">暂无数据，记录起床/睡觉时间或手动录入时长</p>
      </article>
    `;
  }

  const minuteValues = plotted.map((slot) => slot.minutes);
  let minM = Math.min(...minuteValues);
  let maxM = Math.max(...minuteValues);
  const span = Math.max(maxM - minM, 60);
  minM = Math.max(0, Math.floor((minM - span * 0.15) / 30) * 30);
  maxM = Math.ceil((maxM + span * 0.15) / 30) * 30;
  const rangeM = Math.max(maxM - minM, 30);

  const toX = (index) => pad.left + (dates.length <= 1 ? chartW / 2 : (index / (dates.length - 1)) * chartW);
  const toY = (mins) => pad.top + chartH - ((mins - minM) / rangeM) * chartH;

  const points = plotted.map((slot) => `${toX(slot.index)},${toY(slot.minutes)}`).join(' ');
  const dots = plotted
    .map((slot) =>
      buildSleepChartPoint({
        cx: toX(slot.index),
        cy: toY(slot.minutes),
        color: '#10b981',
        date: slot.date,
        value: String(slot.minutes),
        kind,
      })
    )
    .join('');

  const yTicks = 4;
  const yLabels = Array.from({ length: yTicks + 1 }, (_, i) => {
    const mins = minM + (rangeM * i) / yTicks;
    const y = pad.top + chartH - (chartH * i) / yTicks;
    return `
      <line x1="${pad.left}" y1="${y}" x2="${width - pad.right}" y2="${y}" class="sleep-grid-line" />
      <text x="${pad.left - 8}" y="${y + 4}" class="sleep-axis-label" text-anchor="end">${formatDurationChart(Math.round(mins))}</text>
    `;
  }).join('');

  const xStep = dates.length <= 7 ? 1 : Math.ceil(dates.length / 7);
  const xLabels = dates
    .map((date, index) => {
      if (index % xStep !== 0 && index !== dates.length - 1) return '';
      const label = date.slice(5).replace('-', '/');
      return `<text x="${toX(index)}" y="${height - 8}" class="sleep-axis-label" text-anchor="middle">${label}</text>`;
    })
    .join('');

  return `
    <article class="sleep-chart-card">
      <h4 class="sleep-chart-title">睡眠时长</h4>
      <div class="sleep-chart-svg-wrap">
        <svg class="sleep-chart-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="睡眠时长">
          ${yLabels}
          <polyline points="${points}" fill="none" stroke="#10b981" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />
          ${dots}
          ${xLabels}
        </svg>
      </div>
      <p class="sleep-chart-detail">点击数据点查看详情</p>
    </article>
  `;
}

function renderActiveSleepChart(dates) {
  switch (state.sleepChartType) {
    case 'bed':
      return buildSleepTimeChart({
        title: '睡觉时间',
        color: '#6366f1',
        dates,
        field: 'bed',
        forBed: true,
        kind: 'bed',
        referenceTime: '00:00',
        referenceLabel: '12:00',
      });
    case 'duration':
      return buildSleepDurationChart({ dates });
    default:
      return buildSleepTimeChart({
        title: '起床时间',
        color: '#f59e0b',
        dates,
        field: 'wake',
        forBed: false,
        kind: 'wake',
        referenceTime: '08:30',
        referenceLabel: '8:30',
      });
  }
}

function renderSleepHistoryCell(date, type, value) {
  const label = type === 'wake' ? '起床' : '睡觉';
  if (value) {
    return `
      <span class="sleep-history-value">
        <span class="sleep-history-time">${value}</span>
        <button type="button" class="icon-btn sleep-history-delete-btn" data-date="${date}" data-type="${type}" aria-label="删除${label}">✕</button>
      </span>
    `;
  }

  return `
    <form class="sleep-history-manual-form" data-date="${date}" data-type="${type}">
      <input type="time" required aria-label="补录${label}时间" />
      <button type="submit" class="btn btn-ghost btn-sm">保存</button>
    </form>
  `;
}

function renderSleepDurationHistoryCell(date) {
  const record = state.sleepRecords[date] || {};
  const info = getSleepDurationForDate(date);

  if (record.duration != null) {
    return `
      <span class="sleep-history-value">
        <span class="sleep-history-time">${formatDuration(record.duration)}</span>
        <button type="button" class="icon-btn sleep-history-delete-btn" data-date="${date}" data-type="duration" aria-label="删除睡眠时长">✕</button>
      </span>
    `;
  }

  if (info?.source === 'auto') {
    return `<span class="sleep-duration-auto">${formatDuration(info.minutes)}<small>自动</small></span>`;
  }

  return `
    <form class="sleep-history-duration-form" data-date="${date}">
      <input type="number" min="0" max="23" class="sleep-duration-h" placeholder="时" aria-label="小时" />
      <span class="sleep-duration-sep">时</span>
      <input type="number" min="0" max="59" class="sleep-duration-m" placeholder="分" aria-label="分钟" />
      <button type="submit" class="btn btn-ghost btn-sm">保存</button>
    </form>
  `;
}

function renderSleep() {
  const today = todayStr();
  const record = state.sleepRecords[today] || {};

  const dateEl = $('#sleep-today-date');
  if (dateEl) {
    dateEl.textContent = new Date(today.replace(/-/g, '/')).toLocaleDateString('zh-CN', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      weekday: 'long',
    });
  }

  const wakeEl = $('#sleep-wake-display');
  const bedEl = $('#sleep-bed-display');
  const wakeInput = $('#wake-manual-input');
  const bedInput = $('#bed-manual-input');
  const wakeDelete = $('#delete-wake-btn');
  const bedDelete = $('#delete-bed-btn');

  if (wakeEl) {
    wakeEl.textContent = record.wake || '—';
    wakeEl.classList.toggle('has-value', !!record.wake);
  }
  if (bedEl) {
    bedEl.textContent = record.bed || '—';
    bedEl.classList.toggle('has-value', !!record.bed);
  }
  if (wakeInput && document.activeElement !== wakeInput) {
    wakeInput.value = record.wake || '';
  }
  if (bedInput && document.activeElement !== bedInput) {
    bedInput.value = record.bed || '';
  }
  if (wakeDelete) wakeDelete.hidden = !record.wake;
  if (bedDelete) bedDelete.hidden = !record.bed;

  const durationEl = $('#sleep-duration-display');
  const durationHint = $('#sleep-duration-hint');
  const durationDelete = $('#delete-duration-btn');
  const durationHours = $('#duration-hours-input');
  const durationMinutes = $('#duration-minutes-input');
  const durationInfo = getSleepDurationForDate(today);

  if (durationEl) {
    durationEl.textContent = durationInfo ? formatDuration(durationInfo.minutes) : '—';
    durationEl.classList.toggle('has-value', !!durationInfo);
  }
  if (durationHint) {
    if (record.duration != null) {
      durationHint.textContent = '已手动录入';
    } else if (durationInfo?.source === 'auto') {
      durationHint.textContent = '根据昨早睡床与今日起床自动计算';
    } else {
      durationHint.textContent = '记录起床/睡觉后自动计算，或下方手动录入';
    }
  }
  if (durationDelete) durationDelete.hidden = record.duration == null;
  if (durationHours && document.activeElement !== durationHours && record.duration != null) {
    durationHours.value = String(Math.floor(record.duration / 60));
  }
  if (durationMinutes && document.activeElement !== durationMinutes && record.duration != null) {
    durationMinutes.value = String(record.duration % 60);
  }

  $$('.sleep-range-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.range === state.sleepChartRange);
  });

  $$('.sleep-type-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.chartType === state.sleepChartType);
  });

  $$('.sleep-subnav-btn').forEach((btn) => {
    const active = btn.dataset.sleepPanel === state.sleepPanel;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', String(active));
  });

  $$('.sleep-panel').forEach((panel) => {
    panel.hidden = panel.dataset.panel !== state.sleepPanel;
  });

  const dates = getSleepChartDates();
  const chartsEl = $('#sleep-charts');
  if (chartsEl) {
    chartsEl.innerHTML = renderActiveSleepChart(dates);
  }

  const historyCountEl = $('#sleep-history-count');
  const recent = getRecentSleepDates();

  if (historyCountEl) {
    historyCountEl.textContent = recent.length > 0 ? `${recent.length} 条` : '暂无';
  }

  const historyEl = $('#sleep-history-wrap');
  if (historyEl && state.sleepPanel === 'history') {
    if (recent.length === 0) {
      historyEl.innerHTML = '<p class="sleep-history-empty">还没有记录</p>';
    } else {
      historyEl.innerHTML = `
        <table class="sleep-history-table">
          <thead>
            <tr><th>日期</th><th>起床</th><th>睡觉</th><th>睡眠时长</th></tr>
          </thead>
          <tbody>
            ${recent
              .map((date) => {
                const r = state.sleepRecords[date];
                const label = date === today ? '今天' : date.slice(5).replace('-', '/');
                return `
                  <tr>
                    <td>${label}</td>
                    <td>${renderSleepHistoryCell(date, 'wake', r.wake)}</td>
                    <td>${renderSleepHistoryCell(date, 'bed', r.bed)}</td>
                    <td>${renderSleepDurationHistoryCell(date)}</td>
                  </tr>
                `;
              })
              .join('')}
          </tbody>
        </table>
      `;
    }
  }
}

function getSelectedDailyDate() {
  return state.selectedDailyDate;
}

function isTodaySelected() {
  return getSelectedDailyDate() === todayStr();
}

function setSelectedDailyDate(dateStr) {
  state.selectedDailyDate = dateStr;
  state.calendarMonth = dateStr.slice(0, 7);
  render();
  updateHeader();
}

function selectDateAndGoToday(dateStr) {
  state.selectedDailyDate = dateStr;
  state.calendarMonth = dateStr.slice(0, 7);
  state.todayCalendarOpen = false;
  switchTab('today');
}

function getDailyTaskProgress(task) {
  if (task.subtasks?.length) {
    return {
      total: task.subtasks.length,
      completed: task.subtasks.filter((s) => s.completed).length,
    };
  }
  return { total: 1, completed: task.completed ? 1 : 0 };
}

function isDailyTaskDone(task) {
  if (task.subtasks?.length) return task.subtasks.every((s) => s.completed);
  return task.completed;
}

function syncParentFromSubtasks(task) {
  if (!task.subtasks?.length) return;
  const allDone = task.subtasks.every((s) => s.completed);
  task.completed = allDone;
  task.completedAt = allDone ? task.completedAt || new Date().toISOString() : null;
}

function syncGoalDailyTask(task, date = getSelectedDailyDate()) {
  if (task.source !== 'goal' || !task.goalId || !task.taskId || date !== todayStr()) return;
  toggleTask(task.goalId, task.taskId, isDailyTaskDone(task), { silent: true });
}

function getDailyTasks(date = getSelectedDailyDate()) {
  return state.dailyTasks[date] || [];
}

function ensureDailyTasks(date = getSelectedDailyDate()) {
  if (!state.dailyTasks[date]) state.dailyTasks[date] = [];
  return state.dailyTasks[date];
}

function parseDateStr(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function dateStrFromParts(year, month, day) {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function formatDateShort(dateStr) {
  const d = parseDateStr(dateStr);
  return d.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' });
}

function formatDateLabel(dateStr) {
  const d = parseDateStr(dateStr);
  return d.toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'long',
  });
}

function getDailyTaskStatsForDate(date = getSelectedDailyDate()) {
  const tasks = getDailyTasks(date);
  let completed = 0;
  let total = 0;
  for (const task of tasks) {
    const p = getDailyTaskProgress(task);
    total += p.total;
    completed += p.completed;
  }
  return { completed, total };
}

function getDailyTaskDayStatus(dateStr) {
  const tasks = state.dailyTasks[dateStr];
  if (!tasks?.length) return 'none';
  let total = 0;
  let completed = 0;
  for (const task of tasks) {
    const p = getDailyTaskProgress(task);
    total += p.total;
    completed += p.completed;
  }
  if (completed === 0) return 'has';
  if (completed === total) return 'done';
  return 'partial';
}

function getTodayTasks() {
  return ensureDailyTasks(getSelectedDailyDate());
}

function isDailyTaskImported(goalId, taskId) {
  return getTodayTasks().some((t) => t.source === 'goal' && t.goalId === goalId && t.taskId === taskId);
}

function addCustomDailyTask(title) {
  const trimmed = title.trim();
  if (!trimmed) return;

  getTodayTasks().push({
    id: uid(),
    title: trimmed,
    completed: false,
    completedAt: null,
    createdAt: new Date().toISOString(),
    source: 'custom',
  });
  saveData();
  renderToday();
  showToast('已加入今日任务');
}

function importGoalTasks(items) {
  const todayTasks = getTodayTasks();
  let added = 0;

  for (const { goalId, taskId, title } of items) {
    if (isDailyTaskImported(goalId, taskId)) continue;
    todayTasks.push({
      id: uid(),
      title,
      completed: false,
      completedAt: null,
      createdAt: new Date().toISOString(),
      source: 'goal',
      goalId,
      taskId,
    });
    added += 1;
  }

  if (added === 0) {
    showToast('没有新任务可导入', 'info');
    return;
  }

  saveData();
  renderToday();
  showToast(`已导入 ${added} 条任务`);
}

function toggleDailyTask(taskId, completed) {
  const date = getSelectedDailyDate();
  const tasks = ensureDailyTasks(date);
  const task = tasks.find((t) => t.id === taskId);
  if (!task || task.subtasks?.length) return;

  task.completed = completed;
  task.completedAt = completed ? date : null;
  syncGoalDailyTask(task, date);

  saveData();
  renderToday();
  showToast(completed ? '任务已完成' : '已标记为未完成');
}

function addDailySubTask(parentId, title) {
  const trimmed = title.trim();
  if (!trimmed) return;

  const tasks = ensureDailyTasks(getSelectedDailyDate());
  const parent = tasks.find((t) => t.id === parentId);
  if (!parent) return;

  if (!parent.subtasks) parent.subtasks = [];
  parent.subtasks.push({
    id: uid(),
    title: trimmed,
    completed: false,
    completedAt: null,
    createdAt: new Date().toISOString(),
  });
  syncParentFromSubtasks(parent);
  state.expandedSubtaskParentId = null;
  saveData();
  renderToday();
  showToast('已添加子任务');
}

function toggleDailySubTask(parentId, subId, completed) {
  const date = getSelectedDailyDate();
  const tasks = ensureDailyTasks(date);
  const parent = tasks.find((t) => t.id === parentId);
  const sub = parent?.subtasks?.find((s) => s.id === subId);
  if (!sub) return;

  sub.completed = completed;
  sub.completedAt = completed ? date : null;
  syncParentFromSubtasks(parent);
  syncGoalDailyTask(parent, date);

  saveData();
  renderToday();
}

function deleteDailySubTask(parentId, subId) {
  const tasks = ensureDailyTasks(getSelectedDailyDate());
  const parent = tasks.find((t) => t.id === parentId);
  if (!parent?.subtasks) return;

  parent.subtasks = parent.subtasks.filter((s) => s.id !== subId);
  if (parent.subtasks.length === 0) delete parent.subtasks;
  syncParentFromSubtasks(parent);
  saveData();
  renderToday();
  showToast('子任务已删除');
}

function deleteDailyTask(taskId) {
  const tasks = ensureDailyTasks(getSelectedDailyDate());
  const idx = tasks.findIndex((t) => t.id === taskId);
  if (idx < 0) return;

  tasks.splice(idx, 1);
  if (tasks.length === 0) delete state.dailyTasks[getSelectedDailyDate()];
  saveData();
  renderToday();
  showToast('任务已删除');
}

function getGoalTitle(goalId) {
  return state.goals.find((g) => g.id === goalId)?.title || '未知目标';
}

function getPinnedGoal() {
  if (!state.pinnedGoalId) return null;
  return state.goals.find((g) => g.id === state.pinnedGoalId) || null;
}

function setPinnedGoal(goalId) {
  if (!goalId || state.pinnedGoalId === goalId) {
    state.pinnedGoalId = null;
    showToast('已取消首页展示');
  } else {
    state.pinnedGoalId = goalId;
    showToast('已设为首页展示');
  }
  saveData();
  render();
}

function setPinnedGoalFromSelect(goalId) {
  state.pinnedGoalId = goalId || null;
  saveData();
  render();
  if (goalId) showToast('已设为首页展示');
}

function getNextTask(goal) {
  return goal.tasks.find((t) => !t.completed) || null;
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

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
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
  return state.view === 'goals' && state.filter === 'all' && state.goals.length > 1;
}

function navigateTo(view, options = {}) {
  state.tab = 'learning';
  state.view = view;
  if (options.filter) state.filter = options.filter;
  if (options.goalId !== undefined) state.selectedGoalId = options.goalId;
  render();
}

function switchTab(tab) {
  state.tab = tab;
  if (tab === 'today' && state.selectedDailyDate > todayStr()) {
    state.selectedDailyDate = todayStr();
    state.calendarMonth = todayStr().slice(0, 7);
  }
  render();
}

function navigateToGoals(filter) {
  navigateTo('goals', { filter });
}

function navigateToGoalDetail(goalId) {
  navigateTo('goal-detail', { goalId });
}

function goBack() {
  if (state.tab !== 'learning') return;
  if (state.view === 'goal-detail') {
    navigateTo('goals');
    return;
  }
  if (state.view === 'goals') {
    navigateTo('home');
  }
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

function updateHeader() {
  const backBtn = $('#back-btn');
  const addBtn = $('#add-goal-btn');
  const editBtn = $('#edit-goal-header-btn');
  const pageTitle = $('#page-title');
  const pageSubtitle = $('#page-subtitle');

  if (state.tab === 'today') {
    backBtn.hidden = true;
    addBtn.hidden = true;
    editBtn.hidden = true;
    const selected = getSelectedDailyDate();
    const isToday = isTodaySelected();
    const { completed, total } = getDailyTaskStatsForDate(selected);
    pageTitle.textContent = isToday ? '今日任务' : '任务记录';
    pageSubtitle.textContent = total === 0
      ? (isToday ? '规划好今天要做的事' : formatDateLabel(selected))
      : `${isToday ? '今天' : formatDateLabel(selected)} · 已完成 ${completed} / ${total}`;
    pageSubtitle.hidden = false;
    return;
  }

  if (state.tab === 'sleep') {
    backBtn.hidden = true;
    addBtn.hidden = true;
    editBtn.hidden = true;
    pageTitle.textContent = '作息记录';
    const today = todayStr();
    const record = state.sleepRecords[today] || {};
    const parts = [];
    if (record.wake) parts.push(`起床 ${record.wake}`);
    if (record.bed) parts.push(`睡觉 ${record.bed}`);
    const durationInfo = getSleepDurationForDate(today);
    if (durationInfo) parts.push(`睡眠 ${formatDuration(durationInfo.minutes)}`);
    pageSubtitle.textContent = parts.length ? parts.join(' · ') : '记录每日起床、睡觉与睡眠时长';
    pageSubtitle.hidden = false;
    return;
  }

  if (state.tab === 'profile') {
    backBtn.hidden = true;
    addBtn.hidden = true;
    editBtn.hidden = true;
    pageTitle.textContent = '我的';
    pageSubtitle.textContent = '应用设置与版本';
    pageSubtitle.hidden = false;
    return;
  }

  backBtn.hidden = state.view === 'home';
  addBtn.hidden = state.view === 'goal-detail';
  editBtn.hidden = state.view !== 'goal-detail';

  if (state.view === 'home') {
    pageTitle.textContent = '学习进度';
    pageSubtitle.textContent = '用任务节点驱动每一次进步';
    pageSubtitle.hidden = false;
  } else if (state.view === 'goals') {
    pageTitle.textContent = FILTER_LABELS[state.filter] || '全部目标';
    pageSubtitle.textContent = `${filteredGoals().length} 个目标`;
    pageSubtitle.hidden = false;
  } else if (state.view === 'goal-detail') {
    const goal = state.goals.find((g) => g.id === state.selectedGoalId);
    pageTitle.textContent = goal?.title || '目标详情';
    pageSubtitle.hidden = true;
  }
}

function updateBottomNav() {
  $$('.bottom-nav-item').forEach((btn) => {
    const active = btn.dataset.tab === state.tab;
    btn.classList.toggle('active', active);
    if (active) btn.setAttribute('aria-current', 'page');
    else btn.removeAttribute('aria-current');
  });
}

function showActiveView() {
  const isLearning = state.tab === 'learning';
  $('#view-home').hidden = !isLearning || state.view !== 'home';
  $('#view-goals').hidden = !isLearning || state.view !== 'goals';
  $('#view-goal-detail').hidden = !isLearning || state.view !== 'goal-detail';
  $('#view-today').hidden = state.tab !== 'today';
  $('#view-sleep').hidden = state.tab !== 'sleep';
  $('#view-profile').hidden = state.tab !== 'profile';
  $('.main')?.classList.toggle('main-sleep', state.tab === 'sleep');
}

function renderHome() {
  const total = state.goals.length;
  const active = state.goals.filter((g) => !isCompleted(g)).length;
  const completed = state.goals.filter((g) => isCompleted(g)).length;

  const cards = [
    { filter: 'all', icon: '🎯', title: '全部目标', desc: `${total} 个学习目标`, color: '#3b82f6' },
    { filter: 'active', icon: '🚀', title: '进行中', desc: `${active} 个目标进行中`, color: '#f59e0b' },
    { filter: 'completed', icon: '✅', title: '已完成', desc: `${completed} 个目标已完成`, color: '#16a34a' },
  ];

  $('#nav-cards').innerHTML = cards
    .map(
      (card) => `
    <button type="button" class="nav-card" data-filter="${card.filter}" style="--nav-color:${card.color}">
      <div class="nav-card-icon">${card.icon}</div>
      <div class="nav-card-body">
        <h3>${card.title}</h3>
        <p>${card.desc}</p>
      </div>
      <span class="nav-card-arrow" aria-hidden="true">→</span>
    </button>
  `
    )
    .join('');

  renderHomeFeatured();
}

function renderHomeFeatured() {
  const container = $('#home-featured');
  if (!container) return;

  if (state.goals.length === 0) {
    container.innerHTML = '';
    return;
  }

  const goal = getPinnedGoal();
  const options = state.goals
    .map(
      (g) =>
        `<option value="${g.id}" ${state.pinnedGoalId === g.id ? 'selected' : ''}>${escapeHtml(g.title)}</option>`
    )
    .join('');

  let featuredCard = '';
  if (goal) {
    const { pct } = getTaskStats(goal);
    const nextTask = getNextTask(goal);
    const dl = formatDeadline(goal.deadline);
    const pendingPreview = goal.tasks.filter((t) => !t.completed).slice(0, 3);

    featuredCard = `
      <article class="featured-goal-card" data-id="${goal.id}" style="--goal-color:${goal.color}">
        <div class="featured-goal-top">
          <div>
            <h4 class="goal-title">${escapeHtml(goal.title)}</h4>
            ${goal.category ? `<span class="goal-category">${escapeHtml(goal.category)}</span>` : ''}
          </div>
          ${dl ? `<span class="deadline${dl.overdue ? ' overdue' : ''}">${dl.text}</span>` : ''}
        </div>
        ${goal.description ? `<p class="goal-desc">${escapeHtml(goal.description)}</p>` : ''}
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
              ? `<p class="next-task muted">还没有任务节点</p>`
              : `<p class="next-task done">全部节点已完成 🎉</p>`
        }
        ${
          pendingPreview.length
            ? `<div class="featured-task-preview">
                ${pendingPreview.map((task) => `<span class="featured-task-chip">${escapeHtml(task.title)}</span>`).join('')}
              </div>`
            : ''
        }
        <p class="featured-enter">点击查看任务节点 →</p>
      </article>
    `;
  }

  container.innerHTML = `
    <div class="pin-picker-section">
      <label class="pin-picker-label" for="pin-goal-select">首页展示目标</label>
      <select id="pin-goal-select" class="pin-goal-select">
        <option value="" ${!state.pinnedGoalId ? 'selected' : ''}>不展示任何目标</option>
        ${options}
      </select>
      <p class="pin-picker-hint">选择后，该目标详情会显示在首页下方</p>
    </div>
    ${featuredCard}
  `;
}

function renderGoals() {
  const goals = filteredGoals();
  const grid = $('#goals-grid');
  const empty = $('#empty-state');
  const title = $('#goals-view-title');

  if (title) title.textContent = FILTER_LABELS[state.filter] || '全部目标';

  if (state.goals.length === 0) {
    grid.innerHTML = '';
    empty.hidden = false;
    updateSortHint();
    return;
  }

  empty.hidden = true;

  if (goals.length === 0) {
    grid.innerHTML = `<p class="no-logs">当前分类下没有目标</p>`;
    updateSortHint();
    return;
  }

  grid.innerHTML = goals
    .map((goal, index) => {
      const { pct } = getTaskStats(goal);
      const done = isCompleted(goal);
      const dl = formatDeadline(goal.deadline);
      const isPinned = state.pinnedGoalId === goal.id;
      const showPin = state.filter === 'all';

      return `
        <article class="goal-card goal-card-compact${done ? ' completed' : ''}" data-id="${goal.id}" style="--goal-color:${goal.color}">
          <div class="goal-card-top">
            <div class="goal-title-wrap">
              ${renderOrderControls(goal, index, goals.length)}
              <div class="goal-title-block">
                <h3 class="goal-title">${escapeHtml(goal.title)}</h3>
                ${goal.category ? `<span class="goal-category">${escapeHtml(goal.category)}</span>` : ''}
              </div>
            </div>
            <div class="card-top-actions">
              ${
                showPin
                  ? `<button type="button" class="icon-btn pin-icon-btn${isPinned ? ' pinned' : ''}" data-id="${goal.id}" title="${isPinned ? '取消首页展示' : '设为首页展示'}" aria-label="首页展示">${isPinned ? '★' : '☆'}</button>`
                  : ''
              }
              <button type="button" class="icon-btn edit-btn" data-id="${goal.id}" aria-label="编辑" title="编辑">✎</button>
            </div>
          </div>
          <div class="progress-wrap">
            <div class="progress-meta">
              <span>${formatProgress(goal)}</span>
              <span>${pct}%</span>
            </div>
            <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
          </div>
          <div class="goal-footer">
            ${dl ? `<span class="deadline${dl.overdue ? ' overdue' : ''}">${dl.text}</span>` : '<span class="deadline muted">点击查看任务节点 →</span>'}
            ${
              showPin
                ? `<button type="button" class="btn btn-ghost btn-sm pin-btn${isPinned ? ' pinned' : ''}" data-id="${goal.id}">${isPinned ? '★ 首页展示中' : '☆ 设为首页展示'}</button>`
                : ''
            }
          </div>
        </article>
      `;
    })
    .join('');

  updateSortHint();
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

function renderGoalDetail() {
  const goal = state.goals.find((g) => g.id === state.selectedGoalId);
  const container = $('#goal-detail-body');
  if (!goal || !container) {
    navigateTo('goals');
    return;
  }

  const { pct } = getTaskStats(goal);
  const pending = goal.tasks.filter((t) => !t.completed);
  const done = goal.tasks.filter((t) => t.completed);
  const dl = formatDeadline(goal.deadline);

  container.innerHTML = `
    <div class="detail-page" style="--goal-color:${goal.color}">
      <div class="detail-header">
        <div class="detail-header-top">
          <div>
            ${goal.category ? `<span class="goal-category">${escapeHtml(goal.category)}</span>` : ''}
            ${goal.description ? `<p class="detail-desc">${escapeHtml(goal.description)}</p>` : ''}
            ${dl ? `<p class="detail-deadline${dl.overdue ? ' overdue' : ''}">${dl.text}</p>` : ''}
          </div>
          <button type="button" class="btn btn-sm pin-btn${state.pinnedGoalId === goal.id ? ' pinned btn-ghost' : ' btn-primary'}" data-id="${goal.id}">
            ${state.pinnedGoalId === goal.id ? '★ 已在首页展示' : '☆ 设为首页展示'}
          </button>
        </div>
      </div>
      <div class="detail-progress">
        <div class="progress-meta"><span>${formatProgress(goal)}</span><span>${pct}%</span></div>
        <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
      </div>
      <div class="task-panel task-panel-page">
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
    </div>
  `;
}

function groupTodayTasksForDisplay(tasks) {
  /** @type {Map<string, DailyTask[]>} */
  const goalMap = new Map();
  /** @type {DailyTask[]} */
  const customTasks = [];

  for (const task of tasks) {
    if (task.source === 'goal' && task.goalId) {
      if (!goalMap.has(task.goalId)) goalMap.set(task.goalId, []);
      goalMap.get(task.goalId).push(task);
    } else {
      customTasks.push(task);
    }
  }

  /** @type {Array<{ type: 'goal' | 'custom', goalId?: string, goal?: Goal, tasks: DailyTask[] }>} */
  const groups = [];

  for (const [goalId, goalTasks] of goalMap) {
    groups.push({
      type: 'goal',
      goalId,
      goal: state.goals.find((g) => g.id === goalId),
      tasks: goalTasks,
    });
  }

  groups.sort((a, b) => (a.goal?.title || '').localeCompare(b.goal?.title || '', 'zh-CN'));

  if (customTasks.length) {
    groups.push({ type: 'custom', tasks: customTasks });
  }

  return groups;
}

function countTasksProgress(tasks) {
  let total = 0;
  let completed = 0;
  for (const task of tasks) {
    const p = getDailyTaskProgress(task);
    total += p.total;
    completed += p.completed;
  }
  return { total, completed };
}

function renderTodaySubtaskItem(parentId, sub) {
  return `
    <div class="today-task-item sub-node${sub.completed ? ' completed' : ''}" data-parent-id="${parentId}" data-sub-id="${sub.id}">
      <label class="task-check">
        <input type="checkbox" class="today-subtask-toggle" data-parent-id="${parentId}" data-sub-id="${sub.id}" ${sub.completed ? 'checked' : ''} />
        <span class="task-checkmark"></span>
      </label>
      <div class="task-body">
        <span class="task-title">${escapeHtml(sub.title)}</span>
      </div>
      <button type="button" class="icon-btn delete-subtask-btn" data-parent-id="${parentId}" data-sub-id="${sub.id}" aria-label="删除子任务">✕</button>
    </div>
  `;
}

function renderTodayTaskBlock(task) {
  const hasSubs = !!task.subtasks?.length;
  const progress = getDailyTaskProgress(task);
  const parentDone = isDailyTaskDone(task);
  const showForm = state.expandedSubtaskParentId === task.id;
  const carriedLabel = task.carriedFrom
    ? `<span class="today-task-source carried">自 ${task.carriedFrom.slice(5).replace('-', '/')} 结转</span>`
    : '';
  const tags = carriedLabel ? `<span class="today-task-tags">${carriedLabel}</span>` : '';

  const parentCheck = hasSubs
    ? `<span class="task-check task-check-placeholder" aria-hidden="true"></span>`
    : `
      <label class="task-check">
        <input type="checkbox" class="today-task-toggle" data-id="${task.id}" ${task.completed ? 'checked' : ''} />
        <span class="task-checkmark"></span>
      </label>
    `;

  return `
    <div class="today-task-block${parentDone ? ' completed' : ''}" data-id="${task.id}">
      <div class="today-task-item parent-node${hasSubs ? ' has-children' : ''}${!hasSubs && task.completed ? ' completed' : ''}">
        ${parentCheck}
        <div class="task-body">
          <div class="today-task-title-row">
            <span class="task-title">${escapeHtml(task.title)}</span>
            ${hasSubs ? `<span class="today-task-progress">${progress.completed}/${progress.total}</span>` : ''}
          </div>
          ${tags}
        </div>
        <div class="today-task-item-actions">
          <button type="button" class="icon-btn add-subtask-btn" data-id="${task.id}" aria-label="添加子任务" title="分解子任务">+</button>
          <button type="button" class="icon-btn delete-today-task-btn" data-id="${task.id}" aria-label="删除">✕</button>
        </div>
      </div>
      ${
        hasSubs
          ? `<div class="today-subtask-list">${task.subtasks.map((sub) => renderTodaySubtaskItem(task.id, sub)).join('')}</div>`
          : ''
      }
      ${
        showForm
          ? `
        <form class="today-subtask-form" data-parent-id="${task.id}">
          <input type="text" name="title" maxlength="80" placeholder="输入子任务…" required />
          <button type="submit" class="btn btn-primary btn-sm">添加</button>
          <button type="button" class="btn btn-ghost btn-sm cancel-subtask-btn" data-id="${task.id}">取消</button>
        </form>
      `
          : ''
      }
    </div>
  `;
}

function renderTodayTaskItem(task, options = {}) {
  return renderTodayTaskBlock(task);
}

function renderTodayGoalGroup(group) {
  const { total, completed } = countTasksProgress(group.tasks);
  const pendingUnits = total - completed;
  const head =
    group.type === 'goal'
      ? `
        <div class="today-goal-group-head" style="--goal-color:${group.goal?.color || '#3b82f6'}">
          <span class="today-goal-group-dot" aria-hidden="true"></span>
          <span class="today-goal-group-title">${escapeHtml(group.goal?.title || '学习目标')}</span>
          <span class="today-goal-group-meta">${pendingUnits}/${total}</span>
        </div>
      `
      : `
        <div class="today-goal-group-head custom">
          <span class="today-goal-group-title">自定义任务</span>
          <span class="today-goal-group-meta">${pendingUnits}/${total}</span>
        </div>
      `;

  return `
    <div class="today-goal-group${group.type === 'custom' ? ' custom-group' : ''}"${group.type === 'goal' ? ` style="--goal-color:${group.goal?.color || '#3b82f6'}"` : ''}>
      ${head}
      <div class="today-goal-group-items">
        ${group.tasks.map((task) => renderTodayTaskBlock(task)).join('')}
      </div>
    </div>
  `;
}

function renderTodayTaskSection(tasks, label) {
  if (tasks.length === 0) return '';
  let totalUnits = 0;
  for (const task of tasks) totalUnits += getDailyTaskProgress(task).total;
  const groups = groupTodayTasksForDisplay(tasks);
  return `
    <div class="task-group">
      <div class="task-group-label">${label} (${totalUnits})</div>
      ${groups.map((group) => renderTodayGoalGroup(group)).join('')}
    </div>
  `;
}

function renderDailyCalendar() {
  const container = $('#today-calendar-wrap');
  if (!container) return;

  const [year, month] = state.calendarMonth.split('-').map(Number);
  const firstDay = new Date(year, month - 1, 1);
  const daysInMonth = new Date(year, month, 0).getDate();
  const startWeekday = firstDay.getDay();
  const today = todayStr();
  const selected = getSelectedDailyDate();
  const monthLabel = firstDay.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long' });

  const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
  const weekdayHtml = weekdays.map((d) => `<span class="calendar-weekday">${d}</span>`).join('');

  let cells = '';
  for (let i = 0; i < startWeekday; i += 1) {
    cells += `<span class="calendar-day empty" aria-hidden="true"></span>`;
  }

  for (let day = 1; day <= daysInMonth; day += 1) {
    const dateStr = dateStrFromParts(year, month, day);
    const isFuture = dateStr > today;
    const status = getDailyTaskDayStatus(dateStr);
    const classes = [
      'calendar-day',
      dateStr === selected ? 'selected' : '',
      dateStr === today ? 'today' : '',
      status !== 'none' ? 'has-tasks' : '',
      status === 'done' ? 'all-done' : '',
      status === 'partial' ? 'partial' : '',
      isFuture ? 'future' : '',
    ]
      .filter(Boolean)
      .join(' ');

    cells += `
      <button type="button" class="${classes}" data-date="${dateStr}" ${isFuture ? 'disabled' : ''} aria-label="${month}月${day}日${status !== 'none' ? '，有任务记录' : ''}">
        <span class="calendar-day-num">${day}</span>
        ${status !== 'none' ? '<span class="calendar-day-dot" aria-hidden="true"></span>' : ''}
      </button>
    `;
  }

  container.innerHTML = `
    <div class="daily-calendar daily-calendar-page">
      <div class="calendar-nav">
        <button type="button" class="icon-btn calendar-prev-btn" aria-label="上个月">‹</button>
        <span class="calendar-month-label">${monthLabel}</span>
        <button type="button" class="icon-btn calendar-next-btn" aria-label="下个月" ${state.calendarMonth >= today.slice(0, 7) ? 'disabled' : ''}>›</button>
      </div>
      <div class="calendar-weekdays">${weekdayHtml}</div>
      <div class="calendar-grid">${cells}</div>
    </div>
  `;
}

function renderToday() {
  const selected = getSelectedDailyDate();
  const isToday = isTodaySelected();
  const tasks = getDailyTasks(selected);
  const { completed, total } = getDailyTaskStatsForDate(selected);
  const pending = tasks.filter((t) => !isDailyTaskDone(t));
  const done = tasks.filter((t) => isDailyTaskDone(t));

  const viewTitle = $('#today-view-title');
  const dateLabel = $('#today-date-label');
  const badge = $('#today-progress-badge');
  const backBtn = $('#back-to-today-btn');
  const list = $('#today-task-list');
  const empty = $('#today-empty-state');
  const actions = $('#today-actions');
  const addForm = $('#today-add-form');
  const importBtn = $('#open-import-modal-btn');

  if (viewTitle) viewTitle.textContent = isToday ? '今日任务' : '任务记录';
  if (dateLabel) dateLabel.textContent = formatDateLabel(selected);
  if (backBtn) backBtn.hidden = isToday;
  if (badge) {
    badge.textContent = total === 0 ? '0 项' : `${completed}/${total}`;
    badge.classList.toggle('all-done', total > 0 && completed === total);
  }
  if (actions) actions.hidden = false;
  if (addForm) {
    const input = addForm.querySelector('input[name="title"]');
    if (input) input.placeholder = isToday ? '写一条今天要做的任务…' : '为这一天补充一条任务…';
  }
  if (importBtn) importBtn.hidden = !isToday;

  const calendarCard = $('#today-calendar-card');
  const calendarToggle = $('#toggle-today-calendar-btn');
  if (calendarToggle) {
    calendarToggle.classList.toggle('active', state.todayCalendarOpen);
    calendarToggle.setAttribute('aria-expanded', String(state.todayCalendarOpen));
    const label = calendarToggle.querySelector('.today-action-tile-label');
    if (label) label.textContent = state.todayCalendarOpen ? '收起日历' : '任务日历';
  }
  if (calendarCard) calendarCard.hidden = !state.todayCalendarOpen;
  if (state.todayCalendarOpen) renderDailyCalendar();

  if (tasks.length === 0) {
    if (list) list.innerHTML = '';
    if (empty) {
      empty.hidden = false;
      empty.querySelector('h3').textContent = isToday ? '今天还没有任务' : '这一天没有任务记录';
      empty.querySelector('p').textContent = isToday
        ? '添加任务后点 + 可分解子任务，或点击「添加今日目标」导入学习节点'
        : '可以补充任务，或打开「任务日历」查看其他日期';
    }
    return;
  }

  if (empty) empty.hidden = true;
  if (list) {
    list.innerHTML =
      renderTodayTaskSection(pending, '待完成') + renderTodayTaskSection(done, '已完成');
  }
}

function renderImportModal() {
  const container = $('#import-goal-list');
  if (!container) return;

  const importableGoals = state.goals
    .map((goal) => ({
      goal,
      tasks: goal.tasks.filter((t) => !t.completed),
    }))
    .filter(({ tasks }) => tasks.length > 0);

  if (state.goals.length === 0) {
    container.innerHTML = `<p class="no-logs">还没有学习目标，先去创建一个吧</p>`;
    return;
  }

  if (importableGoals.length === 0) {
    container.innerHTML = `<p class="no-logs">所有目标的待办节点都已完成，或尚未添加任务节点</p>`;
    return;
  }

  container.innerHTML = importableGoals
    .map(({ goal, tasks }) => {
      const items = tasks
        .map((task) => {
          const imported = isDailyTaskImported(goal.id, task.id);
          return `
            <label class="import-task-item${imported ? ' imported' : ''}">
              <input type="checkbox" class="import-task-check" value="${task.id}" data-goal-id="${goal.id}" ${imported ? 'disabled checked' : ''} />
              <span class="import-task-title">${escapeHtml(task.title)}</span>
              ${imported ? '<span class="import-task-tag">已导入</span>' : ''}
            </label>
          `;
        })
        .join('');

      return `
        <div class="import-goal-block" style="--goal-color:${goal.color}">
          <div class="import-goal-head">
            <h4>${escapeHtml(goal.title)}</h4>
            ${goal.category ? `<span class="goal-category">${escapeHtml(goal.category)}</span>` : ''}
          </div>
          <div class="import-task-list">${items}</div>
        </div>
      `;
    })
    .join('');
}

function renderProfile() {
  const versionEl = $('#profile-version');
  const statusEl = $('#version-status');
  const reloadBtn = $('#profile-reload-btn');
  const checkBtn = $('#check-update-btn');
  const installBtn = $('#profile-install-btn');
  const installHint = $('#profile-install-hint');

  if (versionEl) versionEl.textContent = `v${APP_VERSION}`;

  if (statusEl) {
    statusEl.textContent = updateCheckStatus.message;
    statusEl.className = `profile-version-status status-${updateCheckStatus.state}`;
  }

  if (reloadBtn) {
    reloadBtn.hidden = updateCheckStatus.state !== 'available';
  }

  if (checkBtn) {
    checkBtn.disabled = updateCheckStatus.state === 'checking';
    checkBtn.textContent = updateCheckStatus.state === 'checking' ? '检查中…' : '检查更新';
  }

  if (installBtn && installHint) {
    if (deferredInstallPrompt) {
      installBtn.hidden = false;
      installHint.hidden = true;
    } else {
      installBtn.hidden = true;
      installHint.hidden = false;
    }
  }

  const carryToggle = $('#carry-over-toggle');
  if (carryToggle) carryToggle.checked = state.carryOverDailyTasks;
}

function render() {
  updateHeader();
  updateBottomNav();
  showActiveView();

  if (state.tab === 'today') {
    renderToday();
    return;
  }

  if (state.tab === 'sleep') {
    renderSleep();
    return;
  }

  if (state.tab === 'profile') {
    renderProfile();
    return;
  }

  if (state.view === 'home') renderHome();
  if (state.view === 'goals') renderGoals();
  if (state.view === 'goal-detail') renderGoalDetail();
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

function closeImportOverlay() {
  const overlay = $('#import-overlay');
  if (overlay) overlay.hidden = true;
  document.body.style.overflow = '';
}

function openImportModal() {
  renderImportModal();
  const overlay = $('#import-overlay');
  if (!overlay) return;
  overlay.hidden = false;
  document.body.style.overflow = 'hidden';
  overlay.querySelector('.import-sheet')?.scrollTo(0, 0);
}

function handleImportConfirm() {
  const checks = $$('#import-goal-list .import-task-check:checked:not(:disabled)');
  const items = [...checks]
    .map((el) => {
      const goal = state.goals.find((g) => g.id === el.dataset.goalId);
      const task = goal?.tasks.find((t) => t.id === el.value);
      if (!task) return null;
      return { goalId: el.dataset.goalId, taskId: el.value, title: task.title };
    })
    .filter(Boolean);

  if (items.length === 0) {
    showToast('请先选择要导入的任务');
    return;
  }

  importGoalTasks(items);
  closeImportOverlay();
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
      state.goals[idx] = { ...state.goals[idx], ...data };
      showToast('目标已更新');
    }
  } else {
    const newGoal = { id: uid(), ...data, createdAt: now };
    state.goals.unshift(newGoal);
    showToast('目标已创建');
  }

  saveData();
  render();
  $('#goal-modal').close();
}

function toggleTask(goalId, taskId, completed, options = {}) {
  const goal = state.goals.find((g) => g.id === goalId);
  if (!goal) return;

  const task = goal.tasks.find((t) => t.id === taskId);
  if (!task) return;

  task.completed = completed;
  task.completedAt = completed ? todayStr() : null;
  goal.updatedAt = new Date().toISOString();

  saveData();
  if (!options.silent) {
    render();
    showToast(completed ? '节点已完成' : '已标记为未完成');
  }
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
  showToast('任务节点已添加');
}

function deleteTask(goalId, taskId) {
  const goal = state.goals.find((g) => g.id === goalId);
  if (!goal) return;

  goal.tasks = goal.tasks.filter((t) => t.id !== taskId);
  goal.updatedAt = new Date().toISOString();

  saveData();
  render();
  showToast('任务节点已删除');
}

function deleteGoal() {
  if (!editingGoalId) return;
  if (!confirm('确定删除这个目标及其所有任务节点吗？')) return;

  const wasDetail = state.view === 'goal-detail' && state.selectedGoalId === editingGoalId;
  if (state.pinnedGoalId === editingGoalId) state.pinnedGoalId = null;
  state.goals = state.goals.filter((g) => g.id !== editingGoalId);
  saveData();

  if (wasDetail) {
    navigateTo('goals');
  } else {
    render();
  }

  $('#goal-modal').close();
  showToast('目标已删除');
}

function bindEvents() {
  $('#bottom-nav').addEventListener('click', (e) => {
    const btn = e.target.closest('.bottom-nav-item');
    if (!btn || btn.dataset.tab === state.tab) return;
    switchTab(btn.dataset.tab);
  });

  $('#record-wake-btn')?.addEventListener('click', () => recordSleepTime('wake'));
  $('#record-bed-btn')?.addEventListener('click', () => recordSleepTime('bed'));

  $('#view-sleep')?.addEventListener('submit', (e) => {
    const durationForm = e.target.closest('.sleep-duration-form, .sleep-history-duration-form');
    if (durationForm) {
      e.preventDefault();
      const date = durationForm.dataset.date || todayStr();
      const hInput = durationForm.querySelector('.sleep-duration-h, #duration-hours-input');
      const mInput = durationForm.querySelector('.sleep-duration-m, #duration-minutes-input');
      saveManualSleepDuration(date, hInput?.value ?? '', mInput?.value ?? '');
      return;
    }

    const form = e.target.closest('.sleep-manual-form, .sleep-history-manual-form');
    if (!form) return;
    e.preventDefault();
    const input = form.querySelector('input[type="time"]');
    const date = form.dataset.date || todayStr();
    const type = form.dataset.type;
    if (type !== 'wake' && type !== 'bed') return;
    saveManualSleepTime(date, type, input?.value || '');
  });

  $('#view-sleep')?.addEventListener('click', (e) => {
    const subnavBtn = e.target.closest('.sleep-subnav-btn');
    if (subnavBtn) {
      const panel = subnavBtn.dataset.sleepPanel;
      if (panel !== 'record' && panel !== 'chart' && panel !== 'history') return;
      if (panel === state.sleepPanel) return;
      state.sleepPanel = panel;
      renderSleep();
      return;
    }

    const typeBtn = e.target.closest('.sleep-type-btn');
    if (typeBtn) {
      const chartType = typeBtn.dataset.chartType;
      if (chartType !== 'wake' && chartType !== 'bed' && chartType !== 'duration') return;
      if (chartType === state.sleepChartType) return;
      state.sleepChartType = chartType;
      renderSleep();
      return;
    }

    const rangeBtn = e.target.closest('.sleep-range-btn');
    if (rangeBtn) {
      if (rangeBtn.dataset.range === state.sleepChartRange) return;
      state.sleepChartRange = rangeBtn.dataset.range === 'month' ? 'month' : 'week';
      renderSleep();
      return;
    }

    const deleteBtn = e.target.closest('.sleep-delete-btn, .sleep-history-delete-btn');
    if (deleteBtn) {
      const date = deleteBtn.dataset.date || todayStr();
      const type = deleteBtn.dataset.type;
      if (type !== 'wake' && type !== 'bed' && type !== 'duration') return;
      deleteSleepTime(date, type);
      return;
    }

    const chartPoint = e.target.closest('.sleep-chart-point');
    if (chartPoint) {
      $$('.sleep-chart-point.active').forEach((p) => p.classList.remove('active'));
      chartPoint.classList.add('active');
      const card = chartPoint.closest('.sleep-chart-card');
      const detail = card?.querySelector('.sleep-chart-detail');
      const text = formatChartPointDetail(chartPoint.dataset.date, chartPoint.dataset.kind, chartPoint.dataset.value);
      if (detail) detail.textContent = text;
    }
  });

  $('#today-add-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = e.target.querySelector('input[name="title"]');
    addCustomDailyTask(input.value);
    input.value = '';
    input.focus();
  });

  $('#today-calendar-wrap').addEventListener('click', (e) => {
    const prevBtn = e.target.closest('.calendar-prev-btn');
    const nextBtn = e.target.closest('.calendar-next-btn');
    const dayBtn = e.target.closest('.calendar-day:not(.empty):not(.future)');

    if (prevBtn) {
      const [year, month] = state.calendarMonth.split('-').map(Number);
      const d = new Date(year, month - 2, 1);
      state.calendarMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      renderDailyCalendar();
      return;
    }

    if (nextBtn && !nextBtn.disabled) {
      const [year, month] = state.calendarMonth.split('-').map(Number);
      const d = new Date(year, month, 1);
      const nextMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      if (nextMonth > todayStr().slice(0, 7)) return;
      state.calendarMonth = nextMonth;
      renderDailyCalendar();
      return;
    }

    if (dayBtn?.dataset.date) {
      selectDateAndGoToday(dayBtn.dataset.date);
    }
  });

  $('#back-to-today-btn').addEventListener('click', () => {
    setSelectedDailyDate(todayStr());
  });

  $('#today-task-list').addEventListener('change', (e) => {
    if (e.target.classList.contains('today-task-toggle')) {
      toggleDailyTask(e.target.dataset.id, e.target.checked);
      return;
    }
    if (e.target.classList.contains('today-subtask-toggle')) {
      toggleDailySubTask(e.target.dataset.parentId, e.target.dataset.subId, e.target.checked);
    }
  });

  $('#today-task-list').addEventListener('click', (e) => {
    const addBtn = e.target.closest('.add-subtask-btn');
    if (addBtn) {
      const id = addBtn.dataset.id;
      state.expandedSubtaskParentId = state.expandedSubtaskParentId === id ? null : id;
      renderToday();
      return;
    }

    const cancelBtn = e.target.closest('.cancel-subtask-btn');
    if (cancelBtn) {
      state.expandedSubtaskParentId = null;
      renderToday();
      return;
    }

    const deleteSubBtn = e.target.closest('.delete-subtask-btn');
    if (deleteSubBtn) {
      if (!confirm('确定删除这条子任务吗？')) return;
      deleteDailySubTask(deleteSubBtn.dataset.parentId, deleteSubBtn.dataset.subId);
      return;
    }

    const btn = e.target.closest('.delete-today-task-btn');
    if (!btn) return;
    if (!confirm('确定删除这条任务吗？子任务也会一并删除。')) return;
    deleteDailyTask(btn.dataset.id);
  });

  $('#today-task-list').addEventListener('submit', (e) => {
    const form = e.target.closest('.today-subtask-form');
    if (!form) return;
    e.preventDefault();
    const input = form.querySelector('input[name="title"]');
    addDailySubTask(form.dataset.parentId, input?.value || '');
  });

  $('#open-import-modal-btn').addEventListener('click', openImportModal);

  $('#toggle-today-calendar-btn')?.addEventListener('click', () => {
    state.todayCalendarOpen = !state.todayCalendarOpen;
    renderToday();
  });

  $('#import-overlay-backdrop').addEventListener('click', closeImportOverlay);
  $('#close-import-modal').addEventListener('click', closeImportOverlay);
  $('#cancel-import-btn').addEventListener('click', closeImportOverlay);
  $('#confirm-import-btn').addEventListener('click', handleImportConfirm);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#import-overlay')?.hidden) closeImportOverlay();
  });

  $('#back-btn').addEventListener('click', goBack);
  $('#add-goal-btn').addEventListener('click', () => openGoalModal());
  $('#empty-add-btn').addEventListener('click', () => openGoalModal());

  $('#edit-goal-header-btn').addEventListener('click', () => {
    const goal = state.goals.find((g) => g.id === state.selectedGoalId);
    if (goal) openGoalModal(goal);
  });

  $('#nav-cards').addEventListener('click', (e) => {
    const card = e.target.closest('.nav-card');
    if (card) navigateToGoals(card.dataset.filter);
  });

  $('#home-featured').addEventListener('click', (e) => {
    const card = e.target.closest('.featured-goal-card');
    if (card) navigateToGoalDetail(card.dataset.id);
  });

  $('#home-featured').addEventListener('change', (e) => {
    if (e.target.id !== 'pin-goal-select') return;
    setPinnedGoalFromSelect(e.target.value);
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

  $('#goal-detail-body').addEventListener('submit', (e) => {
    if (e.target.id !== 'detail-add-task-form') return;
    e.preventDefault();
    const input = e.target.querySelector('input[name="title"]');
    addTaskToGoal(state.selectedGoalId, input.value);
    input.value = '';
  });

  $('#goal-detail-body').addEventListener('change', (e) => {
    if (!e.target.classList.contains('task-toggle')) return;
    toggleTask(e.target.dataset.goalId, e.target.dataset.taskId, e.target.checked);
  });

  $('#goal-detail-body').addEventListener('click', (e) => {
    const pinBtn = e.target.closest('.pin-btn, .pin-icon-btn');
    if (pinBtn) {
      e.stopPropagation();
      setPinnedGoal(pinBtn.dataset.id);
      return;
    }

    const btn = e.target.closest('.delete-task-btn');
    if (!btn) return;
    if (!confirm('确定删除这个任务节点吗？')) return;
    deleteTask(btn.dataset.goalId, btn.dataset.taskId);
  });

  $('#goals-grid').addEventListener('click', (e) => {
    const moveUpBtn = e.target.closest('.move-up-btn');
    const moveDownBtn = e.target.closest('.move-down-btn');
    const pinBtn = e.target.closest('.pin-btn, .pin-icon-btn');
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
    if (pinBtn) {
      e.stopPropagation();
      setPinnedGoal(pinBtn.dataset.id);
      return;
    }
    if (editBtn) {
      e.stopPropagation();
      const goal = state.goals.find((g) => g.id === editBtn.dataset.id);
      openGoalModal(goal);
      return;
    }
    if (card) {
      navigateToGoalDetail(card.dataset.id);
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

  grid.addEventListener('dragend', () => {
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

function showUpdateBanner() {
  const banner = $('#update-banner');
  if (banner) banner.hidden = false;
  updateCheckStatus = {
    state: 'available',
    remoteVersion: updateCheckStatus.remoteVersion,
    message: updateCheckStatus.remoteVersion
      ? `发现新版本 v${updateCheckStatus.remoteVersion}，请刷新页面`
      : '发现新版本，请刷新页面',
  };
  if (state.tab === 'profile') renderProfile();
}

async function fetchRemoteVersion() {
  const res = await fetch(`./sw.js?v=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) throw new Error('network');
  const text = await res.text();
  const match = text.match(/const APP_VERSION = '(\d+)'/);
  if (!match) throw new Error('parse');
  return match[1];
}

async function checkForUpdates(options = {}) {
  updateCheckStatus = { state: 'checking', remoteVersion: null, message: '正在检查更新…' };
  renderProfile();

  try {
    if (swRegistration) await swRegistration.update();
    const remoteVersion = await fetchRemoteVersion();
    const hasWaitingWorker = !!swRegistration?.waiting;
    const isNewer = Number(remoteVersion) > Number(APP_VERSION);

    if (isNewer || hasWaitingWorker) {
      updateCheckStatus = {
        state: 'available',
        remoteVersion,
        message: isNewer
          ? `发现新版本 v${remoteVersion}（当前 v${APP_VERSION}）`
          : `新版本 v${remoteVersion} 已就绪，刷新后生效`,
      };
      showUpdateBanner();
      if (!options.silent) showToast('发现新版本，请刷新');
    } else {
      updateCheckStatus = {
        state: 'latest',
        remoteVersion,
        message: `已是最新版本（v${APP_VERSION}）`,
      };
      if (!options.silent) showToast('已是最新版本');
    }
  } catch {
    updateCheckStatus = {
      state: 'error',
      remoteVersion: null,
      message: '检查失败，请确认网络后重试',
    };
    if (!options.silent) showToast('检查更新失败');
  }

  renderProfile();
}

function checkAppVersion() {
  const stored = localStorage.getItem(VERSION_KEY);
  if (stored && stored !== APP_VERSION) {
    updateCheckStatus = {
      state: 'available',
      remoteVersion: APP_VERSION,
      message: `已加载 v${APP_VERSION}，建议刷新以确保功能完整`,
    };
    showUpdateBanner();
  }
  localStorage.setItem(VERSION_KEY, APP_VERSION);
}

function setupPWA() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker
      .register(`./sw.js?v=${APP_VERSION}`)
      .then((reg) => {
        swRegistration = reg;
        const checkUpdate = () => reg.update().catch(() => {});
        checkUpdate();
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') checkUpdate();
        });

        if (reg.waiting && navigator.serviceWorker.controller) {
          showUpdateBanner();
        }

        reg.addEventListener('updatefound', () => {
          const worker = reg.installing;
          worker?.addEventListener('statechange', () => {
            if (worker.state === 'installed' && navigator.serviceWorker.controller) {
              showUpdateBanner();
            }
          });
        });

        navigator.serviceWorker.addEventListener('controllerchange', () => {
          showUpdateBanner();
        });
      })
      .catch(() => {});
  }

  checkAppVersion();

  $('#reload-app-btn')?.addEventListener('click', () => {
    window.location.reload();
  });

  $('#profile-reload-btn')?.addEventListener('click', () => {
    window.location.reload();
  });

  $('#check-update-btn')?.addEventListener('click', () => checkForUpdates());

  $('#carry-over-toggle')?.addEventListener('change', (e) => {
    state.carryOverDailyTasks = e.target.checked;
    saveData();
    if (state.carryOverDailyTasks) {
      const added = rolloverIncompleteDailyTasks({ force: true });
      if (added > 0 && state.tab === 'today') render();
      showToast(
        added > 0 ? `已将昨日 ${added} 条未完成任务加入今天` : '已开启任务自动结转'
      );
    } else {
      showToast('已关闭任务自动结转');
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    const added = rolloverIncompleteDailyTasks({ silent: true });
    if (added > 0) {
      showToast(`已将昨日 ${added} 条未完成任务加入今天`);
      if (state.tab === 'today') render();
    }
  });

  const installBtn = $('#install-btn');
  const profileInstallBtn = $('#profile-install-btn');

  async function promptInstall() {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    installBtn.hidden = true;
    renderProfile();
  }

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    installBtn.hidden = false;
    renderProfile();
  });

  installBtn.addEventListener('click', promptInstall);
  profileInstallBtn?.addEventListener('click', promptInstall);

  window.addEventListener('appinstalled', () => {
    installBtn.hidden = true;
    deferredInstallPrompt = null;
    renderProfile();
    showToast('应用已安装到桌面');
  });
}

function init() {
  loadData();
  rolloverIncompleteDailyTasks();
  bindEvents();
  setupPWA();
  render();
}

init();
