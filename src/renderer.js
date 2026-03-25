let state = {
  config: { providers: {}, primary: '' },
  profiles: {},
  currentProvider: null,
  editingApiKey: false,
};

let gatewayState = {
  installed: false,
  running: false,
  port: 18789,
  checking: true,
  starting: false,
  stopping: false,
};

// ── Model Presets ──────────────────────────────────────────────
const MODEL_PRESETS = {
  'deepseek-chat': { id: 'deepseek-chat', name: 'DeepSeek V3', reasoning: false, input: ['text'], cost: { input: 0.5, output: 2, cacheRead: 0.1, cacheWrite: 0.5 }, contextWindow: 65536, maxTokens: 8192 },
  'deepseek-reasoner': { id: 'deepseek-reasoner', name: 'DeepSeek R1', reasoning: true, input: ['text'], cost: { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 2 }, contextWindow: 65536, maxTokens: 8192 },
  'k2p5': { id: 'k2p5', name: 'Kimi K2', reasoning: true, input: ['text', 'image'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 262144, maxTokens: 32768 },
  'claude-sonnet-4-6': { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', reasoning: true, input: ['text', 'image'], cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }, contextWindow: 200000, maxTokens: 8192 },
  'claude-opus-4-6': { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', reasoning: true, input: ['text', 'image'], cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 }, contextWindow: 200000, maxTokens: 8192 },
  'gpt-4o': { id: 'gpt-4o', name: 'GPT-4o', reasoning: false, input: ['text', 'image'], cost: { input: 2.5, output: 10, cacheRead: 1.25, cacheWrite: 2.5 }, contextWindow: 128000, maxTokens: 16384 },
  'qwen3:8b': { id: 'qwen3:8b', name: 'Qwen3 8B', reasoning: true, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 8192 },
};

// ── Init ──────────────────────────────────────────────
async function init() {
  const data = await window.api.getData();
  state.config = data.config;
  state.profiles = data.profiles;
  renderSidebar();
  renderPrimaryBar();
  if (Object.keys(state.config.providers).length > 0) {
    // Select the provider of the current primary model
    const primaryProvider = state.config.primary ? state.config.primary.split('/')[0] : null;
    const firstProvider = Object.keys(state.config.providers)[0];
    selectProvider(primaryProvider && state.config.providers[primaryProvider] ? primaryProvider : firstProvider);
  }
  // Gateway status — check first, show wizard if not installed or config missing
  const gwStatus = await window.api.checkGateway();
  gatewayState.installed = gwStatus.installed;
  gatewayState.running = gwStatus.running;
  gatewayState.port = gwStatus.port;
  gatewayState.checking = false;
  renderGatewayStatus();

  // 检测配置文件是否存在
  const env = await window.api.checkEnv();
  if (!gwStatus.installed || !env.configExists) {
    showInstallWizard();
  }

  setInterval(checkGatewayStatus, 10000);
  // Gateway output listener
  initGatewayLog();
  // Install output listener
  window.api.onInstallOutput(() => {}); // pre-register channel
}

// ── Tab Switching ──────────────────────────────────────────────
let currentTab = 'config';

function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.tab-item').forEach(el => {
    el.classList.toggle('active', el.dataset.tab === tab);
  });
  document.getElementById('tabConfig').classList.toggle('active', tab === 'config');
  document.getElementById('tabLogs').classList.toggle('active', tab === 'logs');
  document.getElementById('tabTerminal').classList.toggle('active', tab === 'terminal');
  document.getElementById('tabAgents').classList.toggle('active', tab === 'agents');
  // Show/hide primary bar based on tab
  document.getElementById('primaryBar').style.display = tab === 'config' ? '' : 'none';
  // Auto-scroll terminal when switching to logs
  if (tab === 'logs') {
    const log = document.getElementById('terminalLog');
    log.scrollTop = log.scrollHeight;
  }
  // Auto-scroll terminal output when switching to terminal
  if (tab === 'terminal') {
    const output = document.getElementById('terminalOutput');
    output.scrollTop = output.scrollHeight;
  }
  // Load agents when switching to agents tab
  if (tab === 'agents') {
    renderAgents();
  }
}

// ── Gateway Log ──────────────────────────────────────────────
const MAX_LOG_LINES = 2000;
let logLines = [];

