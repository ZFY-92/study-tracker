(function () {
  const SYNC_KEY_STORAGE = 'learning-progress-sync-key';
  const SYNC_CLOUD_ENABLED_KEY = 'learning-progress-sync-cloud-enabled';
  const SYNC_LAST_AT_KEY = 'learning-progress-sync-last-at';
  const SYNC_CODE_PREFIX = 'ST1:';
  const SYNC_CODE_PREFIX_COMPRESSED = 'ST2:';
  const WECHAT_TEXT_WARN_CHARS = 8000;
  const TABLE_NAME = 'sync_vault';
  const PBKDF2_SALT = new TextEncoder().encode('learning-progress-sync-v1');
  const PUSH_DEBOUNCE_MS = 800;

  let supabaseClient = null;
  let callbacks = {};
  let pushTimer = null;
  let syncing = false;
  let status = 'disabled';
  let uiBound = false;

  function isCloudConfigured() {
    const cfg = window.SUPABASE_CONFIG;
    return !!(cfg && cfg.url && cfg.anonKey);
  }

  function isCloudEnabled() {
    return localStorage.getItem(SYNC_CLOUD_ENABLED_KEY) === '1' && !!getSyncKey() && isCloudConfigured();
  }

  function hasSyncKey() {
    return !!getSyncKey();
  }

  function getSyncKey() {
    return localStorage.getItem(SYNC_KEY_STORAGE) || '';
  }

  function getLastSyncAt() {
    return localStorage.getItem(SYNC_LAST_AT_KEY) || '';
  }

  function setLastSyncAt(iso) {
    localStorage.setItem(SYNC_LAST_AT_KEY, iso);
  }

  function setStatus(next) {
    status = next;
    updateSettingsUI();
  }

  function getStatusLabel(state = status) {
    if (isCloudEnabled()) {
      switch (state) {
        case 'syncing':
          return '同步中…';
        case 'error':
          return '同步失败';
        case 'ok':
          return formatLastSyncLabel(getLastSyncAt()) || '已同步';
        default:
          return '自动同步已开启';
      }
    }
    if (hasSyncKey()) {
      return formatLastSyncLabel(getLastSyncAt()) || '已设密钥';
    }
    return '未设置';
  }

  function formatLastSyncLabel(iso) {
    if (!iso) return '';
    const diff = Date.now() - new Date(iso).getTime();
    if (Number.isNaN(diff) || diff < 0) return '';
    if (diff < 60000) return '刚刚同步';
    if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前同步`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前同步`;
    return `${new Date(iso).toLocaleDateString('zh-CN')} 同步`;
  }

  function maskSyncKey(key) {
    if (!key) return '';
    if (key.length <= 8) return '••••••••';
    return `${'•'.repeat(Math.min(key.length - 4, 12))}${key.slice(-4)}`;
  }

  function showDialog(modal) {
    if (!modal) return;
    try {
      if (typeof modal.showModal === 'function') {
        if (!modal.open) modal.showModal();
        return;
      }
    } catch (err) {
      console.warn('showModal failed:', err);
    }
    modal.setAttribute('open', '');
  }

  function hideDialog(modal) {
    if (!modal) return;
    try {
      if (typeof modal.close === 'function' && modal.open) {
        modal.close();
        return;
      }
    } catch (err) {
      console.warn('close failed:', err);
    }
    modal.removeAttribute('open');
  }

  async function loadSupabaseClient() {
    if (!isCloudConfigured()) return null;
    if (supabaseClient) return supabaseClient;

    if (typeof supabase !== 'undefined') {
      supabaseClient = supabase.createClient(window.SUPABASE_CONFIG.url, window.SUPABASE_CONFIG.anonKey);
      return supabaseClient;
    }

    await new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js';
      script.onload = resolve;
      script.onerror = () => reject(new Error('Supabase SDK 加载失败'));
      document.head.appendChild(script);
    });

    if (typeof supabase === 'undefined') return null;
    supabaseClient = supabase.createClient(window.SUPABASE_CONFIG.url, window.SUPABASE_CONFIG.anonKey);
    return supabaseClient;
  }

  function initCloudClient() {
    if (!isCloudConfigured()) return false;
    if (supabaseClient) return true;
    loadSupabaseClient().catch(() => {});
    return false;
  }

  function validateSyncKey(raw) {
    const key = String(raw || '').trim();
    if (key.length < 8) {
      throw new Error('同步密钥至少 8 位，建议使用「生成密钥」创建随机密钥');
    }
    return key;
  }

  function generateSyncKey() {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  async function hashSyncKey(syncKey) {
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(syncKey.trim()));
    return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('');
  }

  function bufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }

  function base64ToBuffer(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  }

  async function deriveAesKey(syncKey) {
    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(syncKey.trim()),
      'PBKDF2',
      false,
      ['deriveKey']
    );
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: PBKDF2_SALT, iterations: 100000, hash: 'SHA-256' },
      keyMaterial,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  async function encryptPayload(syncKey, payload) {
    const key = await deriveAesKey(syncKey);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      new TextEncoder().encode(JSON.stringify(payload))
    );
    return {
      payload: bufferToBase64(encrypted),
      iv: bufferToBase64(iv),
    };
  }

  async function decryptPayload(syncKey, payload, ivBase64) {
    const key = await deriveAesKey(syncKey);
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: new Uint8Array(base64ToBuffer(ivBase64)) },
      key,
      base64ToBuffer(payload)
    );
    return JSON.parse(new TextDecoder().decode(decrypted));
  }

  function supportsGzip() {
    return typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined';
  }

  async function gzipText(text) {
    const stream = new Blob([new TextEncoder().encode(text)]).stream().pipeThrough(new CompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function gunzipText(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    return await new Response(stream).text();
  }

  async function encryptBytes(syncKey, bytes) {
    const key = await deriveAesKey(syncKey);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes);
    return {
      payload: bufferToBase64(encrypted),
      iv: bufferToBase64(iv),
    };
  }

  async function decryptBytes(syncKey, payload, ivBase64) {
    const key = await deriveAesKey(syncKey);
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: new Uint8Array(base64ToBuffer(ivBase64)) },
      key,
      base64ToBuffer(payload)
    );
    return new Uint8Array(decrypted);
  }

  function entityTime(item) {
    return new Date(item?.updatedAt || item?.completedAt || item?.createdAt || 0).getTime();
  }

  function mergeById(local, remote, mergeFn) {
    const map = new Map();
    (local || []).forEach((item) => map.set(item.id, item));
    (remote || []).forEach((item) => {
      const existing = map.get(item.id);
      if (!existing) {
        map.set(item.id, item);
        return;
      }
      map.set(item.id, mergeFn ? mergeFn(existing, item) : entityTime(item) >= entityTime(existing) ? item : existing);
    });
    return Array.from(map.values());
  }

  function mergeDailyTask(local, remote) {
    const pickRemote = entityTime(remote) >= entityTime(local);
    const base = pickRemote ? { ...remote } : { ...local };
    const other = pickRemote ? local : remote;
    if (local.subtasks?.length || remote.subtasks?.length || other.subtasks?.length) {
      base.subtasks = mergeById(local.subtasks || [], remote.subtasks || []);
    }
    return base;
  }

  function mergeGoals(local, remote) {
    const localMap = new Map((local || []).map((g) => [g.id, g]));
    const remoteMap = new Map((remote || []).map((g) => [g.id, g]));
    const ids = new Set([...localMap.keys(), ...remoteMap.keys()]);
    const result = [];

    for (const id of ids) {
      const lg = localMap.get(id);
      const rg = remoteMap.get(id);
      if (!lg) {
        result.push(rg);
        continue;
      }
      if (!rg) {
        result.push(lg);
        continue;
      }
      const useRemoteMeta = entityTime(rg) >= entityTime(lg);
      const base = useRemoteMeta ? { ...rg } : { ...lg };
      base.tasks = mergeById(lg.tasks || [], rg.tasks || []);
      base.updatedAt = new Date(Math.max(entityTime(lg), entityTime(rg))).toISOString();
      result.push(base);
    }
    return result;
  }

  function mergeDailyTasks(local, remote) {
    const result = { ...(local || {}) };
    for (const [date, remoteTasks] of Object.entries(remote || {})) {
      const localTasks = result[date] || [];
      result[date] = mergeById(localTasks, remoteTasks || [], mergeDailyTask);
    }
    return result;
  }

  function mergeRecordMaps(local, remote) {
    const result = { ...(local || {}) };
    for (const [key, value] of Object.entries(remote || {})) {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        result[key] = { ...(result[key] || {}), ...value };
      } else if (value) {
        result[key] = value;
      }
    }
    return result;
  }

  function mergeGymDays(local, remote) {
    return { ...(local || {}), ...(remote || {}) };
  }

  function pickMaxDate(a, b) {
    if (!a) return b || '';
    if (!b) return a;
    return a >= b ? a : b;
  }

  function mergePayload(localData, remoteData) {
    const mergedGoals = mergeGoals(localData.goals || [], remoteData.goals || []);
    const goalIds = new Set(mergedGoals.map((g) => g.id));
    const localSync = new Date(localData.syncedAt || getLastSyncAt() || 0).getTime();
    const remoteSync = new Date(remoteData.syncedAt || 0).getTime();
    const preferRemote = remoteSync >= localSync;

    let pinnedGoalId = preferRemote ? remoteData.pinnedGoalId : localData.pinnedGoalId;
    if (pinnedGoalId && !goalIds.has(pinnedGoalId)) {
      const fallback = preferRemote ? localData.pinnedGoalId : remoteData.pinnedGoalId;
      pinnedGoalId = fallback && goalIds.has(fallback) ? fallback : null;
    }

    return {
      goals: mergedGoals,
      pinnedGoalId: pinnedGoalId || null,
      dailyTasks: mergeDailyTasks(localData.dailyTasks || {}, remoteData.dailyTasks || {}),
      sleepRecords: mergeRecordMaps(localData.sleepRecords || {}, remoteData.sleepRecords || {}),
      gymDays: mergeGymDays(localData.gymDays || {}, remoteData.gymDays || {}),
      gymReminderDays: preferRemote
        ? (remoteData.gymReminderDays ?? localData.gymReminderDays ?? 2)
        : (localData.gymReminderDays ?? remoteData.gymReminderDays ?? 2),
      carryOverDailyTasks: preferRemote
        ? remoteData.carryOverDailyTasks !== false
        : localData.carryOverDailyTasks !== false,
      lastRolloverDate: pickMaxDate(localData.lastRolloverDate, remoteData.lastRolloverDate),
      syncedAt: new Date().toISOString(),
    };
  }

  function summarizeData(data) {
    const goals = data.goals?.length || 0;
    const dailyTasks = Object.values(data.dailyTasks || {}).reduce((sum, tasks) => sum + (tasks?.length || 0), 0);
    const sleepDays = Object.keys(data.sleepRecords || {}).length;
    const gymDays = Object.keys(data.gymDays || {}).length;
    return { goals, dailyTasks, sleepDays, gymDays };
  }

  function getErrorMessage(err) {
    if (!err) return '同步失败';
    if (typeof err.message === 'string' && err.message) return err.message;
    return '同步失败';
  }

  function hasDataChanged(localData, merged) {
    return (
      JSON.stringify(localData.goals || []) !== JSON.stringify(merged.goals || []) ||
      JSON.stringify(localData.dailyTasks || {}) !== JSON.stringify(merged.dailyTasks || {}) ||
      JSON.stringify(localData.sleepRecords || {}) !== JSON.stringify(merged.sleepRecords || {}) ||
      JSON.stringify(localData.gymDays || {}) !== JSON.stringify(merged.gymDays || {}) ||
      localData.pinnedGoalId !== merged.pinnedGoalId ||
      localData.gymReminderDays !== merged.gymReminderDays ||
      localData.carryOverDailyTasks !== merged.carryOverDailyTasks ||
      localData.lastRolloverDate !== merged.lastRolloverDate
    );
  }

  function buildCloudPayload(localData) {
    return {
      goals: localData.goals || [],
      pinnedGoalId: localData.pinnedGoalId || null,
      dailyTasks: localData.dailyTasks || {},
      sleepRecords: localData.sleepRecords || {},
      gymDays: localData.gymDays || {},
      gymReminderDays: localData.gymReminderDays ?? 2,
      carryOverDailyTasks: localData.carryOverDailyTasks !== false,
      lastRolloverDate: localData.lastRolloverDate || '',
      syncedAt: new Date().toISOString(),
    };
  }

  async function pullRemote(syncKey) {
    const vaultId = await hashSyncKey(syncKey);
    const { data, error } = await supabaseClient
      .from(TABLE_NAME)
      .select('payload, iv')
      .eq('vault_id', vaultId)
      .maybeSingle();
    if (error) throw error;
    if (!data?.payload || !data?.iv) return null;
    return decryptPayload(syncKey, data.payload, data.iv);
  }

  async function pushRemote(syncKey, payload) {
    const vaultId = await hashSyncKey(syncKey);
    const encrypted = await encryptPayload(syncKey, payload);
    const { error } = await supabaseClient.from(TABLE_NAME).upsert({
      vault_id: vaultId,
      payload: encrypted.payload,
      iv: encrypted.iv,
      client_updated_at: payload.syncedAt,
    });
    if (error) throw error;
    setLastSyncAt(new Date().toISOString());
  }

  async function runCloudSync({ forcePush = false } = {}) {
    if (!isCloudEnabled() || syncing) return { changed: false };

    syncing = true;
    setStatus('syncing');

    try {
      const client = await loadSupabaseClient();
      if (!client) {
        setStatus('error');
        return { changed: false, error: '未配置 Supabase' };
      }
      supabaseClient = client;
      const syncKey = getSyncKey();
      const localData = callbacks.getData ? callbacks.getData() : {};
      const remoteData = await pullRemote(syncKey);

      if (!remoteData) {
        const payload = buildCloudPayload(localData);
        await pushRemote(syncKey, payload);
        setStatus('ok');
        return { changed: false };
      }

      const merged = mergePayload(localData, remoteData);
      const changed = hasDataChanged(localData, merged);

      if (changed && callbacks.applyData) callbacks.applyData(merged);
      if (changed || forcePush) await pushRemote(syncKey, merged);
      else setLastSyncAt(new Date().toISOString());

      setStatus('ok');
      return { changed };
    } catch (err) {
      console.error('Cloud sync failed:', err);
      setStatus('error');
      return { changed: false, error: getErrorMessage(err) };
    } finally {
      syncing = false;
    }
  }

  function schedulePush() {
    if (!isCloudEnabled()) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => runCloudSync({ forcePush: true }), PUSH_DEBOUNCE_MS);
  }

  async function enableCloudSync() {
    if (!hasSyncKey()) {
      alert('请先填写并保存同步密钥');
      return false;
    }
    if (!isCloudConfigured()) {
      alert('尚未配置 Supabase 云端，请联系部署者填写 supabase-config.js。');
      return false;
    }

    try {
      const client = await loadSupabaseClient();
      if (!client) throw new Error('SDK 加载失败');
      supabaseClient = client;
    } catch {
      alert('Supabase 初始化失败，请检查配置。');
      return false;
    }

    localStorage.setItem(SYNC_CLOUD_ENABLED_KEY, '1');
    const result = await runCloudSync({ forcePush: true });
    if (result.error) {
      localStorage.removeItem(SYNC_CLOUD_ENABLED_KEY);
      alert(`开启自动同步失败：${result.error}`);
      return false;
    }
    updateSettingsUI();
    return true;
  }

  function disableCloudSync() {
    localStorage.removeItem(SYNC_CLOUD_ENABLED_KEY);
    setStatus('disabled');
    updateSettingsUI();
  }

  function saveSyncKey(rawKey) {
    const syncKey = validateSyncKey(rawKey);
    localStorage.setItem(SYNC_KEY_STORAGE, syncKey);
    updateSettingsUI();
    return syncKey;
  }

  function normalizeSyncCodeInput(rawText) {
    const text = String(rawText || '')
      .replace(/^\uFEFF/, '')
      .trim()
      .replace(/\s/g, '');
    if (!text) {
      throw new Error('请粘贴同步码或选择同步文件');
    }
    if (/^[a-f0-9]{16,64}$/i.test(text)) {
      throw new Error(
        '您粘贴的是「同步密钥」（32 位十六进制），不是「同步码」。\n\n请在本机依次操作：保存密钥 → 点「复制同步码」→ 粘贴以 ST1:/ST2: 开头的长文本，或导出 .txt 文件。'
      );
    }
    const upper = text.toUpperCase();
    const st2Index = upper.indexOf(SYNC_CODE_PREFIX_COMPRESSED);
    const st1Index = upper.indexOf(SYNC_CODE_PREFIX);
    let prefix = '';
    let prefixIndex = -1;
    if (st2Index !== -1 && (st1Index === -1 || st2Index <= st1Index)) {
      prefix = SYNC_CODE_PREFIX_COMPRESSED;
      prefixIndex = st2Index;
    } else if (st1Index !== -1) {
      prefix = SYNC_CODE_PREFIX;
      prefixIndex = st1Index;
    }
    if (prefixIndex === -1) {
      throw new Error('同步码应以 ST1: 或 ST2: 开头。请点「复制同步码」获取，不要复制密钥。');
    }
    return {
      prefix,
      text: `${prefix}${text.slice(prefixIndex + prefix.length)}`,
    };
  }

  function decodeSyncCodePayload(text, prefix) {
    const body = text.slice(prefix.length);
    if (!body) {
      throw new Error('同步码内容损坏或不完整，请重新复制');
    }

    try {
      const payloadJson = new TextDecoder().decode(base64ToBuffer(body));
      return JSON.parse(payloadJson);
    } catch {
      try {
        return JSON.parse(atob(body));
      } catch {
        throw new Error('同步码内容损坏或不完整，请重新复制');
      }
    }
  }

  function requireSavedSyncKey() {
    const syncKey = getSyncKey();
    if (!syncKey) {
      throw new Error('请先在「同步密钥」中保存与导出设备相同的密钥');
    }
    return syncKey;
  }

  async function buildSyncCode(syncKey) {
    if (!callbacks.getData) {
      throw new Error('应用尚未就绪，请刷新页面后重试');
    }
    const localData = callbacks.getData();
    const payload = {
      ...localData,
      syncedAt: new Date().toISOString(),
    };
    const json = JSON.stringify(payload);

    if (supportsGzip()) {
      const gzipped = await gzipText(json);
      const encrypted = await encryptBytes(syncKey, gzipped);
      const wrapper = JSON.stringify(encrypted);
      return {
        code: `${SYNC_CODE_PREFIX_COMPRESSED}${bufferToBase64(new TextEncoder().encode(wrapper))}`,
        rawBytes: json.length,
        compressed: true,
      };
    }

    const encrypted = await encryptPayload(syncKey, payload);
    const payloadJson = JSON.stringify(encrypted);
    return {
      code: `${SYNC_CODE_PREFIX}${bufferToBase64(new TextEncoder().encode(payloadJson))}`,
      rawBytes: json.length,
      compressed: false,
    };
  }

  function formatCodeSize(length) {
    if (length < 1024) return `${length} 字符`;
    return `${(length / 1024).toFixed(1)} KB（${length} 字符）`;
  }

  function buildCodeSizeHint(result) {
    const { code, rawBytes, compressed } = result;
    const parts = [`同步码长度：${formatCodeSize(code.length)}`];
    if (compressed) {
      parts.push(`已压缩（原始数据约 ${formatCodeSize(rawBytes)}）`);
    }
    if (code.length > WECHAT_TEXT_WARN_CHARS) {
      parts.push('较长，建议点「导出文件」经微信文件传输助手发送');
    }
    return parts.join(' · ');
  }

  function downloadSyncCodeFile(code) {
    const blob = new Blob([code], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `study-sync-${new Date().toISOString().slice(0, 10)}.txt`;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
  }

  async function copyFromTextarea(textarea) {
    if (!textarea) return false;
    textarea.focus();
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(textarea.value);
        return true;
      }
    } catch {
      /* fall through */
    }
    try {
      return document.execCommand('copy');
    } catch {
      return false;
    }
  }

  async function copyStringWithFallback(text) {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      /* fall through */
    }
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '0';
    ta.style.left = '0';
    ta.style.width = '1px';
    ta.style.height = '1px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    document.body.removeChild(ta);
    return ok;
  }

  function setSyncCodeStatus(message) {
    const el = document.getElementById('syncCodeCopyStatus');
    if (el) el.textContent = message || '';
  }

  function openSyncCodeModal(result) {
    const modal = document.getElementById('syncCodeModal');
    const textarea = document.getElementById('syncCodeExportText');
    if (!modal || !textarea) {
      alert('同步码弹窗加载失败，请刷新页面后重试');
      return;
    }
    const code = typeof result === 'string' ? result : result.code;
    textarea.value = code;
    setSyncCodeStatus(typeof result === 'string' ? '' : buildCodeSizeHint(result));
    showDialog(modal);
    requestAnimationFrame(() => {
      textarea.focus();
      textarea.select();
    });
  }

  function closeSyncCodeModal() {
    hideDialog(document.getElementById('syncCodeModal'));
  }

  async function shareSyncCode(text) {
    if (!navigator.share) return false;
    try {
      const file = new File([text], 'study-sync.txt', { type: 'text/plain' });
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({
          title: '学习进度同步码',
          files: [file],
        });
        return true;
      }
      if (text.length <= WECHAT_TEXT_WARN_CHARS) {
        await navigator.share({
          title: '学习进度同步码',
          text,
        });
        return true;
      }
      return false;
    } catch (err) {
      if (err?.name === 'AbortError') return true;
      return false;
    }
  }

  async function copyText(text, successMessage) {
    const ok = await copyStringWithFallback(text);
    if (ok) {
      alert(successMessage);
      return true;
    }
    alert('无法自动复制，请长按文本全选后手动复制。');
    return false;
  }

  async function exportSyncCode() {
    const input = document.getElementById('syncKeyInput');
    if (input?.value.trim() && !hasSyncKey()) {
      try {
        saveSyncKey(input.value);
      } catch (err) {
        alert(err.message);
        openSyncModal();
        return;
      }
    }

    let syncKey;
    try {
      syncKey = requireSavedSyncKey();
    } catch (err) {
      alert(`${err.message}\n\n请打开「同步密钥」，填写后点「保存密钥」。`);
      openSyncModal();
      return;
    }

    try {
      const result = await buildSyncCode(syncKey);
      openSyncCodeModal(result);
      const hint =
        result.code.length > WECHAT_TEXT_WARN_CHARS
          ? '同步码较长，建议优先点「导出文件」发送到微信文件传输助手'
          : '请点「复制」或「导出文件」发送到另一台设备';
      setSyncCodeStatus(`${buildCodeSizeHint(result)}。${hint}`);
    } catch (err) {
      alert(err.message || '生成同步码失败');
    }
  }

  async function importSyncCode(rawText) {
    const { prefix, text } = normalizeSyncCodeInput(rawText);
    const syncKey = requireSavedSyncKey();
    const encrypted = decodeSyncCodePayload(text, prefix);

    if (!encrypted?.payload || !encrypted?.iv) {
      throw new Error('同步码内容无效，请重新复制');
    }

    let remoteData;
    try {
      if (prefix === SYNC_CODE_PREFIX_COMPRESSED) {
        const bytes = await decryptBytes(syncKey, encrypted.payload, encrypted.iv);
        remoteData = JSON.parse(await gunzipText(bytes));
      } else {
        remoteData = await decryptPayload(syncKey, encrypted.payload, encrypted.iv);
      }
    } catch {
      throw new Error('解密失败，请确认两台设备使用了相同的同步密钥，且同步码完整未截断');
    }

    const localData = callbacks.getData ? callbacks.getData() : {};
    const merged = mergePayload(localData, remoteData);

    if (callbacks.applyData) callbacks.applyData(merged);
    setLastSyncAt(merged.syncedAt);
    updateSettingsUI();
    if (isCloudEnabled()) schedulePush();
    return summarizeData(merged);
  }

  function updateSettingsUI() {
    const statusEl = document.getElementById('syncStatus');
    const keyEl = document.getElementById('syncKeyPreview');
    const btnSyncNow = document.getElementById('btnSyncNow');
    const btnDisableCloud = document.getElementById('btnDisableCloud');
    const btnEnableCloud = document.getElementById('btnEnableCloud');
    const btnCopyCode = document.getElementById('btnCopySyncCode');
    const btnPasteCode = document.getElementById('btnPasteSyncCode');

    if (statusEl) statusEl.textContent = getStatusLabel();
    if (keyEl) keyEl.textContent = hasSyncKey() ? maskSyncKey(getSyncKey()) : '未设置';
    if (btnSyncNow) btnSyncNow.hidden = !isCloudEnabled();
    if (btnDisableCloud) btnDisableCloud.hidden = !isCloudEnabled();
    if (btnEnableCloud) btnEnableCloud.hidden = !hasSyncKey() || isCloudEnabled() || !isCloudConfigured();
    if (btnCopyCode) btnCopyCode.hidden = !hasSyncKey();
    if (btnPasteCode) btnPasteCode.hidden = false;

    const input = document.getElementById('syncKeyInput');
    if (input && document.activeElement !== input && hasSyncKey()) {
      input.value = getSyncKey();
    }
  }

  function openSyncModal() {
    const modal = document.getElementById('syncModal');
    if (!modal) {
      alert('同步功能加载失败，请刷新页面或检查更新。');
      return;
    }
    const input = document.getElementById('syncKeyInput');
    if (input) input.value = getSyncKey();
    updateSettingsUI();
    showDialog(modal);
  }

  function closeSyncModal() {
    hideDialog(document.getElementById('syncModal'));
  }

  function openPasteModal() {
    const modal = document.getElementById('pasteSyncModal');
    const textarea = document.getElementById('pasteSyncInput');
    if (!modal) {
      alert('同步功能加载失败，请刷新页面或检查更新。');
      return;
    }
    if (textarea) textarea.value = '';
    showDialog(modal);
  }

  function closePasteModal() {
    hideDialog(document.getElementById('pasteSyncModal'));
  }

  async function copySyncKey() {
    const input = document.getElementById('syncKeyInput');
    const key = validateSyncKey(input?.value || getSyncKey());
    await copyText(
      key,
      '同步密钥已复制。\n\n请在另一台设备的「同步密钥」中粘贴并保存。\n\n注意：密钥不是同步码，传数据还需再点「复制同步码」。'
    );
  }

  function bindUI() {
    if (uiBound) return;
    uiBound = true;

    document.getElementById('btnSyncSetup')?.addEventListener('click', openSyncModal);
    document.getElementById('btnSyncNow')?.addEventListener('click', async () => {
      const result = await runCloudSync({ forcePush: true });
      alert(result.error ? `同步失败：${result.error}` : '同步完成');
    });
    document.getElementById('btnCopySyncCode')?.addEventListener('click', exportSyncCode);
    document.getElementById('btnPasteSyncCode')?.addEventListener('click', openPasteModal);
    document.getElementById('btnCloseSync')?.addEventListener('click', closeSyncModal);
    document.getElementById('btnCancelSync')?.addEventListener('click', closeSyncModal);
    document.getElementById('btnGenerateSyncKey')?.addEventListener('click', () => {
      const input = document.getElementById('syncKeyInput');
      if (input) input.value = generateSyncKey();
    });
    document.getElementById('btnCopySyncKey')?.addEventListener('click', copySyncKey);
    document.getElementById('btnCopySyncCodeInModal')?.addEventListener('click', exportSyncCode);
    document.getElementById('btnCopySyncCodeConfirm')?.addEventListener('click', async () => {
      const textarea = document.getElementById('syncCodeExportText');
      const ok = await copyFromTextarea(textarea);
      setSyncCodeStatus(ok ? '已复制完整同步码，可去另一台设备粘贴' : '复制失败，请长按上方文本框 → 全选 → 拷贝');
    });
    document.getElementById('btnShareSyncCode')?.addEventListener('click', async () => {
      const text = document.getElementById('syncCodeExportText')?.value;
      if (!text) return;
      const ok = await shareSyncCode(text);
      setSyncCodeStatus(
        ok
          ? '已打开分享，请发送到微信文件传输助手'
          : '文本过长或当前浏览器不支持分享，请点「导出文件」或「复制」'
      );
    });
    document.getElementById('btnExportSyncFile')?.addEventListener('click', () => {
      const text = document.getElementById('syncCodeExportText')?.value;
      if (!text) return;
      downloadSyncCodeFile(text);
      setSyncCodeStatus('已下载 .txt 文件，可用微信「文件传输助手」发送');
    });
    document.getElementById('btnCloseSyncCode')?.addEventListener('click', closeSyncCodeModal);
    document.getElementById('btnCloseSyncCodeFooter')?.addEventListener('click', closeSyncCodeModal);
    document.getElementById('syncCodeModal')?.addEventListener('click', (e) => {
      if (e.target.id === 'syncCodeModal') closeSyncCodeModal();
    });
    document.getElementById('btnSaveSyncKey')?.addEventListener('click', () => {
      const input = document.getElementById('syncKeyInput');
      try {
        saveSyncKey(input?.value);
        alert('密钥已保存。\n\n可开启「自动同步」，或使用「复制同步码」手动传输。');
      } catch (err) {
        alert(err.message);
      }
    });
    document.getElementById('btnEnableCloud')?.addEventListener('click', async () => {
      const input = document.getElementById('syncKeyInput');
      if (input?.value.trim()) {
        try {
          saveSyncKey(input.value);
        } catch (err) {
          alert(err.message);
          return;
        }
      }
      const ok = await enableCloudSync();
      if (ok) {
        alert('自动同步已开启！');
        closeSyncModal();
      }
    });
    document.getElementById('btnDisableCloud')?.addEventListener('click', () => {
      if (confirm('关闭后不再自动同步，云端数据仍保留。确定吗？')) {
        disableCloudSync();
        closeSyncModal();
      }
    });
    document.getElementById('btnImportSyncFile')?.addEventListener('click', () => {
      document.getElementById('syncFileInput')?.click();
    });
    document.getElementById('syncFileInput')?.addEventListener('change', async (event) => {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (!file) return;
      try {
        const text = await file.text();
        const summary = await importSyncCode(text);
        alert(
          `同步成功！\n\n目标 ${summary.goals} 个\n每日任务 ${summary.dailyTasks} 条\n作息记录 ${summary.sleepDays} 天\n健身打卡 ${summary.gymDays} 天`
        );
        closePasteModal();
      } catch (err) {
        alert(`导入失败：${err.message}\n\n请确认文件完整，且密钥与导出时一致。`);
      }
    });
    document.getElementById('btnClosePasteSync')?.addEventListener('click', closePasteModal);
    document.getElementById('btnCancelPasteSync')?.addEventListener('click', closePasteModal);
    document.getElementById('btnConfirmPasteSync')?.addEventListener('click', async () => {
      const text = document.getElementById('pasteSyncInput')?.value;
      try {
        const summary = await importSyncCode(text);
        alert(
          `同步成功！\n\n目标 ${summary.goals} 个\n每日任务 ${summary.dailyTasks} 条\n作息记录 ${summary.sleepDays} 天\n健身打卡 ${summary.gymDays} 天`
        );
        closePasteModal();
      } catch (err) {
        alert(`导入失败：${err.message}\n\n请确认同步码完整，且密钥与导出时一致。`);
      }
    });
    document.getElementById('syncModal')?.addEventListener('click', (e) => {
      if (e.target.id === 'syncModal') closeSyncModal();
    });
    document.getElementById('pasteSyncModal')?.addEventListener('click', (e) => {
      if (e.target.id === 'pasteSyncModal') closePasteModal();
    });

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && isCloudEnabled()) runCloudSync();
    });
  }

  function bootSyncUI() {
    bindUI();
    updateSettingsUI();
  }

  window.StudySync = {
    init(options = {}) {
      callbacks = { ...callbacks, ...options };
      bootSyncUI();
      initCloudClient();
      setStatus(isCloudEnabled() ? 'ok' : 'disabled');
    },
    isConfigured: isCloudConfigured,
    isEnabled: isCloudEnabled,
    getStatusLabel,
    schedulePush,
    syncOnLaunch() {
      if (!isCloudEnabled()) return Promise.resolve({ changed: false });
      return runCloudSync();
    },
    syncNow: () => runCloudSync({ forcePush: true }),
    updateSettingsUI,
    openSyncModal,
    openPasteModal,
    exportSyncCode,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootSyncUI);
  } else {
    bootSyncUI();
  }
})();
