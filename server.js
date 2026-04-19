const http = require('http');
const fs = require('fs');
const path = require('path');
const https = require('https');

const PORT = process.env.PORT || 6821;
const DATA_DIR = path.join(__dirname, 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const LOG_FILE = path.join(DATA_DIR, 'logs.json');
const STATE_FILE = path.join(DATA_DIR, 'state.json');

// 确保数据目录存在
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ========== 数据读写 ==========
function readJson(file, fallback) {
    try {
        if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {}
    return fallback;
}

function writeJson(file, data) {
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

// ========== 全局状态 ==========
let config = readJson(CONFIG_FILE, { domain: '', pushKey: '', interval: 5 });
let logs = readJson(LOG_FILE, []);
let monitorState = readJson(STATE_FILE, { isMonitoring: false, lastResult: null });
let timerId = null;

// 限制日志数量
function trimLogs() {
    if (logs.length > 200) logs = logs.slice(-200);
}

// ========== 核心逻辑 ==========
function normalizeDomain(raw) {
    let domain = raw.trim().toLowerCase();
    domain = domain.replace(/^(https?:\/\/)?(www\.)?/, '');
    if (!domain.includes('.')) {
        domain = domain + '.xyz';
    } else {
        const parts = domain.split('.');
        if (parts.length >= 2) {
            parts[parts.length - 1] = 'xyz';
            domain = parts.join('.');
        }
    }
    return domain;
}

function checkDomainViaRDAP(domain) {
    return new Promise((resolve, reject) => {
        const rdapUrl = `https://rdap.centralnic.com/xyz/domain/${encodeURIComponent(domain)}?_t=${Date.now()}`;
        https.get(rdapUrl, { headers: { 'Accept': 'application/rdap+json, application/json' } }, (res) => {
            if (res.statusCode === 404) {
                res.resume();
                return resolve({ registered: false, domain: domain });
            }
            if (res.statusCode !== 200) {
                res.resume();
                return reject(new Error(`RDAP 响应异常 (${res.statusCode})`));
            }
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const d = JSON.parse(data);
                    const events = d.events || [];
                    const createEvent = events.find(e => e.eventAction === 'registration');
                    const expireEvent = events.find(e => e.eventAction === 'expiration');
                    const nameservers = (d.nameservers || []).map(ns => ns.ldhName).filter(Boolean);
                    let registrar = '—';
                    if (d.entities) {
                        const re = d.entities.find(e => e.roles.includes('registrar'));
                        if (re && re.vcardArray) {
                            const fn = re.vcardArray[1]?.find(p => p[0] === 'fn');
                            registrar = fn ? fn[3] : (re.handle || '未知');
                        }
                    }
                    resolve({
                        registered: true,
                        domain: d.ldhName || domain,
                        createDate: createEvent ? createEvent.eventDate : null,
                        expiryDate: expireEvent ? expireEvent.eventDate : null,
                        registrar,
                        nameservers
                    });
                } catch (e) {
                    reject(new Error('RDAP 数据解析失败'));
                }
            });
        }).on('error', reject);
    });
}

function hasChanged(oldRes, newRes) {
    if (!oldRes) return true;
    const pick = r => ({
        registered: r.registered,
        domain: r.domain,
        createDate: r.createDate,
        expiryDate: r.expiryDate,
        registrar: r.registrar,
        nameservers: r.nameservers ? r.nameservers.join(',') : ''
    });
    return JSON.stringify(pick(oldRes)) !== JSON.stringify(pick(newRes));
}