// ANSI SGR code → CSS color mapping
const ANSI_COLORS = {
  '30': '#4b5563', '31': '#ef4444', '32': '#22c55e', '33': '#f59e0b',
  '34': '#3b82f6', '35': '#a855f7', '36': '#06b6d4', '37': '#e2e8f0',
  '90': '#6b7280', '91': '#f87171', '92': '#4ade80', '93': '#fbbf24',
  '94': '#60a5fa', '95': '#c084fc', '96': '#22d3ee', '97': '#f8fafc',
};

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// 检测行内是否包含 ANSI 转义码
function hasAnsi(line) {
  return /\x1b\[/.test(line);
}

function ansiToHtml(line) {
  let html = '';
  let openSpan = false;
  let i = 0;
  while (i < line.length) {
    if (line[i] === '\x1b' && line[i + 1] === '[') {
      const end = line.indexOf('m', i + 2);
      if (end === -1) { html += escapeHtml(line[i]); i++; continue; }
      const codes = line.substring(i + 2, end).split(';');
      i = end + 1;
      if (codes.includes('0') || codes.length === 0) {
        if (openSpan) { html += '</span>'; openSpan = false; }
        continue;
      }
      let color = null;
      let bold = false;
      for (const c of codes) {
        if (c === '1') bold = true;
        if (ANSI_COLORS[c]) color = ANSI_COLORS[c];
      }
      if (color) {
        if (openSpan) html += '</span>';
        html += `<span style="color:${color}${bold ? ';font-weight:600' : ''}">`;
        openSpan = true;
      }
    } else {
      html += escapeHtml(line[i]);
      i++;
    }
  }
  if (openSpan) html += '</span>';
  return html;
}

// 纯文本日志 → 基于内容模式着色 (当进程不输出 ANSI 时的 fallback)
function colorizePlainLine(line) {
  const safe = escapeHtml(line);
  // 空行
  if (!safe.trim()) return safe;

  // 整行为错误/警告
  if (/\b(error|ERR!|FATAL|exception|failed|失败)\b/i.test(line)) {
    return `<span style="color:#ef4444">${safe}</span>`;
  }
  if (/\b(warn|warning|WARN)\b/i.test(line)) {
    return `<span style="color:#f59e0b">${safe}</span>`;
  }

  // 逐段着色
  return safe
    // ISO 时间戳 → 暗灰
    .replace(/(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)/g, '<span style="color:#6b7280">$1</span>')
    // [tag] 方括号标签 → 青色
    .replace(/(\[[^\]]{1,30}\])/g, '<span style="color:#06b6d4">$1</span>')
    // 数字端口/状态码 → 黄色
    .replace(/\b(:\d{2,5})\b/g, '<span style="color:#f59e0b">$1</span>')
    // http(s) URL → 蓝色
    .replace(/(https?:\/\/[^\s,'"]+)/g, '<span style="color:#60a5fa">$1</span>')
    // 关键成功词 → 绿色
    .replace(/\b(listening|started|ready|running|connected|success|ok|启动成功|已启动)\b/gi, '<span style="color:#22c55e;font-weight:600">$&</span>')
    // 关键信息词 → 绿色偏亮
    .replace(/\b(gateway|openclaw|loaded|registered|model|provider)\b/gi, '<span style="color:#4ade80">$&</span>')
    // 进程退出信息
    .replace(/(\[进程已退出.*?\])/g, '<span style="color:#f59e0b;font-weight:600">$1</span>')
    .replace(/(\[启动错误\].*)/g, '<span style="color:#ef4444;font-weight:600">$1</span>');
}

function colorizeLine(line) {
  if (hasAnsi(line)) return ansiToHtml(line);
  return colorizePlainLine(line);
}

function initGatewayLog() {
  window.api.onGatewayOutput((text) => {
    const newLines = text.split('\n');
    logLines.push(...newLines);
    if (logLines.length > MAX_LOG_LINES) {
      logLines = logLines.slice(logLines.length - MAX_LOG_LINES);
    }
    renderTerminalLog();
  });
}

function renderTerminalLog() {
  const logEl = document.getElementById('terminalLog');
  const emptyEl = document.getElementById('terminalEmpty');
  if (logLines.length === 0) {
    logEl.style.display = 'none';
    emptyEl.style.display = '';
    return;
  }
  emptyEl.style.display = 'none';
  logEl.style.display = '';
  logEl.innerHTML = logLines.map(l => colorizeLine(l)).join('\n');
  logEl.scrollTop = logEl.scrollHeight;
}

// ── Gateway ──────────────────────────────────────────────
async function checkGatewayStatus() {
  try {
    const result = await window.api.checkGateway();
    gatewayState.installed = result.installed;
    gatewayState.running = result.running;
    gatewayState.port = result.port;
    gatewayState.checking = false;
    renderGatewayStatus();
  } catch {
    gatewayState.checking = false;
    renderGatewayStatus();
  }
}

async function startGateway() {
  if (gatewayState.starting) return;
  gatewayState.starting = true;
  renderGatewayStatus();
  try {
    const result = await window.api.startGateway();
    showToast(result.message, result.success ? 'success' : 'error');
    // 持续轮询直到确认运行或超时
    for (let i = 0; i < 10; i++) {
      await checkGatewayStatus();
      if (gatewayState.running) break;
      await new Promise(r => setTimeout(r, 2000));
    }
  } catch (err) {
    showToast('启动失败: ' + err.message, 'error');
  }
  gatewayState.starting = false;
  renderGatewayStatus();
}

async function stopGateway() {
  if (gatewayState.stopping) return;
  gatewayState.stopping = true;
  renderGatewayStatus();
  try {
    const result = await window.api.stopGateway();
    showToast(result.message, result.success ? 'success' : 'error');
    await checkGatewayStatus();
  } catch (err) {
    showToast('停止失败: ' + err.message, 'error');
  }
  gatewayState.stopping = false;
  renderGatewayStatus();
}

async function openDashboard() {
  showToast('正在获取 Dashboard 链接...', 'success');
  try {
    const result = await window.api.openDashboard();
    if (!result.success) showToast(result.message, 'error');
  } catch (err) {
    showToast('打开失败: ' + err.message, 'error');
  }
}

function renderGatewayStatus() {
  const bar = document.getElementById('gatewayBar');
  const float = document.getElementById('gatewayStatusFloat');
  if (!bar) return;

  if (gatewayState.checking) {
    bar.innerHTML = `<span class="gw-label">Gateway</span><span style="color:var(--text3); font-size:12px;">检查中...</span>`;
    if (float) float.innerHTML = '';
    return;
  }

  if (!gatewayState.installed) {
    bar.innerHTML = `
      <span class="gw-label">Gateway</span>
      <span style="color:var(--yellow); font-size:12px;">需要先安装 OpenClaw 环境</span>
    `;
    if (float) float.classList.add('hidden');
    return;
  }

  const isRunning = gatewayState.running;
  const starting = gatewayState.starting;
  const stopping = gatewayState.stopping;

  const busy = starting || stopping;

  bar.innerHTML = `
    <span class="gw-label">Gateway</span>
    <button class="btn btn-green btn-sm" onclick="startGateway()" ${isRunning || busy ? 'disabled style="opacity:.5; cursor:not-allowed;"' : ''}>
      ${starting ? '<span class="btn-spinner"></span> 启动中...' : '启动龙虾'}
    </button>
    <button class="btn btn-danger btn-sm" onclick="stopGateway()" ${!isRunning || busy ? 'disabled style="opacity:.5; cursor:not-allowed;"' : ''}>
      ${stopping ? '<span class="btn-spinner" style="border-color:rgba(239,68,68,.3);border-top-color:var(--red);"></span> 停止中...' : '停止龙虾'}
    </button>
    <button class="btn btn-primary btn-sm" onclick="openDashboard()" ${!isRunning || busy ? 'disabled style="opacity:.4; cursor:not-allowed;"' : ''}>
      启动界面
    </button>
    <div style="flex:1;"></div>
    ${isRunning ? `
      <span class="gw-dot gw-running"></span>
      <span style="color:var(--green); font-weight:500; font-size:12px;">运行中</span>
      <span style="color:var(--text3); font-family:monospace; font-size:10px;">:${gatewayState.port}</span>
    ` : `
      <span class="gw-dot gw-stopped"></span>
      <span style="color:var(--text3); font-size:12px;">未运行</span>
    `}
  `;

  if (float) float.classList.add('hidden');
}

// ── Primary Bar (top) ──────────────────────────────────────────────
function renderPrimaryBar() {
  const bar = document.getElementById('primaryBar');
  const primary = state.config.primary || '(未设置)';
  const [prov, modelId] = primary.includes('/') ? primary.split('/') : ['', ''];

  // Find model name
  let modelName = primary;
  if (prov && state.config.providers[prov]) {
    const m = state.config.providers[prov].models.find(m => m.id === modelId);
    if (m) modelName = m.name;
  }

  // Build all available models for dropdown
  const allModels = [];
  Object.entries(state.config.providers).forEach(([provName, p]) => {
    p.models.forEach(m => {
      const key = `${provName}/${m.id}`;
      allModels.push({ key, provName, model: m, isCurrent: key === primary });
    });
  });

  bar.innerHTML = `
    <div style="display: flex; align-items: center; gap: 10px; font-size: 12px; color: var(--text2);">
      <span style="color: var(--text3);">当前模型</span>
      <span style="color: var(--green); font-weight: 600; font-size: 13px;">${modelName}</span>
      <span style="color: var(--text3); font-family: monospace; font-size: 11px;">${primary}</span>
    </div>
    <div style="display: flex; gap: 6px; flex-wrap: wrap;">
      ${allModels.map(m => `
        <button class="btn ${m.isCurrent ? 'btn-green' : 'btn-ghost'} btn-sm"
          onclick="setPrimary('${m.key}')"
          title="${m.key}"
          ${m.isCurrent ? 'disabled' : ''}>
          ${m.model.name}
        </button>
      `).join('')}
    </div>
  `;
}

async function setPrimary(key) {
  try {
    const updated = await window.api.setPrimary(key);
    state.config = updated;
    renderPrimaryBar();
    renderMain();
    renderSidebar();
    showToast(`已切换到: ${key}`, 'success');
    // 如果 Gateway 正在运行，自动重启让配置生效
    if (gatewayState.running) {
      showToast('正在重启 Gateway 使配置生效...', 'success');
      await restartGateway();
    }
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function restartGateway() {
  gatewayState.stopping = true;
  renderGatewayStatus();
  try {
    await window.api.stopGateway();
  } catch { /* ignore */ }
  gatewayState.stopping = false;
  // 等一下再启动
  await new Promise(r => setTimeout(r, 500));
  gatewayState.starting = true;
  renderGatewayStatus();
  try {
    const result = await window.api.startGateway();
    showToast(result.message, result.success ? 'success' : 'error');
  } catch (err) {
    showToast('重启失败: ' + err.message, 'error');
  }
  gatewayState.starting = false;
  await checkGatewayStatus();
}

// ── Sidebar ──────────────────────────────────────────────
function renderSidebar() {
  const list = document.getElementById('sidebarList');
  list.innerHTML = '';
  const primaryProv = state.config.primary ? state.config.primary.split('/')[0] : '';

  Object.keys(state.config.providers).forEach(name => {
    const item = document.createElement('div');
    const isActive = name === state.currentProvider;
    const isPrimary = name === primaryProv;
    item.className = 'sidebar-item' + (isActive ? ' active' : '');
    item.onclick = () => selectProvider(name);

    const modelCount = state.config.providers[name].models.length;

    item.innerHTML = `
      <div class="dot" ${isPrimary ? 'style="background: var(--green);"' : ''}></div>
      <div class="name">${name}</div>
      <div class="badge">${modelCount}M</div>
    `;
    list.appendChild(item);
  });
}

function selectProvider(name) {
  state.currentProvider = name;
  state.editingApiKey = false;
  renderSidebar();
  renderMain();
}

// ── Main ──────────────────────────────────────────────
function renderMain() {
  const main = document.getElementById('mainContent');
  if (!state.currentProvider) {
    main.innerHTML = `
      <div class="empty">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/>
        </svg>
        <span>选择左侧 Provider 开始管理</span>
      </div>
    `;
    return;
  }

  const provider = state.config.providers[state.currentProvider];
  const profiles = state.profiles[state.currentProvider] || {};
  const currentKey = provider.apiKey;
  const primary = state.config.primary || '';

  main.innerHTML = `
    <div class="provider-header">
      <div class="provider-icon">🔑</div>
      <div class="provider-info">
        <div class="provider-name">${state.currentProvider}</div>
        <div class="provider-url">${provider.baseUrl} &nbsp; <span style="color:var(--text3); font-size:11px;">${provider.api}</span></div>
      </div>
      <div class="provider-actions">
        <button class="btn btn-danger btn-sm" onclick="deleteProvider()">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
          </svg>
          删除
        </button>
      </div>
    </div>

    <div class="card">
      <div class="card-title">API Key</div>
      <div class="apikey-row">
        ${state.editingApiKey ? `
          <input class="apikey-input" id="apikeyInput" value="${currentKey}" placeholder="sk-...">
          <button class="btn btn-green" onclick="saveApiKey()">保存</button>
          <button class="btn btn-ghost" onclick="cancelEditApiKey()">取消</button>
        ` : `
          <div class="apikey-display">${maskApiKey(currentKey)}</div>
          <button class="btn btn-ghost" onclick="startEditApiKey()">修改</button>
          <button class="btn btn-primary" onclick="showSaveProfileModal()">保存为 Profile</button>
        `}
      </div>
    </div>

    <div class="card">
      <div class="card-title" style="display: flex; align-items: center; justify-content: space-between;">
        <span>Models (${provider.models.length})</span>
        <button class="btn btn-primary btn-sm" onclick="showAddModelModal()">+ 添加模型</button>
      </div>
      ${provider.models.length === 0 ? `
        <div style="color: var(--text3); font-size: 13px; text-align: center; padding: 20px 0;">
          暂无模型，点击上方按钮添加
        </div>
      ` : provider.models.map(m => {
        const modelKey = `${state.currentProvider}/${m.id}`;
        const isPrimary = modelKey === primary;
        return `
        <div class="model-row" style="${isPrimary ? 'background: rgba(34,197,94,.06); border-radius: 6px; padding: 8px 10px; margin: 0 -10px;' : ''}">
          ${isPrimary ? '<div style="width:4px; height:24px; background:var(--green); border-radius:2px; flex-shrink:0;"></div>' : ''}
          <div class="model-id">${m.id}</div>
          <div class="model-name">${m.name}</div>
          ${m.reasoning ? '<div class="model-tag reasoning">Reasoning</div>' : ''}
          ${m.input && m.input.includes('image') ? '<div class="model-tag image">Image</div>' : ''}
          <div style="font-size:10px; color:var(--text3); white-space:nowrap;">${formatTokens(m.contextWindow)}</div>
          ${isPrimary ? `
            <div class="model-tag" style="background: rgba(34,197,94,.15); color: var(--green);">当前</div>
          ` : `
            <button class="btn btn-green btn-sm" onclick="setPrimary('${modelKey}')" style="font-size:10px; padding:3px 8px;">
              设为主模型
            </button>
          `}
          <button class="model-delete" onclick="deleteModel('${m.id}')" title="删除模型">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>
        `;
      }).join('')}
    </div>

    <div class="card">
      <div class="card-title">Profiles (${Object.keys(profiles).length})</div>
      <div class="profiles-grid">
        ${Object.entries(profiles).map(([name, p]) => {
          const isCurrent = p.apiKey === currentKey;
          return `
            <div class="profile-card ${isCurrent ? 'current' : ''}" onclick="switchToProfile('${name}')">
              <div class="profile-card-name">
                ${name}
                ${isCurrent ? '<span class="current-badge">当前</span>' : ''}
              </div>
              <div class="profile-card-key">${maskApiKey(p.apiKey)}</div>
              <div class="profile-card-date">${formatDate(p.savedAt)}</div>
              <div class="profile-card-actions">
                <button class="btn btn-danger btn-sm" onclick="event.stopPropagation(); deleteProfileConfirm('${name}')">
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/>
                  </svg>
                </button>
              </div>
            </div>
          `;
        }).join('')}
        <div class="profile-add-card" onclick="showSaveProfileModal()">+ 添加 Profile</div>
      </div>
    </div>
  `;
}

// ── API Key editing ──────────────────────────────────────────────
function startEditApiKey() { state.editingApiKey = true; renderMain(); document.getElementById('apikeyInput')?.focus(); }
function cancelEditApiKey() { state.editingApiKey = false; renderMain(); }

async function saveApiKey() {
  const newKey = document.getElementById('apikeyInput').value.trim();
  if (!newKey) { showToast('API Key 不能为空', 'error'); return; }
  try {
    const updated = await window.api.updateApiKey(state.currentProvider, newKey);
    state.config = updated;
    state.editingApiKey = false;
    renderMain();
    showToast('API Key 已更新', 'success');
  } catch (err) { showToast(err.message, 'error'); }
}

// ── Models ──────────────────────────────────────────────
function showAddModelModal() {
  document.getElementById('newModelId').value = '';
  document.getElementById('newModelName').value = '';
  document.getElementById('newModelContext').value = '65536';
  document.getElementById('newModelMaxTokens').value = '8192';
  document.getElementById('newModelReasoning').checked = false;
  document.getElementById('newModelImage').checked = false;
  showModal('addModelModal');
}

function applyModelPreset(presetId) {
  const p = MODEL_PRESETS[presetId];
  if (!p) return;
  document.getElementById('newModelId').value = p.id;
  document.getElementById('newModelName').value = p.name;
  document.getElementById('newModelContext').value = p.contextWindow;
  document.getElementById('newModelMaxTokens').value = p.maxTokens;
  document.getElementById('newModelReasoning').checked = p.reasoning;
  document.getElementById('newModelImage').checked = p.input && p.input.includes('image');
}

async function submitAddModel() {
  const id = document.getElementById('newModelId').value.trim();
  const name = document.getElementById('newModelName').value.trim();
  const contextWindow = parseInt(document.getElementById('newModelContext').value) || 65536;
  const maxTokens = parseInt(document.getElementById('newModelMaxTokens').value) || 8192;
  const reasoning = document.getElementById('newModelReasoning').checked;
  const image = document.getElementById('newModelImage').checked;
  if (!id || !name) { showToast('请填写模型 ID 和名称', 'error'); return; }

  const input = ['text'];
  if (image) input.push('image');
  const model = { id, name, reasoning, input, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow, maxTokens };
  if (MODEL_PRESETS[id]) model.cost = { ...MODEL_PRESETS[id].cost };

  try {
    const updated = await window.api.addModel(state.currentProvider, model);
    state.config = updated;
    hideModal('addModelModal');
    renderSidebar();
    renderPrimaryBar();
    renderMain();
    showToast(`模型 "${name}" 已添加`, 'success');
  } catch (err) { showToast(err.message, 'error'); }
}

async function deleteModel(modelId) {
  if (!confirm(`确定删除模型 "${modelId}"？`)) return;
  try {
    const updated = await window.api.deleteModel(state.currentProvider, modelId);
    state.config = updated;
    renderSidebar();
    renderPrimaryBar();
    renderMain();
    showToast(`模型 "${modelId}" 已删除`, 'success');
  } catch (err) { showToast(err.message, 'error'); }
}

// ── Profiles ──────────────────────────────────────────────
function showSaveProfileModal() { document.getElementById('newProfileName').value = ''; showModal('saveProfileModal'); }

async function submitSaveProfile() {
  const name = document.getElementById('newProfileName').value.trim();
  if (!name) { showToast('请输入 Profile 名称', 'error'); return; }
  try {
    const updated = await window.api.saveProfile(state.currentProvider, name);
    state.profiles = updated;
    hideModal('saveProfileModal');
    renderMain();
    showToast(`Profile "${name}" 已保存`, 'success');
  } catch (err) { showToast(err.message, 'error'); }
}

async function switchToProfile(profileName) {
  try {
    const updated = await window.api.switchProfile(state.currentProvider, profileName);
    state.config = updated;
    renderMain();
    showToast(`已切换到 Profile: ${profileName}`, 'success');
  } catch (err) { showToast(err.message, 'error'); }
}

async function deleteProfileConfirm(profileName) {
  if (!confirm(`确定删除 Profile "${profileName}"？`)) return;
  try {
    const updated = await window.api.deleteProfile(state.currentProvider, profileName);
    state.profiles = updated;
    renderMain();
    showToast(`Profile "${profileName}" 已删除`, 'success');
  } catch (err) { showToast(err.message, 'error'); }
}

// ── Add Provider ──────────────────────────────────────────────
function showAddProviderModal() {
  document.getElementById('newProviderName').value = '';
  document.getElementById('newProviderUrl').value = '';
  document.getElementById('newProviderKey').value = '';
  document.getElementById('newProviderApi').value = 'openai-completions';
  showModal('addProviderModal');
}

async function submitAddProvider() {
  const name = document.getElementById('newProviderName').value.trim();
  const url = document.getElementById('newProviderUrl').value.trim();
  const key = document.getElementById('newProviderKey').value.trim();
  const api = document.getElementById('newProviderApi').value;
  if (!name || !url || !key) { showToast('请填写所有必填项', 'error'); return; }
  try {
    const updated = await window.api.addProvider(name, url, key, api);
    state.config = updated;
    hideModal('addProviderModal');
    renderSidebar();
    renderPrimaryBar();
    selectProvider(name);
    showToast(`Provider "${name}" 已添加`, 'success');
  } catch (err) { showToast(err.message, 'error'); }
}

// ── Delete Provider ──────────────────────────────────────────────
async function deleteProvider() {
  if (!confirm(`确定删除 Provider "${state.currentProvider}"？`)) return;
  try {
    const updated = await window.api.deleteProvider(state.currentProvider);
    state.config = updated;
    state.currentProvider = null;
    renderSidebar();
    renderPrimaryBar();
    renderMain();
    showToast('Provider 已删除', 'success');
  } catch (err) { showToast(err.message, 'error'); }
}

// ── Helpers ──────────────────────────────────────────────
function maskApiKey(key) {
  if (!key || key.length < 8) return '***';
  return key.substring(0, 8) + '...' + key.substring(key.length - 4);
}

function formatDate(iso) {
  return new Date(iso).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function formatTokens(n) {
  if (!n) return '';
  if (n >= 1000000) return (n / 1000000).toFixed(0) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(0) + 'K';
  return n.toString();
}

function showModal(id) { document.getElementById(id).classList.remove('hidden'); }
function hideModal(id) { document.getElementById(id).classList.add('hidden'); }

function showToast(message, type = 'success') {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.className = 'toast ' + type;
  setTimeout(() => toast.classList.add('show'), 10);
  setTimeout(() => toast.classList.remove('show'), 2500);
}

// ── Install Wizard ──────────────────────────────────────────────
let wizStep = 0;
let wizEnvOk = false;
let wizInstalling = false;

function showInstallWizard() {
  document.getElementById('installWizard').classList.remove('hidden');
  wizStep = 0;
  wizUpdateNav();
  wizUpdateActions();
}

function hideInstallWizard() {
  document.getElementById('installWizard').classList.add('hidden');
}

function wizardSkip() {
  hideInstallWizard();
}

function wizardPrev() {
  if (wizStep > 0) {
    wizStep--;
    wizShowPage(wizStep);
    wizUpdateNav();
    wizUpdateActions();
  }
}

async function wizardNext() {
  if (wizStep === 0) {
    wizStep = 1;
    wizShowPage(1);
    wizUpdateNav();
    wizUpdateActions();
    await wizCheckEnv();
  } else if (wizStep === 1) {
    wizStep = 2;
    wizShowPage(2);
    wizUpdateNav();
    wizUpdateActions();
    await wizStartInstall();
  } else if (wizStep === 3) {
    hideInstallWizard();
    // Re-check gateway status after install
    await checkGatewayStatus();
  }
}

function wizShowPage(n) {
  document.querySelectorAll('.wizard-page').forEach((p, i) => {
    p.classList.toggle('active', i === n);
  });
}

function wizUpdateNav() {
  for (let i = 0; i < 4; i++) {
    const el = document.getElementById(`wiz-nav-${i}`);
    el.classList.remove('active', 'done');
    if (i === wizStep) el.classList.add('active');
    else if (i < wizStep) el.classList.add('done');
  }
}

function wizUpdateActions() {
  const skipBtn = document.getElementById('wizSkipBtn');
  const prevBtn = document.getElementById('wizPrevBtn');
  const nextBtn = document.getElementById('wizNextBtn');

  skipBtn.style.display = 'none'; // 不允许跳过，必须完成初始化
  prevBtn.style.display = wizStep === 1 ? '' : 'none';

  if (wizStep === 0) {
    nextBtn.textContent = '开始检测 →';
    nextBtn.disabled = false;
  } else if (wizStep === 1) {
    nextBtn.textContent = wizEnvOk ? '开始安装 →' : '检测中...';
    nextBtn.disabled = !wizEnvOk;
  } else if (wizStep === 2) {
    nextBtn.style.display = 'none';
  } else if (wizStep === 3) {
    // 默认隐藏，等 onboard 完成后由 wizRunOnboard 控制显示
    nextBtn.style.display = 'none';
  }
}

async function wizCheckEnv() {
  const env = await window.api.checkEnv();

  const nodeBadge = document.getElementById('wiz-node-badge');
  const npmBadge = document.getElementById('wiz-npm-badge');
  const ocBadge = document.getElementById('wiz-oc-badge');
  const msg = document.getElementById('wizEnvMsg');

  // Node.js - 检查版本是否 >= 22.16.0
  if (env.node && !env.needNodeUpgrade) {
    nodeBadge.textContent = env.node;
    nodeBadge.className = 'wiz-env-badge ok';
  } else if (env.node && env.needNodeUpgrade) {
    nodeBadge.textContent = env.node + ' (需要 ≥22.16.0)';
    nodeBadge.className = 'wiz-env-badge missing';
  } else {
    nodeBadge.textContent = '未安装';
    nodeBadge.className = 'wiz-env-badge missing';
  }

  // npm
  if (env.npm) {
    npmBadge.textContent = 'v' + env.npm;
    npmBadge.className = 'wiz-env-badge ok';
  } else {
    npmBadge.textContent = '未安装';
    npmBadge.className = 'wiz-env-badge missing';
  }

  // OpenClaw
  if (env.openclaw) {
    ocBadge.textContent = env.openclaw;
    ocBadge.className = 'wiz-env-badge ok';
  } else {
    ocBadge.textContent = '未安装';
    ocBadge.className = 'wiz-env-badge missing';
  }

  // All OK → skip to done
  if (env.node && !env.needNodeUpgrade && env.npm && env.openclaw) {
    msg.textContent = '✓ 所有环境已就绪，无需安装。';
    msg.style.color = 'var(--green)';
    wizStep = 3;
    wizShowPage(3);
    wizUpdateNav();
    wizUpdateActions();
    if (env.configExists) {
      // 配置文件已存在，直接可以进入
      document.getElementById('wizDoneSub').textContent = 'OpenClaw 已安装且已初始化。';
      const onboardSection = document.getElementById('wizOnboardSection');
      if (onboardSection) onboardSection.style.display = 'none';
      const nextBtn = document.getElementById('wizNextBtn');
      nextBtn.style.display = '';
      nextBtn.textContent = '进入 OpenClaw Switch';
      nextBtn.disabled = false;
      nextBtn.onclick = wizardNext;
    } else {
      // 已安装但未初始化，必须先跑 onboard
      document.getElementById('wizDoneSub').textContent = 'OpenClaw 已安装，需要初始化配置。';
    }
    return;
  }

  // Something missing or needs upgrade
  const missing = [];
  if (!env.node || env.needNodeUpgrade) missing.push('Node.js ≥22.16.0');
  if (!env.openclaw) missing.push('OpenClaw');
  msg.textContent = '缺少: ' + missing.join('、') + '，点击"开始安装"继续。';
  msg.style.color = 'var(--yellow)';

  wizEnvOk = true;
  wizUpdateActions();
}

async function wizStartInstall() {
  if (wizInstalling) return;
  wizInstalling = true;

  const logEl = document.getElementById('wizInstallLog');
  const statusEl = document.getElementById('wizInstallStatus');
  const fillEl = document.getElementById('wizProgressFill');
  const subEl = document.getElementById('wizInstallSub');
  const nextBtn = document.getElementById('wizNextBtn');
  const skipBtn = document.getElementById('wizSkipBtn');

  logEl.textContent = '';
  statusEl.style.color = 'var(--text3)';
  fillEl.style.width = '0%';
  nextBtn.style.display = 'none';
  skipBtn.style.display = 'none';

  // Register output listener once
  window.api.onInstallOutput((text) => {
    logEl.textContent += text;
    logEl.scrollTop = logEl.scrollHeight;
    const cur = parseFloat(fillEl.style.width) || 0;
    if (cur < 80) fillEl.style.width = (cur + 2) + '%';
  });

  // Step 1: check if Node.js / npm is missing or version too low
  const env = await window.api.checkEnv();
  const needNode = !env.node || !env.npm || env.needNodeUpgrade;

  if (needNode) {
    const reason = env.needNodeUpgrade ? `升级 Node.js (当前 ${env.node}，需要 ≥22.16.0)` : '安装 Node.js v22.16.0';
    subEl.textContent = `步骤 1/3 — ${reason}`;
    statusEl.textContent = `正在下载 Node.js 安装包...`;
    fillEl.style.width = '5%';

    const nodeResult = await window.api.installNodejs();
    wizInstalling = false;

    if (!nodeResult.success) {
      fillEl.style.width = '0%';
      statusEl.textContent = `✗ 下载失败，请手动安装 Node.js v20+`;
      statusEl.style.color = 'var(--red)';
      nextBtn.style.display = '';
      nextBtn.textContent = '重试';
      nextBtn.disabled = false;
      nextBtn.onclick = async () => {
        nextBtn.onclick = null;
        nextBtn.style.display = 'none';
        wizInstalling = false;
        await wizStartInstall();
      };
      return;
    }

    // msi 安装界面已弹出，等用户装完后点"继续"
    fillEl.style.width = '30%';
    statusEl.textContent = '请在弹出的安装窗口中完成 Node.js 安装，完成后点击下方"安装完成，继续"';
    statusEl.style.color = 'var(--yellow)';

    // 显示"安装完成，继续"按钮，等用户点击后验证并继续装 openclaw
    nextBtn.style.display = '';
    nextBtn.textContent = '安装完成，继续 →';
    nextBtn.disabled = false;
    nextBtn.onclick = async () => {
      nextBtn.onclick = null;
      nextBtn.style.display = 'none';

      // 验证 Node.js 是否真的装好了
      statusEl.textContent = '正在验证 Node.js ...';
      statusEl.style.color = 'var(--text3)';
      const recheck = await window.api.checkEnv();
      if (!recheck.node || recheck.needNodeUpgrade) {
        statusEl.textContent = `✗ 未检测到 Node.js v20+${recheck.node ? ' (当前 ' + recheck.node + ')' : ''}，请确认安装完成后重试`;
        statusEl.style.color = 'var(--red)';
        nextBtn.style.display = '';
        nextBtn.textContent = '重新检测';
        nextBtn.disabled = false;
        nextBtn.onclick = async () => {
          nextBtn.onclick = null;
          nextBtn.style.display = 'none';
          wizInstalling = false;
          await wizStartInstall();
        };
        return;
      }

      sendInstallLogLine(logEl, `\n✓ 检测到 Node.js ${recheck.node}\n`);
      fillEl.style.width = '40%';
      statusEl.textContent = `✓ Node.js ${recheck.node} 已就绪`;
      statusEl.style.color = 'var(--green)';

      // 继续安装 openclaw
      await wizInstallOpenClaw(logEl, statusEl, fillEl, subEl, nextBtn, recheck);
    };
    return;
  }

  // Node.js 已就绪，直接装 openclaw
  fillEl.style.width = '40%';
  wizInstalling = false;
  await wizInstallOpenClaw(logEl, statusEl, fillEl, subEl, nextBtn, env);
}

async function wizInstallOpenClaw(logEl, statusEl, fillEl, subEl, nextBtn, env) {
  const needNode = !env.node || env.needNodeUpgrade;

  if (!env.openclaw) {
    subEl.textContent = needNode ? '步骤 2/3 — 安装 openclaw@latest' : '步骤 1/2 — 安装 openclaw@latest';
    statusEl.textContent = '正在安装 openclaw@latest (淘宝镜像) ...';
    statusEl.style.color = 'var(--text3)';
    wizInstalling = true;

    const ocResult = await window.api.installOpenClaw();
    wizInstalling = false;

    if (!ocResult.success) {
      fillEl.style.width = '40%';
      statusEl.textContent = '✗ openclaw 安装失败，请检查日志';
      statusEl.style.color = 'var(--red)';
      nextBtn.style.display = '';
      nextBtn.textContent = '重试';
      nextBtn.disabled = false;
      nextBtn.onclick = async () => {
        nextBtn.onclick = null;
        nextBtn.style.display = 'none';
        await wizInstallOpenClaw(logEl, statusEl, fillEl, subEl, nextBtn, env);
      };
      return;
    }

    fillEl.style.width = '90%';
    statusEl.textContent = '✓ openclaw@latest 安装完成';
    statusEl.style.color = 'var(--green)';
  } else {
    fillEl.style.width = '90%';
  }

  // 安装完成，跳到完成页，但必须先跑 onboard 才能进入主界面
  fillEl.style.width = '100%';
  setTimeout(() => {
    wizStep = 3;
    wizShowPage(3);
    wizUpdateNav();
    wizUpdateActions();
    // 新安装的情况，提示必须初始化
    document.getElementById('wizDoneSub').textContent = 'OpenClaw 安装完成，请初始化配置。';
    const tip = document.getElementById('wizDoneTip');
    if (tip) tip.textContent = '安装完成！在进入主界面前，需要先运行初始化命令，生成配置文件夹。';
  }, 600);
}

async function wizRunOnboard() {
  const btn = document.getElementById('wizOnboardBtn');
  const status = document.getElementById('wizOnboardStatus');
  const done = document.getElementById('wizOnboardDone');
  const nextBtn = document.getElementById('wizNextBtn');

  btn.disabled = true;
  btn.textContent = '初始化中...';
  status.textContent = '正在运行 openclaw onboard，请稍候...';
  status.style.color = 'var(--text3)';
  status.style.display = '';
  nextBtn.style.display = 'none';

  // 把输出打到完成页日志区
  const logEl = document.getElementById('wizOnboardLog');
  logEl.textContent = '';
  logEl.style.display = '';

  // 监听 install-output 通道
  window.api.onInstallOutput((text) => {
    logEl.textContent += text;
    logEl.scrollTop = logEl.scrollHeight;
  });

  try {
    const result = await window.api.runOnboard();
    if (result.success) {
      btn.style.display = 'none';
      status.style.display = 'none';
      done.style.display = '';
      // 初始化成功，才显示进入主界面按钮
      nextBtn.style.display = '';
      nextBtn.textContent = '进入 OpenClaw Switch';
      nextBtn.disabled = false;
      nextBtn.onclick = wizardNext;
    } else {
      status.textContent = '✗ 初始化未完成，请重试';
      status.style.color = 'var(--red)';
      btn.disabled = false;
      btn.textContent = '重新运行 openclaw onboard';
    }
  } catch (err) {
    status.textContent = '✗ ' + err.message;
    status.style.color = 'var(--red)';
    btn.disabled = false;
    btn.textContent = '重新运行 openclaw onboard';
  }
}

function sendInstallLogLine(logEl, text) {
  logEl.textContent += text;
  logEl.scrollTop = logEl.scrollHeight;
}

// ── Terminal ──────────────────────────────────────────────

function clearTerminal() {
  document.getElementById('terminalOutput').textContent = '';
}

async function sendTerminalCommand() {
  const input = document.getElementById('terminalInput');
  const command = input.value;
  if (!command.trim()) return;

  try {
    await window.api.terminalInput(command);
    input.value = '';
    updateTerminalSendBtn();
  } catch (err) {
    showToast('发送失败: ' + err.message, 'error');
  }
}

function updateTerminalSendBtn() {
  const input = document.getElementById('terminalInput');
  const btn = document.getElementById('terminalSendBtn');
  const hasContent = input.value.trim().length > 0;
  btn.disabled = !hasContent;
}

function initTerminalUI() {
  // Start terminal on load
  window.api.initTerminal();

  // Listen for terminal output
  window.api.onTerminalOutput((text) => {
    const output = document.getElementById('terminalOutput');
    output.textContent += text;
    output.scrollTop = output.scrollHeight;
  });

  // Listen for cwd changes
  window.api.onTerminalCwd((cwd) => {
    document.getElementById('terminalPath').textContent = cwd;
  });

  // Handle input
  const input = document.getElementById('terminalInput');
  input.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      await sendTerminalCommand();
    }
  });

  // Update button state on input change
  input.addEventListener('input', updateTerminalSendBtn);

  // Initialize button state
  updateTerminalSendBtn();

  // Handle copy from terminal output
  const output = document.getElementById('terminalOutput');
  output.addEventListener('contextmenu', (e) => {
    const selectedText = window.getSelection().toString();
    if (selectedText) {
      e.preventDefault();
      // 使用 Clipboard API 复制选中文本
      navigator.clipboard.writeText(selectedText).then(() => {
        showToast('内容已复制', 'success');
      }).catch(err => {
        console.error('复制失败:', err);
      });
    }
  });

  // 也监听 Ctrl+C
  output.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
      const selectedText = window.getSelection().toString();
      if (selectedText) {
        // 让默认行为处理复制，之后显示提示
        setTimeout(() => {
          showToast('内容已复制', 'success');
        }, 100);
      }
    }
  });
}

