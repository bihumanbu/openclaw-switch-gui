const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { execSync, spawn } = require('child_process');
const net = require('net');

// openclaw.json 是真正的配置文件，providers 在 models.providers 下，primary 在 agents.defaults.model.primary 下
const CONFIG_PATH = path.join(process.env.USERPROFILE || process.env.HOME, '.openclaw/openclaw.json');
const PROFILES_PATH = path.join(process.env.USERPROFILE || process.env.HOME, '.openclaw-switch/profiles.json');

let mainWindow;
let tray;

function ensureProfilesDir() {
  const dir = path.dirname(PROFILES_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// openclaw.json 可能包含 // 注释，需要先去掉再 parse
function stripJsonComments(text) {
  return text.replace(/^\s*\/\/.*$/gm, '');
}

function readRawConfig() {
  if (!fs.existsSync(CONFIG_PATH)) return {};
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  return JSON.parse(stripJsonComments(raw));
}

function writeRawConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
}

// 提取给前端的数据：providers + primary
function readConfig() {
  const raw = readRawConfig();
  const providers = (raw.models && raw.models.providers) || {};
  const primary = (raw.agents && raw.agents.defaults && raw.agents.defaults.model && raw.agents.defaults.model.primary) || '';
  return { providers, primary };
}

// 写入 providers 到 openclaw.json
function writeProviders(providers) {
  const raw = readRawConfig();
  if (!raw.models) raw.models = {};
  raw.models.providers = providers;
  writeRawConfig(raw);
}

// 写入 primary 模型到 openclaw.json
function writePrimary(primary) {
  const raw = readRawConfig();
  if (!raw.agents) raw.agents = {};
  if (!raw.agents.defaults) raw.agents.defaults = {};
  if (!raw.agents.defaults.model) raw.agents.defaults.model = {};
  raw.agents.defaults.model.primary = primary;
  writeRawConfig(raw);
}

// 读取 agents 列表
function readAgents() {
  const raw = readRawConfig();
  return (raw.agents && raw.agents.list) || [];
}

// 写入 agents 列表
function writeAgents(agents) {
  const raw = readRawConfig();
  if (!raw.agents) raw.agents = {};
  raw.agents.list = agents;
  writeRawConfig(raw);
}

// 添加 agent
function addAgent(agent) {
  const agents = readAgents();
  if (agents.some(a => a.id === agent.id)) {
    throw new Error(`Agent "${agent.id}" 已存在`);
  }
  agents.push(agent);
  writeAgents(agents);
  return agents;
}

// 更新 agent
function updateAgent(agentId, updatedAgent) {
  const agents = readAgents();
  const index = agents.findIndex(a => a.id === agentId);
  if (index === -1) throw new Error('Agent 不存在');
  agents[index] = { ...agents[index], ...updatedAgent };
  writeAgents(agents);
  return agents;
}

// 删除 agent
function deleteAgent(agentId) {
  const agents = readAgents().filter(a => a.id !== agentId);
  writeAgents(agents);
  return agents;
}

function readProfiles() {
  ensureProfilesDir();
  if (!fs.existsSync(PROFILES_PATH)) return {};
  return JSON.parse(fs.readFileSync(PROFILES_PATH, 'utf8'));
}

function writeProfiles(profiles) {
  ensureProfilesDir();
  fs.writeFileSync(PROFILES_PATH, JSON.stringify(profiles, null, 2), 'utf8');
}

function createWindow() {
  const iconPath = path.join(__dirname, 'icon.ico');
  const icon = nativeImage.createFromPath(iconPath);

  mainWindow = new BrowserWindow({
    width: 900,
    height: 660,
    minWidth: 800,
    minHeight: 560,
    frame: false,
    transparent: false,
    backgroundColor: '#0f1117',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    icon: icon,
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  mainWindow.on('close', (e) => {
    e.preventDefault();
    mainWindow.hide();
  });
}

function killGatewayAndExit() {
  const port = getGatewayPort();
  // 先杀掉我们自己启动的进程
  if (gatewayProcess && !gatewayProcess.killed) {
    try {
      execSync(`taskkill /PID ${gatewayProcess.pid} /F /T`, { stdio: 'pipe', timeout: 5000 });
    } catch { /* ignore */ }
    gatewayProcess = null;
  }
  // 再通过端口兜底杀掉外部启动的 gateway
  try {
    const output = execSync(`netstat -ano | findstr :${port} | findstr LISTENING`, { stdio: 'pipe', timeout: 3000 }).toString();
    const match = output.match(/LISTENING\s+(\d+)/);
    if (match) {
      execSync(`taskkill /PID ${match[1]} /F /T`, { stdio: 'pipe', timeout: 5000 });
    }
  } catch { /* ignore */ }
  app.exit(0);
}

function createTray() {
  const iconPath = path.join(__dirname, 'icon.ico');
  const icon = nativeImage.createFromPath(iconPath);
  tray = new Tray(icon);
  tray.setToolTip('OpenClaw Nexus');
  tray.on('click', () => {
    mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show();
  });
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示', click: () => mainWindow.show() },
    { type: 'separator' },
    { label: '退出', click: () => { killGatewayAndExit(); } },
  ]));
}