function generateChangeDescription(oldRes, newRes) {
    if (!oldRes) return `首次查询: ${newRes.domain} ${newRes.registered ? '已注册' : '可注册'}`;
    const changes = [];
    if (oldRes.registered !== newRes.registered)
        changes.push(`状态: ${oldRes.registered ? '已注册' : '可注册'} → ${newRes.registered ? '已注册' : '可注册'}`);
    if (oldRes.registrar !== newRes.registrar)
        changes.push(`注册商: ${oldRes.registrar} → ${newRes.registrar}`);
    if (oldRes.createDate !== newRes.createDate)
        changes.push(`创建日期: ${oldRes.createDate || '—'} → ${newRes.createDate || '—'}`);
    if (oldRes.expiryDate !== newRes.expiryDate)
        changes.push(`过期日期: ${oldRes.expiryDate || '—'} → ${newRes.expiryDate || '—'}`);
    const oldNS = oldRes.nameservers ? oldRes.nameservers.join(',') : '';
    const newNS = newRes.nameservers ? newRes.nameservers.join(',') : '';
    if (oldNS !== newNS)
        changes.push(`DNS: ${oldNS || '无'} → ${newNS || '无'}`);
    if (changes.length === 0) changes.push('细节字段变更');
    return changes.join('；');
}

function sendPushNotification(title, content) {
    return new Promise((resolve) => {
        if (!config.pushKey) {
            addLog('⚠️ 未设置 PushDeer Key，无法推送');
            return resolve(false);
        }
        const text = `${title}\n${content}`;
        const url = `https://api2.pushdeer.com/message/push?pushkey=${encodeURIComponent(config.pushKey)}&text=${encodeURIComponent(text)}`;
        https.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const result = JSON.parse(data);
                    if (result.code === 0) {
                        addLog(`📤 推送成功: ${title}`);
                        resolve(true);
                    } else {
                        addLog(`⚠️ 推送失败: ${result.message || '未知错误'}`);
                        resolve(false);
                    }
                } catch {
                    addLog(`📤 推送请求已发送: ${title}`);
                    resolve(true);
                }
            });
        }).on('error', (e) => {
            addLog(`⚠️ 推送请求发送失败: ${e.message}`);
            resolve(false);
        });
    });
}

function addLog(message) {
    const time = new Date().toLocaleString('zh-CN', { hour12: false });
    logs.push({ time, message });
    trimLogs();
    writeJson(LOG_FILE, logs);
}

async function performCheck(manual = false) {
    if (!config.domain) {
        addLog('❌ 请填写监控域名');
        return;
    }
    const domain = normalizeDomain(config.domain);
    addLog(`🔍 正在查询 ${domain} ...`);

    try {
        const result = await checkDomainViaRDAP(domain);
        const changed = hasChanged(monitorState.lastResult, result);

        if (changed) {
            const changeDesc = generateChangeDescription(monitorState.lastResult, result);
            const title = `[XYZ监控] ${domain} 状态变动`;
            addLog(`🔔 检测到变化: ${changeDesc}`);
            await sendPushNotification(title, changeDesc);
        } else {
            addLog(manual ? `✅ 查询完成，${domain} 状态无变化` : `⏲️ 周期检查: ${domain} 无变化`);
        }

        monitorState.lastResult = result;
        writeJson(STATE_FILE, monitorState);
    } catch (err) {
        addLog(`❌ 查询出错: ${err.message}`);
    }
}

function scheduleNextCheck() {
    if (timerId) clearTimeout(timerId);
    if (!monitorState.isMonitoring) return;

    const intervalMs = Math.max(1, config.interval) * 60 * 1000;
    timerId = setTimeout(async () => {
        await performCheck();
        scheduleNextCheck();
    }, intervalMs);

    monitorState.nextCheckTime = Date.now() + intervalMs;
    writeJson(STATE_FILE, monitorState);
}

function startMonitoring() {
    if (monitorState.isMonitoring) return;
    if (!config.domain) {
        addLog('❌ 请先填写监控域名');
        return;
    }
    monitorState.isMonitoring = true;
    addLog(`▶ 监控已启动，间隔 ${config.interval} 分钟`);
    writeJson(STATE_FILE, monitorState);
    performCheck().then(() => scheduleNextCheck());
}

function pauseMonitoring() {
    if (!monitorState.isMonitoring) return;
    monitorState.isMonitoring = false;
    if (timerId) { clearTimeout(timerId); timerId = null; }
    monitorState.nextCheckTime = null;
    addLog('⏸️ 监控已暂停');
    writeJson(STATE_FILE, monitorState);
}