// ── Start ──────────────────────────────────────────────
init();
initTerminalUI();

// ── Agents ──────────────────────────────────────────────

const AGENT_TEMPLATES = {
  architect: { id: 'architect', name: '架构师', description: '负责系统架构设计、技术方案规划和技术决策。专长于分析需求、设计可扩展的系统架构、评估技术选型和解决技术瓶颈。' },
  ui: { id: 'ui', name: 'UI设计师', description: '负责用户界面设计和用户体验优化。专长于设计美观易用的界面、进行用户研究、优化交互流程和品牌一致性。' },
  pm: { id: 'pm', name: '项目经理', description: '负责项目进度管理、团队协调和风险管理。专长于制定项目计划、跟进任务执行、协调各方合作和解决项目问题。' },
  product: { id: 'product', name: '产品经理', description: '负责产品需求定义、优先级管理和产品战略。专长于市场分析、用户需求调研、产品规划和功能设计。' },
  dev: { id: 'dev', name: '开发人员', description: '负责代码开发和功能实现。专长于编写高质量代码、进行技术调研、解决技术问题和代码优化。' },
  qa: { id: 'qa', name: '测试人员', description: '负责质量保证和测试工作。专长于设计测试用例、执行测试、发现和报告缺陷、确保产品质量。' },
};