app.whenReady().then(() => {
  createWindow();
  createTray();
});

app.on('window-all-closed', () => {});

// ── IPC handlers ──────────────────────────────────────────────

ipcMain.handle('get-data', () => {
  return { config: readConfig(), profiles: readProfiles() };
});

// 切换 primary 模型（核心功能）
ipcMain.handle('set-primary', (_, { primary }) => {
  writePrimary(primary);
  return readConfig();
});

ipcMain.handle('save-profile', (_, { provider, profileName }) => {
  const { providers } = readConfig();
  if (!providers[provider]) throw new Error('Provider 不存在');
  const profiles = readProfiles();
  if (!profiles[provider]) profiles[provider] = {};
  profiles[provider][profileName] = {
    ...providers[provider],
    savedAt: new Date().toISOString(),
  };
  writeProfiles(profiles);
  return readProfiles();
});

ipcMain.handle('switch-profile', (_, { provider, profileName }) => {
  const profiles = readProfiles();
  if (!profiles[provider]?.[profileName]) throw new Error('Profile 不存在');
  const { providers } = readConfig();
  const p = profiles[provider][profileName];
  providers[provider] = { baseUrl: p.baseUrl, apiKey: p.apiKey, api: p.api, models: p.models };
  writeProviders(providers);
  return readConfig();
});

ipcMain.handle('update-apikey', (_, { provider, apiKey }) => {
  const { providers } = readConfig();
  if (!providers[provider]) throw new Error('Provider 不存在');
  providers[provider].apiKey = apiKey;
  writeProviders(providers);
  return readConfig();
});

ipcMain.handle('add-provider', (_, { name, baseUrl, apiKey, api }) => {
  const { providers } = readConfig();
  if (providers[name]) throw new Error('Provider 已存在');
  providers[name] = { baseUrl, apiKey, api: api || 'openai-completions', models: [] };
  writeProviders(providers);
  return readConfig();
});

ipcMain.handle('delete-provider', (_, { provider }) => {
  const { providers } = readConfig();
  delete providers[provider];
  writeProviders(providers);
  return readConfig();
});

ipcMain.handle('delete-profile', (_, { provider, profileName }) => {
  const profiles = readProfiles();
  if (profiles[provider]) {
    delete profiles[provider][profileName];
    if (Object.keys(profiles[provider]).length === 0) delete profiles[provider];
  }
  writeProfiles(profiles);
  return readProfiles();
});

ipcMain.handle('add-model', (_, { provider, model }) => {
  const { providers } = readConfig();
  if (!providers[provider]) throw new Error('Provider 不存在');
  if (providers[provider].models.some(m => m.id === model.id)) {
    throw new Error(`模型 "${model.id}" 已存在`);
  }
  providers[provider].models.push(model);
  writeProviders(providers);
  return readConfig();
});

ipcMain.handle('delete-model', (_, { provider, modelId }) => {
  const { providers } = readConfig();
  if (!providers[provider]) throw new Error('Provider 不存在');
  providers[provider].models = providers[provider].models.filter(m => m.id !== modelId);
  writeProviders(providers);
  return readConfig();
});

// ── Agents ──────────────────────────────────────────────

ipcMain.handle('get-agents', () => {
  return readAgents();
});

ipcMain.handle('add-agent', (_, { agent }) => {
  return addAgent(agent);
});

ipcMain.handle('update-agent', (_, { agentId, agent }) => {
  return updateAgent(agentId, agent);
});