// ========== 自动恢复监控 ==========
if (monitorState.isMonitoring && config.domain) {
    addLog('🔄 服务重启，自动恢复监控');
    scheduleNextCheck();
}

// ========== HTTP 服务 ==========
function parseBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try { resolve(body ? JSON.parse(body) : {}); }
            catch { resolve({}); }
        });
        req.on('error', reject);
    });
}

function sendJson(res, data, status = 200) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data));
}

function sendHtml(res, html) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
}

// 前端 HTML 页面
function getFrontendHtml() {
    return `<!DOCTYPE html>
<html lang="zh">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=yes">
    <title>XYZ 域名监控 · 变动推送</title>
    <style>
        * { box-sizing: border-box; font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; }
        body { margin: 0; min-height: 100vh; background: linear-gradient(145deg, #f0f4fa 0%, #e6ecf3 100%); display: flex; justify-content: center; align-items: center; padding: 16px; }
        .card { max-width: 800px; width: 100%; background: #ffffff; border-radius: 36px; box-shadow: 0 20px 40px rgba(0,10,20,0.08); padding: 28px 24px; border: 1px solid #eef2f6; }
        h1 { font-size: 1.9rem; font-weight: 650; margin: 0 0 4px 0; display: flex; align-items: center; gap: 8px; color: #0b2542; flex-wrap: wrap; }
        h1 span { background: #1e3a8a; color: white; font-size: 0.8rem; padding: 4px 12px; border-radius: 40px; font-weight: 500; }
        .sub { color: #3a5670; margin-bottom: 24px; font-size: 0.95rem; border-left: 4px solid #2563eb; padding-left: 16px; }
        .config-section { background: #f8fafd; border-radius: 24px; padding: 20px; margin-bottom: 24px; border: 1px solid #dce5f0; }
        .input-group { margin-bottom: 16px; display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
        .input-group label { width: 100px; font-weight: 600; color: #1e3a5f; font-size: 0.95rem; }
        .input-group input { flex: 1; min-width: 200px; padding: 12px 16px; border: 1.5px solid #d0ddee; border-radius: 40px; font-size: 1rem; outline: none; background: white; transition: 0.15s; }
        .input-group input:focus { border-color: #2563eb; box-shadow: 0 0 0 3px #3b82f630; }
        .input-group small { width: 100%; margin-left: 108px; color: #5f7a9a; font-size: 0.8rem; }
        .badge-xyz { background: #dbeafe; color: #1e40af; border-radius: 40px; padding: 5px 14px; font-weight: 700; font-size: 1rem; border: 1px solid #b2c9f5; white-space: nowrap; }
        .action-bar { display: flex; gap: 12px; flex-wrap: wrap; align-items: center; margin-top: 10px; }
        .btn { background: #1e3a8a; color: white; border: none; border-radius: 60px; padding: 12px 26px; font-weight: 600; font-size: 1rem; cursor: pointer; transition: 0.15s; box-shadow: 0 4px 8px #0f1e3a20; border: 1px solid #3b5cb8; display: inline-flex; align-items: center; gap: 6px; }
        .btn-secondary { background: #eef2f7; color: #1e3a8a; border: 1px solid #b9c8e0; box-shadow: none; }
        .btn-danger { background: #b91c1c; border-color: #dc2626; }
        .btn:disabled { opacity: 0.55; pointer-events: none; }
        .monitor-panel { background: #ffffff; border-radius: 24px; padding: 20px; border: 1px solid #e0e9f2; margin-bottom: 24px; }
        .status-row { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; margin-bottom: 16px; }
        .status-badge { font-weight: 650; padding: 8px 20px; border-radius: 40px; background: #eef2ff; color: #1f3a7c; }
        .timer { margin-left: auto; font-family: monospace; background: #1e293b; color: #facc15; padding: 6px 16px; border-radius: 30px; font-size: 1.2rem; }
        .info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px 18px; margin-top: 16px; }
        .info-item { display: flex; flex-direction: column; border-bottom: 1px dashed #b7c7dd; padding-bottom: 8px; }
        .info-label { font-size: 0.75rem; text-transform: uppercase; color: #556e88; font-weight: 500; }
        .info-value { font-size: 1rem; font-weight: 550; color: #0f253f; word-break: break-word; }
        .log-box { background: #f1f5f9; border-radius: 20px; padding: 14px 16px; max-height: 300px; overflow-y: auto; font-size: 0.85rem; border: 1px solid #cbd6e6; }
        .log-entry { padding: 8px 0; border-bottom: 1px solid #d7e0ea; color: #1e2f44; }
        .log-time { color: #5f7a9a; margin-right: 12px; font-weight: 500; }
        .footnote { margin-top: 16px; font-size: 0.75rem; color: #63778c; text-align: center; }
        @media (max-width: 500px) {
            .card { padding: 20px 16px; }
            h1 { font-size: 1.6rem; }
            .input-group label { width: 100%; margin-bottom: 4px; }
            .input-group small { margin-left: 0; }
            .timer { margin-left: 0; }
            .badge-xyz { padding: 4px 8px; font-size: 0.8rem; }
        }
    </style>
</head>
<body>
<div class="card">
    <h1>📡 XYZ 监控哨兵 <span>PushDeer 联动</span></h1>
    <div class="sub">定时检测 · 状态变动实时推送 · 服务端常驻运行</div>
    <div class="config-section">
        <div class="input-group">
            <label>📋 监控域名</label>
            <div style="display: flex; align-items: center; gap: 4px; flex:1;">
                <input type="text" id="domainInput" placeholder="例如: mybrand" spellcheck="false" />
                <span class="badge-xyz">.xyz</span>
            </div>
            <small>只需输入前缀，自动补全 .xyz</small>
        </div>
        <div class="input-group">
            <label>🔑 PushDeer Key</label>
            <input type="text" id="pushKeyInput" placeholder="PDUxxxxx 或 pushkey" />
            <small>用于接收变动通知，从 PushDeer 获取</small>
        </div>
        <div class="input-group">
            <label>⏱️ 检查间隔</label>
            <input type="number" id="intervalInput" min="1" max="1440" value="5" step="1" style="max-width:120px;" />
            <span style="margin-left: 8px; color:#3a5a7a;">分钟</span>
            <small>建议≥1分钟</small>
        </div>
        <div class="action-bar">
            <button class="btn" id="startBtn">▶ 开始监控</button>
            <button class="btn btn-secondary" id="pauseBtn" disabled>⏸️ 暂停</button>
            <button class="btn btn-secondary" id="forceCheckBtn">🔄 立即查询</button>
            <button class="btn btn-secondary" id="clearLogBtn">🧹 清空日志</button>
        </div>
    </div>
    <div class="monitor-panel">
        <div class="status-row">
            <span class="status-badge" id="monitorStatus">⚪ 未启动</span>
            <span class="timer" id="countdownDisplay">--:--</span>
        </div>
        <div id="lastResultContainer">
            <div style="color: #4a6380; padding: 16px; text-align: center;">等待首次查询…</div>
        </div>
    </div>
    <div style="font-weight: 600; margin-bottom: 8px; color: #1e3a5f;">📋 变化日志</div>
    <div class="log-box" id="logContainer"></div>
    <div class="footnote">⚡ 服务端常驻运行 · 数据对比基于 RDAP 注册局 · 变动即推送</div>
</div>
<script>
(function() {
    "use strict";

    const domainInput = document.getElementById('domainInput');
    const pushKeyInput = document.getElementById('pushKeyInput');
    const intervalInput = document.getElementById('intervalInput');
    const startBtn = document.getElementById('startBtn');
    const pauseBtn = document.getElementById('pauseBtn');
    const forceCheckBtn = document.getElementById('forceCheckBtn');
    const clearLogBtn = document.getElementById('clearLogBtn');
    const monitorStatus = document.getElementById('monitorStatus');
    const countdownDisplay = document.getElementById('countdownDisplay');
    const lastResultContainer = document.getElementById('lastResultContainer');
    const logContainer = document.getElementById('logContainer');

    let countdownInterval = null;

    function esc(t) { if(!t)return t; return String(t).replace(/[&<>"]/g, c=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' })[c]||c); }

    async function api(path, method='GET', body=null) {
        const opts = { method, headers: { 'Content-Type': 'application/json' } };
        if (body) opts.body = JSON.stringify(body);
        const res = await fetch('/api' + path, opts);
        return res.json();
    }

    async function loadState() {
        const state = await api('/state');
        if (state.config) {
            domainInput.value = state.config.domain || '';
            if (state.config.pushKey) pushKeyInput.value = state.config.pushKey;
            intervalInput.value = state.config.interval || 5;
        }
        updateStatusUI(state.isMonitoring);
        if (state.lastResult) renderLastResult(state.lastResult);
        if (state.logs) renderLogs(state.logs);
    }

    function updateStatusUI(isMonitoring) {
        if (isMonitoring) {
            monitorStatus.innerHTML = '🟢 监控中';
            startBtn.disabled = true;
            pauseBtn.disabled = false;
            startCountdown();
        } else {
            monitorStatus.innerHTML = '⚪ 已暂停';
            startBtn.disabled = false;
            pauseBtn.disabled = true;
            countdownDisplay.textContent = '--:--';
            if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }
        }
    }

    function renderLastResult(result) {
        if (!result) {
            lastResultContainer.innerHTML = '<div style="color: #4a6380; padding: 16px; text-align: center;">暂无查询结果</div>';
            return;
        }
        const isReg = result.registered;
        const statusText = isReg ? '🔴 已注册' : '🟢 可注册';
        let html = '<div style="margin-bottom:10px;"><span style="background:' + (isReg?'#ffeae3':'#e2f3e4') + ';color:' + (isReg?'#a73d0b':'#0b6e2e') + ';padding:6px 18px;border-radius:30px;font-weight:600;">' + statusText + ' · ' + esc(result.domain) + '</span></div>';
        if (isReg) {
            const create = result.createDate ? new Date(result.createDate).toLocaleDateString('zh-CN') : '—';
            const expire = result.expiryDate ? new Date(result.expiryDate).toLocaleDateString('zh-CN') : '—';
            const nsPreview = result.nameservers && result.nameservers.length ? result.nameservers.slice(0,2).join(' · ') : '—';
            html += '<div class="info-grid"><div class="info-item"><span class="info-label">注册商</span><span class="info-value">' + (esc(result.registrar)||'—') + '</span></div><div class="info-item"><span class="info-label">创建日期</span><span class="info-value">' + esc(create) + '</span></div><div class="info-item"><span class="info-label">过期日期</span><span class="info-value">' + esc(expire) + '</span></div><div class="info-item"><span class="info-label">DNS</span><span class="info-value">' + esc(nsPreview) + '</span></div></div>';
        } else {
            html += '<div style="background:#e4f2e4;border-radius:18px;padding:16px;margin-top:8px;">✅ ' + esc(result.domain) + ' 当前可注册</div>';
        }
        lastResultContainer.innerHTML = html;
    }

    function renderLogs(logsArr) {
        logContainer.innerHTML = '';
        const recent = logsArr.slice(-50);
        recent.forEach(l => {
            const div = document.createElement('div');
            div.className = 'log-entry';
            div.innerHTML = '<span class="log-time">[' + esc(l.time) + ']</span> ' + esc(l.message);
            logContainer.appendChild(div);
        });
        logContainer.scrollTop = logContainer.scrollHeight;
    }

    function startCountdown() {
        if (countdownInterval) clearInterval(countdownInterval);
        countdownInterval = setInterval(async () => {
            const state = await api('/state');
            if (state.isMonitoring && state.nextCheckTime) {
                const remaining = Math.max(0, state.nextCheckTime - Date.now());
                if (remaining <= 0) {
                    countdownDisplay.textContent = '即将执行';
                } else {
                    const mins = Math.floor(remaining / 60000);
                    const secs = Math.floor((remaining % 60000) / 1000);
                    countdownDisplay.textContent = mins.toString().padStart(2,'0') + ':' + secs.toString().padStart(2,'0');
                }
            } else {
                countdownDisplay.textContent = '--:--';
            }
        }, 2000);
    }

    // 保存配置
    async function saveConfig() {
        const payload = {
            domain: domainInput.value.trim(),
            interval: parseInt(intervalInput.value, 10) || 5
        };
        const pk = pushKeyInput.value.trim();
        if (pk && !pk.startsWith('******')) payload.pushKey = pk;
        await api('/config', 'POST', payload);
    }

    startBtn.addEventListener('click', async () => {
        await saveConfig();
        const res = await api('/start', 'POST');
        updateStatusUI(res.isMonitoring);
        setTimeout(loadState, 1000);
    });

    pauseBtn.addEventListener('click', async () => {
        const res = await api('/pause', 'POST');
        updateStatusUI(res.isMonitoring);
    });

    forceCheckBtn.addEventListener('click', async () => {
        await saveConfig();
        await api('/check', 'POST');
        setTimeout(loadState, 2000);
    });

    clearLogBtn.addEventListener('click', async () => {
        await api('/clear-logs', 'POST');
        logContainer.innerHTML = '<div class="log-entry">✨ 日志已清空</div>';
    });

    domainInput.addEventListener('change', saveConfig);
    pushKeyInput.addEventListener('change', saveConfig);
    intervalInput.addEventListener('change', saveConfig);

    // 自动刷新
    setInterval(loadState, 10000);

    loadState();
})();
</script>
</body>
</html>`;
}