let agentsData = [];

async function loadAgents() {
  try {
    agentsData = await window.api.getAgents();
    state.agents = agentsData;
  } catch (err) {
    console.error('Failed to load agents:', err);
    agentsData = [];
  }
}

async function renderAgents() {
  await loadAgents();
  const list = document.getElementById('agentsList');

  if (!agentsData || agentsData.length === 0) {
    list.innerHTML = `
      <div class="agent-empty">
        <div class="agent-empty-icon">🦞</div>
        <div>暂无分身，点击"创建分身"添加你的AI团队成员</div>
      </div>
    `;
    return;
  }

  list.innerHTML = agentsData.map(agent => `
    <div class="agent-card">
      <div class="agent-card-header">
        <div>
          <div class="agent-card-name">${agent.name || agent.id}</div>
          <div class="agent-card-desc">${agent.description || '暂无描述'}</div>
        </div>
      </div>
      <div class="agent-card-info">
        <div class="agent-card-info-item">📌 ID: ${agent.id}</div>
        ${agent.model ? `<div class="agent-card-info-item">🎯 模型: ${agent.model}</div>` : ''}
        ${agent.workspace ? `<div class="agent-card-info-item">📁 工作区: ${agent.workspace}</div>` : ''}
        ${agent.skills && agent.skills.length > 0 ? `<div class="agent-card-info-item">🔧 技能: ${agent.skills.length} 个</div>` : ''}
      </div>
      <div class="agent-card-actions">
        <button class="btn btn-ghost btn-sm" onclick="editAgent('${agent.id}')">编辑</button>
        <button class="btn btn-ghost btn-sm" onclick="manageSkills('${agent.id}')">技能</button>
        <button class="btn btn-danger btn-sm" onclick="deleteAgentConfirm('${agent.id}')">删除</button>
      </div>
    </div>
  `).join('');
}