ipcMain.handle('delete-agent', (_, { agentId }) => {
  return deleteAgent(agentId);
});

// ── Gateway ──────────────────────────────────────────────────

const GATEWAY_CMD_PATH = path.join(process.env.USERPROFILE || process.env.HOME, '.openclaw/gateway.cmd');
let gatewayProcess = null;

function getGatewayPort() {
  try {
    if (!fs.existsSync(GATEWAY_CMD_PATH)) return 18789;
    const content = fs.readFileSync(GATEWAY_CMD_PATH, 'utf8');
    const match = content.match(/--port\s+(\d+)/);
    return match ? parseInt(match[1]) : 18789;
  } catch { return 18789; }
}

function getGatewayToken() {
  try {
    if (!fs.existsSync(GATEWAY_CMD_PATH)) return null;
    const content = fs.readFileSync(GATEWAY_CMD_PATH, 'utf8');
    const match = content.match(/OPENCLAW_GATEWAY_TOKEN=([^"\s]+)/);
    return match ? match[1] : null;
  } catch { return null; }
}

function isOpenClawInstalled() {
  try {
    execSync('where openclaw', { stdio: 'pipe', timeout: 3000 });
    return true;
  } catch { return false; }
}

function checkPort(port) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(2000);
    socket.on('connect', () => { socket.destroy(); resolve(true); });
    socket.on('timeout', () => { socket.destroy(); resolve(false); });
    socket.on('error', () => { resolve(false); });
    socket.connect(port, '127.0.0.1');
  });
}

function sendGatewayOutput(text) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('gateway-output', text);
  }
}

ipcMain.handle('check-gateway', async () => {
  const installed = isOpenClawInstalled();
  const port = getGatewayPort();
  const running = installed ? await checkPort(port) : false;
  return { installed, running, port };
});

ipcMain.handle('start-gateway', async () => {
  const port = getGatewayPort();
  if (await checkPort(port)) return { success: true, message: 'Gateway 已在运行中' };

  try {
    const args = fs.existsSync(GATEWAY_CMD_PATH)
      ? ['/c', GATEWAY_CMD_PATH]
      : ['/c', 'openclaw', 'gateway', '--port', String(port)];

    gatewayProcess = spawn('cmd.exe', args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, FORCE_COLOR: '1', NODE_DISABLE_COLORS: '' },
    });

    gatewayProcess.stdout.on('data', (data) => sendGatewayOutput(data.toString()));
    gatewayProcess.stderr.on('data', (data) => sendGatewayOutput(data.toString()));

    gatewayProcess.on('close', (code) => {
      sendGatewayOutput(`\n[进程已退出, code=${code}]\n`);
      gatewayProcess = null;
    });

    gatewayProcess.on('error', (err) => {
      sendGatewayOutput(`\n[启动错误] ${err.message}\n`);
      gatewayProcess = null;
    });

    // 等待启动
    await new Promise(r => setTimeout(r, 3000));
    const started = await checkPort(port);
    return { success: started, message: started ? 'Gateway 启动成功' : 'Gateway 正在启动，请稍候...' };
  } catch (err) {
    return { success: false, message: '启动失败: ' + err.message };
  }
});

ipcMain.handle('stop-gateway', async () => {
  const port = getGatewayPort();
  if (!(await checkPort(port))) {
    gatewayProcess = null;
    return { success: true, message: 'Gateway 未在运行' };
  }

  // 优先使用进程引用
  if (gatewayProcess && !gatewayProcess.killed) {
    try {
      // Windows 下需要 taskkill /T 杀掉子进程树
      execSync(`taskkill /PID ${gatewayProcess.pid} /F /T`, { stdio: 'pipe', timeout: 5000 });
    } catch { /* ignore */ }
    gatewayProcess = null;
    await new Promise(r => setTimeout(r, 1000));
    const stillRunning = await checkPort(port);
    return { success: !stillRunning, message: stillRunning ? '停止失败，请重试' : 'Gateway 已停止' };
  }

  // Fallback: 通过端口查找进程 (兼容外部启动的 gateway)
  try {
    const output = execSync(`netstat -ano | findstr :${port} | findstr LISTENING`, { stdio: 'pipe', timeout: 5000 }).toString();
    const match = output.match(/LISTENING\s+(\d+)/);
    if (match) {
      execSync(`taskkill /PID ${match[1]} /F /T`, { stdio: 'pipe', timeout: 5000 });
      await new Promise(r => setTimeout(r, 1000));
      const stillRunning = await checkPort(port);
      return { success: !stillRunning, message: stillRunning ? '停止失败，请重试' : 'Gateway 已停止' };
    }
    return { success: false, message: '未找到 Gateway 进程' };
  } catch (err) {
    return { success: false, message: '停止失败: ' + err.message };
  }
});