// ========== 路由 ==========
const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;

    // 首页
    if (pathname === '/' || pathname === '/index.html') {
        return sendHtml(res, getFrontendHtml());
    }

    // API 路由
    if (pathname.startsWith('/api/')) {
        try {
            // 获取状态
            if (pathname === '/api/state' && req.method === 'GET') {
                return sendJson(res, {
                    isMonitoring: monitorState.isMonitoring,
                    lastResult: monitorState.lastResult,
                    nextCheckTime: monitorState.nextCheckTime || null,
                    logs: logs.slice(-50),
                    config: { domain: config.domain, pushKey: config.pushKey ? '******' + config.pushKey.slice(-4) : '', interval: config.interval }
                });
            }

            // 保存配置
            if (pathname === '/api/config' && req.method === 'POST') {
                const body = await parseBody(req);
                if (body.domain !== undefined) config.domain = body.domain;
                if (body.pushKey !== undefined) config.pushKey = body.pushKey;
                if (body.interval !== undefined) config.interval = Math.max(1, parseInt(body.interval, 10) || 5);
                writeJson(CONFIG_FILE, config);

                // 如果正在监控，重新调度
                if (monitorState.isMonitoring) {
                    if (timerId) clearTimeout(timerId);
                    scheduleNextCheck();
                }
                return sendJson(res, { ok: true, config });
            }

            // 开始监控
            if (pathname === '/api/start' && req.method === 'POST') {
                startMonitoring();
                return sendJson(res, { ok: true, isMonitoring: monitorState.isMonitoring });
            }

            // 暂停监控
            if (pathname === '/api/pause' && req.method === 'POST') {
                pauseMonitoring();
                return sendJson(res, { ok: true, isMonitoring: monitorState.isMonitoring });
            }

            // 手动查询
            if (pathname === '/api/check' && req.method === 'POST') {
                performCheck(true);
                return sendJson(res, { ok: true, message: '查询已触发' });
            }

            // 清空日志
            if (pathname === '/api/clear-logs' && req.method === 'POST') {
                logs = [];
                writeJson(LOG_FILE, logs);
                return sendJson(res, { ok: true });
            }

            sendJson(res, { error: 'Not Found' }, 404);
        } catch (e) {
            sendJson(res, { error: e.message }, 500);
        }
        return;
    }

    sendJson(res, { error: 'Not Found' }, 404);
});

server.listen(PORT, () => {
    console.log(`XYZ 域名监控服务已启动: http://0.0.0.0:${PORT}`);
    addLog('🚀 服务已启动，端口 ' + PORT);
});