function applyTemplate(templateId) {
  const template = AGENT_TEMPLATES[templateId];
  if (!template) return;

  document.getElementById('newAgentId').value = template.id;
  document.getElementById('newAgentName').value = template.name;
  document.getElementById('newAgentDesc').value = template.description;
}

function showAddAgentModal() {
  document.getElementById('agentModalTitle').textContent = '创建分身';
  document.getElementById('newAgentId').value = '';
  document.getElementById('newAgentId').disabled = false;
  document.getElementById('newAgentName').value = '';
  document.getElementById('newAgentDesc').value = '';
  document.getElementById('submitAgentBtn').textContent = '创建';
  document.getElementById('submitAgentBtn').onclick = submitAddAgent;

  // 填充模型列表
  const { providers } = state.config;
  const modelSelect = document.getElementById('newAgentModel');
  modelSelect.innerHTML = '<option value="">-- 选择模型 --</option>';

  let firstModel = '';
  Object.entries(providers).forEach(([provName, p]) => {
    p.models.forEach(m => {
      const option = document.createElement('option');
      option.value = `${provName}/${m.id}`;
      option.textContent = `${m.name} (${provName})`;
      modelSelect.appendChild(option);
      if (!firstModel) firstModel = `${provName}/${m.id}`;
    });
  });

  // 默认选中第一个模型
  if (firstModel) {
    modelSelect.value = firstModel;
  }

  showModal('addAgentModal');
}

