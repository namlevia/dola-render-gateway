/**
 * Seedance Studio Pro - Comprehensive Extension Logger
 * Tracks all user actions, UI clicks, image upload flow, message relay, and Dola DOM interactions.
 */
(() => {
    'use strict';

    const STORAGE_KEY = 'SEEDANCE_STUDIO_ACTIVITY_LOGS';
    const MAX_LOGS = 3000;

    // Determine current environment
    const isMainWorld = typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage;
    const isExtensionPage = typeof window !== 'undefined' && typeof document !== 'undefined' && location.protocol === 'chrome-extension:';
    const isContentScript = typeof chrome !== 'undefined' && chrome.runtime && typeof window !== 'undefined' && location.protocol !== 'chrome-extension:';
    const isServiceWorker = typeof importScripts === 'function' || (typeof window === 'undefined' && typeof self !== 'undefined');

    // Helper: format timestamp
    function getTimestamp() {
        const now = new Date();
        const pad = (n, len = 2) => String(n).padStart(len, '0');
        const h = pad(now.getHours());
        const m = pad(now.getMinutes());
        const s = pad(now.getSeconds());
        const ms = pad(now.getMilliseconds(), 3);
        return `${h}:${m}:${s}.${ms}`;
    }

    // Helper: safe serialize
    function safeSerialize(obj, maxLen = 300) {
        if (obj === null || obj === undefined) return '';
        if (typeof obj === 'string') return obj.length > maxLen ? obj.slice(0, maxLen) + '…' : obj;
        if (typeof obj === 'number' || typeof obj === 'boolean') return String(obj);
        try {
            const seen = new WeakSet();
            const str = JSON.stringify(obj, (k, v) => {
                if (typeof v === 'object' && v !== null) {
                    if (seen.has(v)) return '[Circular]';
                    seen.add(v);
                }
                if (typeof v === 'string' && v.startsWith('data:image')) {
                    return `[DataURL ${v.slice(0, 30)}... len=${v.length}]`;
                }
                if (typeof v === 'string' && v.length > maxLen) {
                    return v.slice(0, maxLen) + '…';
                }
                return v;
            });
            return str.length > maxLen * 2 ? str.slice(0, maxLen * 2) + '…' : str;
        } catch {
            return String(obj);
        }
    }

    // Create log entry object
    function createLogEntry(category, action, details) {
        return {
            id: Date.now() + '-' + Math.random().toString(36).slice(2, 6),
            time: getTimestamp(),
            timestamp: Date.now(),
            category: category || 'GENERAL',
            action: action || '',
            details: safeSerialize(details),
            rawDetails: details
        };
    }

    // MAIN WORLD LOGGER
    if (isMainWorld) {
        window.__SEEDANCE_MAIN_LOG__ = (category, action, details) => {
            const entry = createLogEntry(category, action, details);
            console.log(`%c[SEEDANCE_MAIN:${entry.category}] %c${entry.action}`, 'color: #06b6d4; font-weight: bold;', 'color: #3b82f6;', details || '');
            try {
                window.dispatchEvent(new CustomEvent('seedance:main-log', { detail: entry }));
            } catch (e) {
                console.warn('[Logger] Failed dispatch main-log', e);
            }
        };
        return;
    }

    // EXTENSION OR CONTENT SCRIPT CONTEXT
    const Logger = {
        logs: [],
        listeners: new Set(),

        init() {
            if (isExtensionPage) {
                this.loadLogs();
                this.installPopupListeners();
                this.installGlobalClickListener();
                this.setupLogUI();
            } else if (isContentScript) {
                this.installContentScriptListeners();
            }

            // Global access
            if (typeof window !== 'undefined') {
                window.__SEEDANCE_LOG__ = this.log.bind(this);
                window.__SEEDANCE_LOGGER__ = this;
            }
        },

        log(category, action, details) {
            const entry = createLogEntry(category, action, details);

            // Colored console output
            const colorMap = {
                CLICK: '#ec4899',
                IMAGE: '#eab308',
                UPLOAD: '#10b981',
                RELAY: '#8b5cf6',
                PROMPT: '#3b82f6',
                ERROR: '#ef4444',
                MSG: '#64748b'
            };
            const color = colorMap[category] || '#06b6d4';
            console.log(`%c[${entry.time}] [${entry.category}] %c${entry.action}`, `color: ${color}; font-weight: bold;`, 'color: inherit;', details || '');

            if (isContentScript) {
                // Relay to background
                try {
                    chrome.runtime.sendMessage({ action: 'SEEDANCE_LOG_ENTRY', entry }).catch(() => {});
                } catch {}
                return;
            }

            // In popup / extension page
            this.logs.unshift(entry);
            if (this.logs.length > MAX_LOGS) this.logs.pop();

            this.persist();
            this.notify(entry);
        },

        notify(entry) {
            this.listeners.forEach(fn => {
                try { fn(entry); } catch {}
            });
        },

        subscribe(fn) {
            this.listeners.add(fn);
            return () => this.listeners.delete(fn);
        },

        loadLogs() {
            try {
                chrome.storage.local.get(STORAGE_KEY, (res) => {
                    if (res && Array.isArray(res[STORAGE_KEY])) {
                        this.logs = res[STORAGE_KEY];
                        this.updateUI();
                    }
                });
            } catch {
                try {
                    const raw = localStorage.getItem(STORAGE_KEY);
                    if (raw) this.logs = JSON.parse(raw);
                } catch {}
            }
        },

        persist() {
            try {
                chrome.storage.local.set({ [STORAGE_KEY]: this.logs.slice(0, 1000) });
            } catch {
                try {
                    localStorage.setItem(STORAGE_KEY, JSON.stringify(this.logs.slice(0, 500)));
                } catch {}
            }
        },

        clear() {
            this.logs = [];
            try {
                chrome.storage.local.remove(STORAGE_KEY);
                localStorage.removeItem(STORAGE_KEY);
            } catch {}
            this.updateUI();
        },

        exportText() {
            const lines = this.logs.slice().reverse().map(l => {
                return `[${l.time}] [${l.category.padEnd(10, ' ')}] ${l.action}${l.details ? ' -> ' + l.details : ''}`;
            });
            return `=== SEEDANCE STUDIO PRO ACTIVITY LOG ===\nExported At: ${new Date().toLocaleString('vi-VN')}\nTotal Events: ${lines.length}\n=========================================\n\n` + lines.join('\n');
        },

        // Content Script Listeners
        installContentScriptListeners() {
            // Listen for logs from MAIN world
            window.addEventListener('seedance:main-log', (e) => {
                if (e.detail) {
                    try {
                        chrome.runtime.sendMessage({ action: 'SEEDANCE_LOG_ENTRY', entry: e.detail }).catch(() => {});
                    } catch {}
                }
            }, true);

            // Track DOM clicks on Dola page
            document.addEventListener('click', (e) => {
                const target = e.target.closest('button, [role="button"], a, input, textarea, select');
                if (!target) return;
                const path = target.querySelector('path')?.getAttribute('d') || '';
                const isPlus = path.includes('M12') && path.includes('2.25');
                const text = (target.innerText || target.getAttribute('aria-label') || target.title || '').trim().slice(0, 60);

                this.log('DOLA_PAGE', 'USER_CLICK_ON_PAGE', {
                    tag: target.tagName,
                    id: target.id || '',
                    class: target.className ? String(target.className).slice(0, 80) : '',
                    text: text || (isPlus ? '[Plus Icon (+)]' : ''),
                    isPlusControl: isPlus
                });
            }, true);
        },

        // Popup Page Global Click Listener
        installGlobalClickListener() {
            document.addEventListener('click', (e) => {
                const el = e.target.closest('button, a, input, select, [role="button"], [role="tab"], .preset-chip, .creator-brand-chip');
                if (!el) return;

                // Don't log clicks inside the terminal/log buttons to avoid clutter
                if (el.closest('#terminal') || el.closest('#log-action-bar')) return;

                const text = (el.innerText || el.value || el.title || el.getAttribute('aria-label') || '').trim().slice(0, 80);
                const tag = el.tagName.toLowerCase();
                const id = el.id || '';
                const role = el.getAttribute('role') || '';

                this.log('CLICK', `CLICK: <${tag}${id ? '#' + id : ''}> "${text}"`, {
                    tag,
                    id,
                    className: el.className ? String(el.className).slice(0, 80) : '',
                    text,
                    role,
                    dataset: Object.keys(el.dataset).length ? el.dataset : undefined
                });
            }, true);

            // Also track changes on inputs/selects
            document.addEventListener('change', (e) => {
                const el = e.target;
                if (!el) return;
                const tag = el.tagName.toLowerCase();
                const id = el.id || '';
                let val = el.type === 'checkbox' ? el.checked : el.value;
                if (el.type === 'password') val = '***';
                if (typeof val === 'string' && val.length > 100) val = val.slice(0, 100) + '…';

                this.log('INPUT_CHANGE', `CHANGE: <${tag}${id ? '#' + id : ''}> = ${val}`, {
                    id,
                    type: el.type || '',
                    value: val
                });
            }, true);
        },

        // Listen for messages from content scripts/background
        installPopupListeners() {
            try {
                chrome.runtime.onMessage.addListener((msg) => {
                    if (msg && msg.action === 'SEEDANCE_LOG_ENTRY' && msg.entry) {
                        this.logs.unshift(msg.entry);
                        if (this.logs.length > MAX_LOGS) this.logs.pop();
                        this.persist();
                        this.notify(msg.entry);
                    }
                });
            } catch {}
        },

        // Render Live Log Console in #view-logs
        setupLogUI() {
            const viewLogs = document.getElementById('view-logs');
            const terminal = document.getElementById('terminal');
            if (!viewLogs || !terminal) return;

            // Enhance terminal wrapper with a top toolbar
            const toolbarHtml = `
                <div id="log-action-bar" style="display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 12px; padding-bottom: 10px; border-bottom: 1px solid rgba(255,255,255,0.1);">
                    <div style="display: flex; gap: 6px; align-items: center;">
                        <button id="btn-copy-logs" type="button" class="btn-primary" style="padding: 6px 12px; font-size: 12px; font-weight: 600; display: inline-flex; align-items: center; gap: 4px;">
                            📋 Sao Chép Log
                        </button>
                        <button id="btn-download-logs" type="button" class="btn-secondary" style="padding: 6px 12px; font-size: 12px; font-weight: 600; display: inline-flex; align-items: center; gap: 4px;">
                            💾 Tải File .txt
                        </button>
                        <button id="btn-clear-logs" type="button" class="btn-secondary" style="padding: 6px 10px; font-size: 12px; color: #ef4444; border-color: rgba(239,68,68,0.3);">
                            🗑️ Xóa
                        </button>
                    </div>
                    <div style="display: flex; align-items: center; gap: 8px;">
                        <label style="display: inline-flex; align-items: center; gap: 4px; font-size: 11px; cursor: pointer; color: #94a3b8; user-select: none;">
                            <input type="checkbox" id="chk-auto-scroll-logs" checked style="cursor: pointer;">
                            Tự cuộn
                        </label>
                        <span id="log-counter-pill" style="background: rgba(14,165,233,0.2); color: #38bdf8; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 700;">
                            0 sự kiện
                        </span>
                    </div>
                </div>
            `;

            // Insert toolbar before terminal
            if (!document.getElementById('log-action-bar')) {
                terminal.insertAdjacentHTML('beforebegin', toolbarHtml);
            }

            // Customize terminal styling
            terminal.style.fontFamily = 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';
            terminal.style.fontSize = '11px';
            terminal.style.lineHeight = '1.5';
            terminal.style.maxHeight = '420px';
            terminal.style.overflowY = 'auto';
            terminal.style.padding = '10px 12px';
            terminal.style.background = '#090d16';
            terminal.style.color = '#e2e8f0';
            terminal.style.borderRadius = '8px';
            terminal.style.border = '1px solid rgba(255,255,255,0.08)';

            // Hook Toolbar Buttons
            document.getElementById('btn-copy-logs')?.addEventListener('click', () => {
                const text = this.exportText();
                navigator.clipboard.writeText(text).then(() => {
                    const btn = document.getElementById('btn-copy-logs');
                    const orig = btn.innerText;
                    btn.innerText = '✓ Đã Copy Toàn Bộ!';
                    btn.style.background = '#10b981';
                    setTimeout(() => {
                        btn.innerText = orig;
                        btn.style.background = '';
                    }, 2000);
                });
            });

            document.getElementById('btn-download-logs')?.addEventListener('click', () => {
                const text = this.exportText();
                const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                const now = new Date();
                const pad = (n) => String(n).padStart(2, '0');
                a.download = `Seedance_Logs_${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.txt`;
                a.click();
                URL.revokeObjectURL(url);
            });

            document.getElementById('btn-clear-logs')?.addEventListener('click', () => {
                if (confirm('Bạn có chắc muốn xóa toàn bộ nhật ký đã ghi?')) {
                    this.clear();
                }
            });

            // Re-render terminal when logs change
            this.subscribe(() => this.updateUI());

            // Initial render
            this.updateUI();
        },

        updateUI() {
            const terminal = document.getElementById('terminal');
            const counterPill = document.getElementById('log-counter-pill');
            const tabLogsLabel = document.querySelector('#tab-logs .nav-dock-label');

            if (counterPill) {
                counterPill.innerText = `${this.logs.length} sự kiện`;
            }
            if (tabLogsLabel) {
                tabLogsLabel.innerText = this.logs.length > 0 ? `Nhật Ký (${this.logs.length})` : 'Nhật Ký';
            }

            if (!terminal) return;

            if (this.logs.length === 0) {
                terminal.innerHTML = `
                    <div style="color: #64748b; padding: 20px 0; text-align: center;">
                        Chưa có sự kiện nào được ghi nhận.<br>
                        Khi bạn thao tác (chọn ảnh, bấm nút, tạo video...), mọi hoạt động sẽ hiển thị trực tiếp ở đây!
                    </div>
                `;
                return;
            }

            const colorMap = {
                CLICK: '#f43f5e',
                INPUT_CHANGE: '#f97316',
                IMAGE: '#eab308',
                UPLOAD: '#10b981',
                RELAY: '#8b5cf6',
                PROMPT: '#38bdf8',
                DOLA_PAGE: '#06b6d4',
                ERROR: '#ef4444',
                MSG: '#94a3b8'
            };

            const html = this.logs.slice(0, 500).map(l => {
                const c = colorMap[l.category] || '#38bdf8';
                const detailStr = l.details ? `<div style="color: #94a3b8; font-size: 10px; margin-top: 1px; word-break: break-all; padding-left: 10px;">${escapeHtml(l.details)}</div>` : '';
                return `
                    <div style="margin-bottom: 6px; padding-bottom: 4px; border-bottom: 1px solid rgba(255,255,255,0.04);">
                        <span style="color: #64748b; margin-right: 6px;">${l.time}</span>
                        <span style="display: inline-block; padding: 1px 5px; border-radius: 4px; font-size: 9px; font-weight: 700; background: ${c}22; color: ${c}; margin-right: 6px;">${l.category}</span>
                        <span style="color: #f1f5f9; font-weight: 500;">${escapeHtml(l.action)}</span>
                        ${detailStr}
                    </div>
                `;
            }).join('');

            terminal.innerHTML = html;

            const chkAutoScroll = document.getElementById('chk-auto-scroll-logs');
            if (chkAutoScroll && chkAutoScroll.checked) {
                terminal.scrollTop = 0; // Latest logs are at top
            }
        }
    };

    function escapeHtml(str) {
        if (!str) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    // Auto-init on DOMContentLoaded or immediate
    if (typeof document !== 'undefined') {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => Logger.init());
        } else {
            Logger.init();
        }
    }
})();