ipcMain.handle('open-dashboard', async () => {
  const port = getGatewayPort();
  if (!(await checkPort(port))) {
    return { success: false, message: 'Gateway 未运行' };
  }
  return new Promise((resolve) => {
    let output = '';
    const proc = spawn('cmd.exe', ['/c', 'openclaw', 'dashboard', '--no-open'], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    proc.stdout.on('data', (d) => { output += d.toString(); });
    proc.stderr.on('data', (d) => { output += d.toString(); });
    proc.on('close', () => {
      const match = output.match(/Dashboard URL:\s*(https?:\/\/\S+)/);
      if (match) {
        shell.openExternal(match[1]);
        resolve({ success: true, url: match[1] });
      } else {
        resolve({ success: false, message: '未获取到 Dashboard URL' });
      }
    });
    proc.on('error', (err) => {
      resolve({ success: false, message: err.message });
    });
  });
});

// ── Install OpenClaw ──────────────────────────────────────────

function sendInstallOutput(text) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('install-output', text);
  }
}

// 真正的环境检测：逐个检查 node / npm / openclaw
ipcMain.handle('check-env', async () => {
  const result = { node: null, nodeVersion: 0, nodeMajor: 0, nodeMinor: 0, npm: null, openclaw: null, needNodeUpgrade: false, configExists: false };
  try {
    const nodeVer = execSync('node -v', { stdio: 'pipe', timeout: 5000 }).toString().trim();
    result.node = nodeVer;
    const match = nodeVer.match(/^v(\d+)\.(\d+)\./);
    if (match) {
      result.nodeMajor = parseInt(match[1]);
      result.nodeMinor = parseInt(match[2]);
      result.needNodeUpgrade = result.nodeMajor < 22 || (result.nodeMajor === 22 && result.nodeMinor < 16);
    }
  } catch { result.node = null; }
  try {
    result.npm = execSync('npm -v', { stdio: 'pipe', timeout: 5000 }).toString().trim();
  } catch { result.npm = null; }
  try {
    result.openclaw = execSync('openclaw --version', { stdio: 'pipe', timeout: 5000 }).toString().trim();
  } catch { result.openclaw = null; }
  result.configExists = fs.existsSync(CONFIG_PATH);
  return result;
});