function editAgent(agentId) {
  const agent = agentsData.find(a => a.id === agentId);
  if (!agent) {
    showToast('Agent 不存在', 'error');
    return;
  }

  // 填充编辑表单
  document.getElementById('agentModalTitle').textContent = '编辑分身';
  document.getElementById('newAgentId').value = agent.id;
  document.getElementById('newAgentId').disabled = true; // ID 不可修改
  document.getElementById('newAgentName').value = agent.name || '';
  document.getElementById('newAgentDesc').value = agent.description || '';
  document.getElementById('submitAgentBtn').textContent = '保存';
  document.getElementById('submitAgentBtn').onclick = () => submitEditAgent(agentId);

  // 填充模型列表并回显当前选中的模型
  const { providers } = state.config;
  const modelSelect = document.getElementById('newAgentModel');
  modelSelect.innerHTML = '<option value="">-- 选择模型 --</option>';
  Object.entries(providers).forEach(([provName, p]) => {
    p.models.forEach(m => {
      const option = document.createElement('option');
      option.value = `${provName}/${m.id}`;
      option.textContent = `${m.name} (${provName})`;
      modelSelect.appendChild(option);
    });
  });

  // 回显当前模型
  if (agent.model) {
    modelSelect.value = agent.model;
  }

  showModal('addAgentModal');
}

async function submitEditAgent(agentId) {
  const name = document.getElementById('newAgentName').value.trim();
  const desc = document.getElementById('newAgentDesc').value.trim();
  const model = document.getElementById('newAgentModel').value;

  if (!name) {
    showToast('请输入分身名称', 'error');
    return;
  }

  const workspace = `~/.openclaw/workspace-${agentId}`;
  const agent = { name, description: desc, workspace };
  if (model) agent.model = model;

  try {
    await window.api.updateAgent(agentId, agent);
    hideModal('addAgentModal');
    await loadAgents();
    renderAgents();
    showToast(`分身 "${name}" 已更新`, 'success');
  } catch (err) {
    showToast('更新失败: ' + err.message, 'error');
  }
}

async function deleteAgentConfirm(agentId) {
  if (!confirm(`确定删除分身 "${agentId}"？`)) return;
  try {
    await window.api.deleteAgent(agentId);
    renderAgents();
    showToast('分身已删除', 'success');
  } catch (err) {
    showToast('删除失败: ' + err.message, 'error');
  }
}

async function submitAddAgent() {
  const id = document.getElementById('newAgentId').value.trim();
  const name = document.getElementById('newAgentName').value.trim();
  const desc = document.getElementById('newAgentDesc').value.trim();
  const model = document.getElementById('newAgentModel').value;

  if (!id) {
    showToast('请输入分身ID', 'error');
    return;
  }
  if (!name) {
    showToast('请输入分身名称', 'error');
    return;
  }

  // 自动生成工作区路径
  const workspace = `~/.openclaw/workspace-${id}`;

  const agent = { id, name, description: desc, workspace, skills: [] };
  if (model) agent.model = model;

  try {
    await window.api.addAgent(agent);
    hideModal('addAgentModal');
    renderAgents();
    showToast(`分身 "${name}" 已创建`, 'success');
  } catch (err) {
    showToast('创建失败: ' + err.message, 'error');
  }
}