// 安装 Node.js (下载 msi 并静默安装，使用淘宝镜像)
ipcMain.handle('install-nodejs', async () => {
  return new Promise(async (resolve) => {
    const arch = process.arch === 'x64' ? 'x64' : 'x86';
    const version = 'v22.16.0'; // Node.js 22 LTS (openclaw requires >=22.16.0)
    const msiUrl = `https://npmmirror.com/mirrors/node/${version}/node-${version}-${arch}.msi`;
    const tempDir = path.join(require('os').tmpdir(), 'openclaw-installer');
    const msiPath = path.join(tempDir, `node-${version}-${arch}.msi`);

    sendInstallOutput(`> 下载 Node.js ${version} (${arch}) - 淘宝镜像\n`);
    sendInstallOutput(`  URL: ${msiUrl}\n\n`);

    // 确保临时目录存在
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

    // 下载 msi
    try {
      const https = require('https');
      const file = fs.createWriteStream(msiPath);

      await new Promise((resolveDownload, rejectDownload) => {
        const request = https.get(msiUrl, (response) => {
          // 处理 302 跳转
          if (response.statusCode === 302 || response.statusCode === 301) {
            const redirectUrl = response.headers.location;
            sendInstallOutput(`  跳转到: ${redirectUrl}\n`);
            https.get(redirectUrl, (redirectResponse) => {
              if (redirectResponse.statusCode !== 200) {
                rejectDownload(new Error(`下载失败: HTTP ${redirectResponse.statusCode}`));
                return;
              }
              const totalBytes = parseInt(redirectResponse.headers['content-length'], 10);
              let downloadedBytes = 0;
              let lastPercent = 0;

              redirectResponse.on('data', (chunk) => {
                downloadedBytes += chunk.length;
                const percent = Math.floor((downloadedBytes / totalBytes) * 100);
                if (percent > lastPercent && percent % 10 === 0) {
                  sendInstallOutput(`  下载进度: ${percent}% (${Math.floor(downloadedBytes / 1024 / 1024)}MB / ${Math.floor(totalBytes / 1024 / 1024)}MB)\n`);
                  lastPercent = percent;
                }
              });

              redirectResponse.pipe(file);
              file.on('finish', () => {
                file.close();
                sendInstallOutput('  下载完成\n\n');
                resolveDownload();
              });
            }).on('error', (err) => {
              fs.unlink(msiPath, () => {});
              rejectDownload(err);
            });
            return;
          }

          if (response.statusCode !== 200) {
            rejectDownload(new Error(`下载失败: HTTP ${response.statusCode}`));
            return;
          }

          const totalBytes = parseInt(response.headers['content-length'], 10);
          let downloadedBytes = 0;
          let lastPercent = 0;

          response.on('data', (chunk) => {
            downloadedBytes += chunk.length;
            const percent = Math.floor((downloadedBytes / totalBytes) * 100);
            if (percent > lastPercent && percent % 10 === 0) {
              sendInstallOutput(`  下载进度: ${percent}%\n`);
              lastPercent = percent;
            }
          });

          response.pipe(file);
          file.on('finish', () => {
            file.close();
            sendInstallOutput('  下载完成\n\n');
            resolveDownload();
          });
        }).on('error', (err) => {
          fs.unlink(msiPath, () => {});
          rejectDownload(err);
        });
      });
    } catch (err) {
      sendInstallOutput(`\n✗ 下载失败: ${err.message}\n`);
      sendInstallOutput('提示: 请检查网络连接或手动从 https://nodejs.org 下载安装\n');
      resolve({ success: false, message: err.message });
      return;
    }

    // 用 shell.openPath 打开 msi 所在文件夹，让用户自己双击安装
    // 避免在 Electron 进程内启动 msiexec 导致 Node.js 被替换后应用崩溃
    sendInstallOutput('> 已下载到: ' + msiPath + '\n');
    sendInstallOutput('  正在打开文件所在目录，请双击 msi 文件完成安装\n');
    sendInstallOutput('  安装完成后回到此处点击"安装完成，继续"\n\n');
    shell.showItemInFolder(msiPath);

    resolve({ success: true, needManualInstall: true });
  });
});

// npm 国内镜像
const NPM_REGISTRY = 'https://registry.npmmirror.com';

// 安装 openclaw
ipcMain.handle('install-openclaw', async () => {
  return new Promise((resolve) => {
    sendInstallOutput(`\n> npm install -g openclaw@latest --registry=${NPM_REGISTRY}\n\n`);
    const proc = spawn('cmd.exe', ['/c', 'npm', 'install', '-g', 'openclaw@latest',
      '--registry=' + NPM_REGISTRY], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    proc.stdout.on('data', (data) => sendInstallOutput(data.toString()));
    proc.stderr.on('data', (data) => sendInstallOutput(data.toString()));

    proc.on('close', (code) => {
      if (code === 0) {
        sendInstallOutput('\n✓ openclaw@latest 安装完成\n');
        resolve({ success: true });
      } else {
        sendInstallOutput(`\n✗ 安装失败，退出码: ${code}\n`);
        resolve({ success: false, code });
      }
    });

    proc.on('error', (err) => {
      sendInstallOutput(`\n✗ ${err.message}\n`);
      resolve({ success: false, message: err.message });
    });
  });
});

ipcMain.handle('run-onboard', async () => {
  return new Promise((resolve) => {
    sendInstallOutput('\n> openclaw onboard --non-interactive --skip-daemon --auth-choice skip\n\n');
    const proc = spawn('cmd.exe', ['/c', 'openclaw', 'onboard',
      '--non-interactive',
      '--skip-daemon',
      '--auth-choice', 'skip',
      '--accept-risk'
    ], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, FORCE_COLOR: '0' },
    });

    proc.stdout.on('data', (data) => sendInstallOutput(data.toString()));
    proc.stderr.on('data', (data) => sendInstallOutput(data.toString()));

    proc.on('close', (code) => {
      // 等一下再检测，确保文件写入完成
      setTimeout(() => {
        const configExists = fs.existsSync(CONFIG_PATH);
        if (configExists) {
          sendInstallOutput('\n✓ 初始化完成，配置文件已生成: ' + CONFIG_PATH + '\n');
          resolve({ success: true });
        } else {
          sendInstallOutput(`\n✗ 初始化未完成，未检测到配置文件 (退出码: ${code})\n`);
          sendInstallOutput('  预期路径: ' + CONFIG_PATH + '\n');
          resolve({ success: false, code });
        }
      }, 500);
    });

    proc.on('error', (err) => {
      sendInstallOutput(`\n✗ ${err.message}\n`);
      resolve({ success: false, message: err.message });
    });
  });
});