// ── Skills Management ──────────────────────────────────────────────

let currentSkillAgentId = null;

function manageSkills(agentId) {
  currentSkillAgentId = agentId;
  const agent = agentsData.find(a => a.id === agentId);
  if (!agent) {
    showToast('Agent 不存在', 'error');
    return;
  }

  document.getElementById('skillsModalTitle').textContent = `管理技能 - ${agent.name}`;
  renderSkillsList(agent.skills || []);
  showModal('manageSkillsModal');
}

function renderSkillsList(skills) {
  const list = document.getElementById('skillsList');

  if (!skills || skills.length === 0) {
    list.innerHTML = '<div style="text-align: center; padding: 24px; color: var(--text3);">暂无技能</div>';
    return;
  }

  list.innerHTML = skills.map((skill, index) => `
    <div class="skill-item">
      <div style="flex: 1;">
        <div class="skill-item-name">${skill.name}</div>
        <div class="skill-item-size">${formatFileSize(skill.size || 0)}</div>
      </div>
      <div class="skill-item-actions">
        <button class="btn btn-ghost btn-sm" onclick="downloadSkill('${currentSkillAgentId}', ${index})">下载</button>
        <button class="btn btn-danger btn-sm" onclick="deleteSkill('${currentSkillAgentId}', ${index})">删除</button>
      </div>
    </div>
  `).join('');
}

function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

async function handleSkillUpload(event) {
  const file = event.target.files[0];
  if (!file) return;

  const agent = agentsData.find(a => a.id === currentSkillAgentId);
  if (!agent) return;

  try {
    const reader = new FileReader();
    reader.onload = async (e) => {
      const content = e.target.result;
      const skill = {
        name: file.name,
        size: file.size,
        content: content,
        uploadedAt: new Date().toISOString()
      };

      if (!agent.skills) agent.skills = [];
      agent.skills.push(skill);

      await window.api.updateAgent(currentSkillAgentId, { skills: agent.skills });
      await loadAgents();
      renderSkillsList(agent.skills);
      renderAgents();
      showToast(`技能 "${file.name}" 已上传`, 'success');
    };
    reader.readAsText(file);
  } catch (err) {
    showToast('上传失败: ' + err.message, 'error');
  }

  // 清空 input
  event.target.value = '';
}

async function deleteSkill(agentId, skillIndex) {
  if (!confirm('确定删除此技能？')) return;

  const agent = agentsData.find(a => a.id === agentId);
  if (!agent || !agent.skills) return;

  try {
    agent.skills.splice(skillIndex, 1);
    await window.api.updateAgent(agentId, { skills: agent.skills });
    await loadAgents();
    renderSkillsList(agent.skills);
    renderAgents();
    showToast('技能已删除', 'success');
  } catch (err) {
    showToast('删除失败: ' + err.message, 'error');
  }
}

function downloadSkill(agentId, skillIndex) {
  const agent = agentsData.find(a => a.id === agentId);
  if (!agent || !agent.skills || !agent.skills[skillIndex]) return;

  const skill = agent.skills[skillIndex];
  const blob = new Blob([skill.content], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = skill.name;
  a.click();
  URL.revokeObjectURL(url);
  showToast('技能已下载', 'success');
}