// ── Terminal ──────────────────────────────────────────────────

let terminalProcess = null;
let terminalInitialized = false;
let terminalOutputBuffer = '';
let terminalCwd = process.cwd();

function initTerminal() {
  if (terminalProcess && !terminalProcess.killed) return;

  terminalInitialized = false;
  terminalOutputBuffer = '';
  terminalCwd = process.cwd();

  try {
    const cwd = terminalCwd;

    // 使用 /Q 隐藏版本信息，/D 禁用自动运行
    terminalProcess = spawn('cmd.exe', ['/Q', '/D'], {
      cwd,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });

    // 初始化完成后立即发送当前目录给前端
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('terminal-cwd', terminalCwd);
      }
    }, 100);

    terminalProcess.stdout.on('data', (data) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        // 尝试用 cp936 (Windows GBK) 解码，如果失败就用 utf8
        let text = '';
        try {
          // 先尝试用 binary 读取，然后手动处理
          text = data.toString('utf8');
        } catch {
          text = data.toString('binary');
        }

        terminalOutputBuffer += text;

        // 初始化标志：检测到第一个提示符 (通常是路径>) 或 ENTER 键后的响应
        if (!terminalInitialized) {
          // 如果缓冲区包含 ">" 或换行符+路径，说明初始化完成
          if (terminalOutputBuffer.match(/\w:[^]*>\s*$/m) || terminalOutputBuffer.includes('>')) {
            terminalInitialized = true;
            // 只保留最后一个完整的提示符之后的内容
            const lastPromptIndex = terminalOutputBuffer.lastIndexOf('>');
            if (lastPromptIndex !== -1) {
              const displayText = terminalOutputBuffer.substring(lastPromptIndex);
              terminalOutputBuffer = displayText;
              mainWindow.webContents.send('terminal-output', displayText);
            }
            // 初始化完成后，自动执行默认命令
            setTimeout(() => {
              if (terminalProcess && !terminalProcess.killed) {
                terminalProcess.stdin.write('openclaw dashboard --no-open\r\n');
              }
            }, 200);
          }
          // 初始化未完成，不显示输出
        } else {
          // 已初始化，直接显示所有输出
          terminalOutputBuffer = text;
          mainWindow.webContents.send('terminal-output', text);
        }
      }
    });

    terminalProcess.stderr.on('data', (data) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        const text = data.toString('utf8');
        if (terminalInitialized) {
          mainWindow.webContents.send('terminal-output', text);
        }
      }
    });

    terminalProcess.on('close', (code) => {
      terminalProcess = null;
      terminalInitialized = false;
      terminalOutputBuffer = '';
    });

    terminalProcess.on('error', (err) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('terminal-output', `\n[错误] ${err.message}\n`);
      }
      terminalProcess = null;
    });
  } catch (err) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('terminal-output', `\n[初始化失败] ${err.message}\n`);
    }
  }
}

ipcMain.handle('init-terminal', async () => {
  initTerminal();
  return { success: true };
});

ipcMain.handle('terminal-input', async (_, { command }) => {
  if (!terminalProcess || terminalProcess.killed) {
    initTerminal();
  }

  try {
    if (terminalProcess && !terminalProcess.killed) {
      terminalProcess.stdin.write(command + '\r\n');
    }
    return { success: true };
  } catch (err) {
    return { success: false, message: err.message };
  }
});

// ── Window controls ──────────────────────────────────────────

ipcMain.on('window-minimize', () => mainWindow.minimize());
ipcMain.on('window-close', () => mainWindow.hide());
