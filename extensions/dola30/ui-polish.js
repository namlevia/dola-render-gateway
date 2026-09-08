(function () {
    'use strict';

    const confirmationCopy = {
        'btn-clear-session': {
            title: 'Làm mới phiên làm việc?',
            description: 'Thao tác này sẽ làm mới trạng thái tài khoản trên tab hiện tại.',
            confirmLabel: 'Làm mới phiên'
        },
        'btn-clear-prompts': {
            title: 'Xóa toàn bộ kịch bản?',
            description: 'Mọi phân cảnh và trạng thái tiến độ đã lưu sẽ bị xóa sạch.',
            confirmLabel: 'Đồng ý xóa'
        },
        'btn-clear-images': {
            title: 'Xóa toàn bộ ảnh mẫu?',
            description: 'Mọi ảnh trong hàng đợi Img2Vid sẽ bị xóa sạch.',
            confirmLabel: 'Đồng ý xóa'
        },
        'btn-clear-all-accounts': {
            title: 'Xóa toàn bộ nick đã lưu?',
            description: 'Mọi tài khoản và cookie đã lưu sẽ bị xóa khỏi extension.',
            confirmLabel: 'Đồng ý xóa'
        },
        'btn-reset-progress': {
            title: 'Đặt lại tiến độ kịch bản?',
            description: 'Tất cả các phân cảnh đã hoàn thành sẽ chuyển về trạng thái đang chờ.',
            confirmLabel: 'Đặt lại tiến độ'
        }
    };

    document.addEventListener('DOMContentLoaded', () => {
        if (typeof globalThis !== 'undefined' && globalThis.__SR_SECURITY_SHIELD__) {
            globalThis.__SR_SECURITY_SHIELD__.mountProtectedLinks();
        }
        syncTabAccessibility();
        installTabStateObserver();
        installLicenseStateObserver();
        installRuntimeCopyPolish();
        installConfirmationDialog();
        installInteractiveFileDropzone();
        installPresetChips();
        installPromptItemActions();
    });

    function installPresetChips() {
        const textarea = document.getElementById('textarea-quick-prompts');
        const chips = document.querySelectorAll('.preset-chip');
        if (!textarea || !chips.length) return;

        chips.forEach(chip => {
            chip.addEventListener('click', (e) => {
                e.preventDefault();
                const style = chip.dataset.style || '';
                if (!style) return;
                const current = textarea.value.trim();
                if (!current) {
                    textarea.value = style;
                } else {
                    textarea.value = current + ', ' + style;
                }
                textarea.dispatchEvent(new Event('input', { bubbles: true }));
                textarea.focus();
            });
        });
    }

    function installInteractiveFileDropzone() {
        const fileInput = document.getElementById('file-upload-prompts');
        const triggerBtn = document.getElementById('btn-trigger-upload-prompts');
        const container = document.getElementById('prompts-container');
        if (!fileInput) return;

        if (triggerBtn) {
            triggerBtn.addEventListener('click', (e) => {
                e.preventDefault();
                fileInput.click();
            });
        }

        if (container) {
            container.addEventListener('click', (event) => {
                const emptyState = event.target.closest('.empty-state, #prompts-empty-dropzone');
                if (emptyState) {
                    event.preventDefault();
                    fileInput.click();
                }
            });
        }

        fileInput.addEventListener('change', (event) => {
            const files = event.target.files;
            if (!files || !files.length) return;

            const file = files[0];
            const reader = new FileReader();

            reader.onload = (e) => {
                const textContent = e.target.result || '';
                let paragraphs = [];

                if (window.CTBParagraphPrompts && typeof window.CTBParagraphPrompts.parseParagraphs === 'function') {
                    paragraphs = window.CTBParagraphPrompts.parseParagraphs(textContent);
                } else {
                    paragraphs = String(textContent)
                        .replace(/\r\n?/g, '\n')
                        .split(/\n+/)
                        .map(p => p.trim())
                        .filter(Boolean);
                }

                if (!paragraphs.length) {
                    alert('No prompts found in the selected file.');
                    fileInput.value = '';
                    return;
                }

                const STORAGE_KEY = 'ctb_saved_prompts';
                chrome.storage.local.get([STORAGE_KEY], (result) => {
                    const saved = Array.isArray(result?.[STORAGE_KEY]) ? result[STORAGE_KEY] : [];
                    const additions = paragraphs.map((text, index) => ({
                        title: `Prompt #${saved.length + index + 1}`,
                        text,
                        done: false
                    }));
                    const updated = [...saved, ...additions];

                    chrome.storage.local.set({ [STORAGE_KEY]: updated }, () => {
                        fileInput.value = '';
                        window.location.reload();
                    });
                });
            };

            reader.readAsText(file);
        });
    }

    function disableStudioFeature() {
        const studioTab = document.getElementById('tab-generator');
        const studioView = document.getElementById('view-generator');
        const promptsTab = document.getElementById('tab-prompts');
        if (!studioTab || !studioView || !promptsTab) return;

        studioTab.hidden = true;
        studioTab.tabIndex = -1;
        studioTab.setAttribute('aria-hidden', 'true');
        studioTab.setAttribute('aria-selected', 'false');
        studioView.hidden = true;
        studioView.classList.add('hidden');
        studioView.setAttribute('aria-hidden', 'true');

        const redirectFromStudio = () => {
            const hasVisibleActiveTab = document.querySelector('.nav-btn.active:not([hidden])');
            if (studioTab.classList.contains('active') || !hasVisibleActiveTab) promptsTab.click();
        };

        redirectFromStudio();
        const observer = new MutationObserver(redirectFromStudio);
        observer.observe(studioTab, { attributes: true, attributeFilter: ['class'] });
        observer.observe(studioView, { attributes: true, attributeFilter: ['class', 'style'] });
    }

    function syncTabAccessibility() {
        document.querySelectorAll('.nav-btn').forEach((button) => {
            if (button.hidden) {
                button.setAttribute('aria-selected', 'false');
                button.tabIndex = -1;
                const hiddenPanelId = button.getAttribute('aria-controls');
                const hiddenPanel = hiddenPanelId ? document.getElementById(hiddenPanelId) : null;
                if (hiddenPanel) hiddenPanel.setAttribute('aria-hidden', 'true');
                return;
            }
            const isActive = button.classList.contains('active');
            button.setAttribute('aria-selected', String(isActive));
            button.tabIndex = isActive ? 0 : -1;

            const panelId = button.getAttribute('aria-controls');
            const panel = panelId ? document.getElementById(panelId) : null;
            if (panel) panel.setAttribute('aria-hidden', String(!isActive));
        });
    }

    function installTabStateObserver() {
        const tabs = document.querySelector('.nav-tabs');
        if (!tabs) return;

        tabs.addEventListener('keydown', (event) => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            const buttons = Array.from(tabs.querySelectorAll('.nav-btn:not([hidden])'));
            const currentIndex = buttons.indexOf(document.activeElement);
            if (currentIndex < 0) return;

            event.preventDefault();
            let nextIndex = currentIndex;
            if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % buttons.length;
            if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + buttons.length) % buttons.length;
            if (event.key === 'Home') nextIndex = 0;
            if (event.key === 'End') nextIndex = buttons.length - 1;
            buttons[nextIndex].focus();
            buttons[nextIndex].click();
        });

        new MutationObserver(syncTabAccessibility).observe(tabs, {
            attributes: true,
            attributeFilter: ['class'],
            subtree: true
        });
    }

    function installLicenseStateObserver() {
        const lock = document.getElementById('view-license-lock');
        const main = document.getElementById('main-unlocked-ui');

        const forceUnlock = () => {
            if (lock && lock.style.display !== 'none') {
                lock.style.setProperty('display', 'none', 'important');
            }
            if (main && main.style.display !== 'flex') {
                main.style.setProperty('display', 'flex', 'important');
            }
            document.body.classList.remove('license-locked');
        };

        if (lock && main) {
            const observer = new MutationObserver(forceUnlock);
            observer.observe(lock, { attributes: true, attributeFilter: ['style', 'class'] });
            observer.observe(main, { attributes: true, attributeFilter: ['style', 'class'] });
        }
        forceUnlock();
    }

    function installRuntimeCopyPolish() {
        const accountBadge = document.getElementById('header-active-account');
        const copyButton = document.getElementById('btn-copy-machine-id');
        const fetchButton = document.getElementById('btn-fetch');
        const licenseInfo = document.getElementById('settings-license-info');
        const activationStatus = document.getElementById('activation-error');
        const prompts = document.getElementById('prompts-container');
        const profiles = document.getElementById('profiles-container');

        const polishAccount = () => {
            if (!accountBadge) return;
            const current = accountBadge.textContent.trim();
            if (/default/i.test(current)) {
                accountBadge.textContent = '🟢 Mặc định';
            } else if (current && !current.startsWith('🟢') && !current.startsWith('🔴')) {
                accountBadge.textContent = '🟢 ' + current;
            }
        };

        const polishCopyButton = () => {
            if (!copyButton) return;
            const current = copyButton.textContent.trim();
            let next = current;
            if (/copied/i.test(current)) next = '📋 Đã sao chép';
            else if (/copy/i.test(current)) next = '📋 Sao chép mã';
            if (next !== current) copyButton.textContent = next;
        };

        const polishFetchButton = () => {
            if (!fetchButton) return;
            const label = fetchButton.querySelector('span');
            if (!label || label.querySelector('strong')) return;
            const current = label.textContent.trim();
            if (/fetching|downloading/i.test(current)) {
                label.className = 'button-copy';
                label.innerHTML = '<strong>Đang tải video…</strong><small>Bóc tách luồng master 1080P</small>';
            } else if (/download/i.test(current)) {
                label.className = 'button-copy';
                label.innerHTML = '<strong>Tải Video 1080P</strong><small>Lưu video gốc chất lượng cao nhất</small>';
            }
        };

        const polishLicenseInfo = () => {
            if (!licenseInfo) return;
            const current = licenseInfo.textContent.trim();
            if (!current) return;
            if (/sonicvoice|0908\s*449\s*168/i.test(current)) return;
            if (/lifetime|activated|active|vip/i.test(current)) {
                licenseInfo.textContent = 'Chính chủ Sonicvoice.pro · Hỗ trợ Zalo 0908 449 168';
            }
        };

        const polishActivationStatus = () => {
            if (!activationStatus) return;
            const current = activationStatus.textContent.trim();
            let next = current;
            let success = false;
            if (/please enter a vip license key/i.test(current)) next = 'Vui lòng nhập mã bản quyền.';
            if (/license activated successfully/i.test(current)) {
                next = 'Kích hoạt thành công. Đang mở Studio…';
                success = true;
            }
            if (/invalid vip key/i.test(current)) next = 'Mã không hợp lệ cho thiết bị này.';
            if (next !== current) activationStatus.textContent = next;
            activationStatus.classList.toggle('success', success || /activated|thành công/i.test(next));
            activationStatus.style.removeProperty('color');
        };

        const polishDynamicCards = (root) => {
            if (!root) return;
            const setButtonText = (button, text) => {
                if (button.textContent !== text) button.textContent = text;
            };
            root.querySelectorAll('.btn-prompt-paste').forEach((button) => {
                setButtonText(button, 'Dán');
                button.setAttribute('aria-label', 'Dán phân cảnh vào ô chat Dola');
                button.setAttribute('title', 'Dán phân cảnh vào ô chat Dola');
            });
            root.querySelectorAll('.btn-mini-tab').forEach((button) => {
                setButtonText(button, 'Mở Tab');
                button.setAttribute('aria-label', 'Mở tài khoản');
            });
            root.querySelectorAll('.btn-mini-newtab').forEach((button) => {
                setButtonText(button, 'Tab Mới');
                button.setAttribute('aria-label', 'Mở tài khoản trong tab mới');
            });
            root.querySelectorAll('.btn-mini-switch').forEach((button) => {
                setButtonText(button, 'Kích Hoạt');
                button.setAttribute('aria-label', 'Chuyển sang tài khoản này');
            });
            root.querySelectorAll('.btn-prompt-del').forEach((button) => {
                setButtonText(button, '×');
                button.setAttribute('aria-label', 'Xóa phân cảnh');
                button.setAttribute('title', 'Xóa phân cảnh');
            });
            root.querySelectorAll('.btn-toggle-done').forEach((button) => {
                const isDone = Boolean(button.closest('.prompt-done'));
                setButtonText(button, isDone ? '✓' : '○');
                button.setAttribute('aria-label', isDone ? 'Đã xong' : 'Đang chờ');
                button.setAttribute('title', isDone ? 'Bấm để chuyển về đang chờ' : 'Bấm để đánh dấu đã xong');
            });

            // Polish empty states:
            root.querySelectorAll('.empty-state, #prompts-empty-dropzone').forEach(el => {
                if (/no prompts loaded|click here to select|paste prompts above/i.test(el.textContent)) {
                    el.textContent = '📁 Chưa có phân cảnh nào. Hãy bấm vào đây để nạp file (.txt, .csv) hoặc dán kịch bản ở trên.';
                } else if (/no saved accounts yet/i.test(el.textContent)) {
                    el.textContent = '👥 Chưa có tài khoản nào được lưu. Đăng nhập Dola rồi bấm "💾 Lưu Tab Đang Mở" nhé!';
                }
            });
        };

        const observe = (element, callback, options) => {
            if (!element) return;
            callback();
            new MutationObserver(callback).observe(element, options || {
                childList: true,
                characterData: true,
                subtree: true
            });
        };

        observe(accountBadge, polishAccount);
        observe(copyButton, polishCopyButton);
        observe(fetchButton, polishFetchButton);
        observe(licenseInfo, polishLicenseInfo);
        observe(activationStatus, polishActivationStatus);
        observe(prompts, () => polishDynamicCards(prompts));
        observe(profiles, () => polishDynamicCards(profiles));
    }

    function installConfirmationDialog() {
        const dialog = document.getElementById('confirm-dialog');
        const title = document.getElementById('confirm-dialog-title');
        const description = document.getElementById('confirm-dialog-description');
        const cancelButton = document.getElementById('confirm-dialog-cancel');
        const acceptButton = document.getElementById('confirm-dialog-accept');
        if (!dialog || typeof dialog.showModal !== 'function' || !title || !description || !cancelButton || !acceptButton) return;

        const nativeConfirm = window.confirm.bind(window);
        let pendingTarget = null;
        let confirmedTarget = null;
        let bypassNextNativeConfirm = false;

        window.confirm = (message) => {
            if (bypassNextNativeConfirm) {
                bypassNextNativeConfirm = false;
                return true;
            }
            return nativeConfirm(message);
        };

        document.addEventListener('click', (event) => {
            const button = event.target.closest('button');
            if (!button) return;
            if (button === confirmedTarget) {
                confirmedTarget = null;
                return;
            }

            const copy = confirmationCopy[button.id];
            if (!copy) return;

            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();
            pendingTarget = button;
            title.textContent = copy.title;
            description.textContent = copy.description;
            acceptButton.textContent = copy.confirmLabel;
            dialog.showModal();
            cancelButton.focus();
        }, true);

        const closeDialog = () => {
            pendingTarget = null;
            if (dialog.open) dialog.close();
        };

        cancelButton.addEventListener('click', closeDialog);
        dialog.addEventListener('cancel', (event) => {
            event.preventDefault();
            closeDialog();
        });
        dialog.addEventListener('click', (event) => {
            if (event.target === dialog) closeDialog();
        });

        acceptButton.addEventListener('click', () => {
            const target = pendingTarget;
            if (!target) return closeDialog();

            pendingTarget = null;
            dialog.close();
            confirmedTarget = target;
            bypassNextNativeConfirm = true;
            target.click();
            window.setTimeout(() => {
                confirmedTarget = null;
                bypassNextNativeConfirm = false;
            }, 0);
        });
    }

    function installPromptItemActions() {
        const container = document.getElementById('prompts-container');
        if (!container) return;

        container.addEventListener('click', (event) => {
            const pasteBtn = event.target.closest('.btn-prompt-paste');
            if (pasteBtn) {
                event.preventDefault();
                event.stopPropagation();

                const item = pasteBtn.closest('.prompt-item');
                const textEl = item ? item.querySelector('.prompt-text') : null;
                const text = textEl ? textEl.textContent.trim() : '';
                if (!text) return;

                chrome.tabs.query({ url: ['*://*.dola.com/*', '*://dola.com/*'] }, (tabs) => {
                    const dolaTabs = (tabs || []).filter(t => (t.url || '').toLowerCase().includes('/chat') && !t.url.includes('.js') && !t.url.includes('worker'));
                    const targetTabs = dolaTabs.length > 0 ? dolaTabs : (tabs || []).filter(t => !t.url.includes('.js'));
                    targetTabs.sort((a, b) => {
                        if (a.active !== b.active) return b.active ? -1 : 1;
                        return (b.lastAccessed || 0) - (a.lastAccessed || 0);
                    });
                    const targetTab = targetTabs[0];
                    if (targetTab && targetTab.id) {
                        const radDist = document.getElementById('radio-mode-distributed');
                        const selDuration = document.getElementById('sel-prompt-duration');
                        const isCredit = (radDist && radDist.checked) || (selDuration && selDuration.value === '30s');
                        const selAspect = document.getElementById('sel-aspect-ratio');
                        const config = {
                            mode: isCredit ? 'credit_video' : 'single',
                            duration: isCredit ? '30s' : (selDuration?.value || '15s'),
                            aspectRatio: selAspect?.value || '16:9'
                        };
                        chrome.tabs.sendMessage(targetTab.id, {
                            action: 'paste_specific_prompt',
                            text: text,
                            config: config,
                            autoSubmit: true
                        }, () => {
                            if (chrome.runtime.lastError) {
                                if (chrome.scripting && chrome.scripting.executeScript) {
                                    chrome.scripting.executeScript({
                                        target: { tabId: tabs[0].id },
                                        func: (t) => {
                                            const el = document.querySelector('textarea, div[contenteditable=true], [role=textbox], input[type=text]');
                                            if (!el) return;
                                            el.focus();
                                            if (el.isContentEditable || el.getAttribute('contenteditable') === 'true') {
                                                el.innerHTML = '';
                                                try {
                                                    document.execCommand('selectAll', false, null);
                                                    document.execCommand('insertText', false, t);
                                                } catch (e) {}
                                                if (!el.textContent || !el.textContent.trim()) {
                                                    el.innerText = t;
                                                    el.textContent = t;
                                                }
                                                el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: t }));
                                                el.dispatchEvent(new Event('input', { bubbles: true }));
                                                el.dispatchEvent(new Event('change', { bubbles: true }));
                                            } else {
                                                const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
                                                const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
                                                if (setter) setter.call(el, t); else el.value = t;
                                                el.dispatchEvent(new Event('input', { bubbles: true }));
                                                el.dispatchEvent(new Event('change', { bubbles: true }));
                                            }
                                        },
                                        args: [text]
                                    }).catch(() => {});
                                }
                            }
                        });
                    }
                });
            }
        });
    }

    function updateHeroBtnSubtitle(isCredit) {
        const heroSubtitle = document.getElementById('hero-btn-subtitle');
        if (!heroSubtitle) return;
        if (isCredit) {
            heroSubtitle.textContent = '1 video / nick · Thời lượng 30s (Credit)';
        } else {
            heroSubtitle.textContent = 'Tối đa 2 video / nick · Tự động chia đều các Nick';
        }
    }

    function initializeGeneratorControls() {
        const radSingle = document.getElementById('radio-mode-single');
        const radDist = document.getElementById('radio-mode-distributed');
        const inputPrefix = document.getElementById('input-prompt-prefix');
        const selModel = document.getElementById('sel-model-version');
        const selAspect = document.getElementById('sel-aspect-ratio');
        const selDuration = document.getElementById('sel-prompt-duration');
        const chkDirect = document.getElementById('chk-direct-create');

        if (!radSingle || !inputPrefix || !selAspect) return;

        const syncModeToDolaTabs = (mode) => {
            if (typeof chrome === 'undefined' || !chrome.tabs) return;
            const selDuration = document.getElementById('sel-prompt-duration');
            const selAspect = document.getElementById('sel-aspect-ratio');
            const duration = mode === 'credit_video' ? '30s' : (selDuration?.value || '15s');
            const aspectRatio = selAspect?.value || '16:9';

            chrome.tabs.query({}, (tabs) => {
                if (!tabs || !tabs.length) return;
                const dolaTabs = tabs.filter(t => {
                    const u = (t.url || '').toLowerCase();
                    return (u.includes('dola.com') || u.includes('doubao.com')) && !u.includes('.js');
                });
                dolaTabs.forEach((tab) => {
                    if (tab.id) {
                        chrome.tabs.sendMessage(tab.id, {
                            action: 'SET_DOLA_GENERATION_MODE',
                            mode,
                            duration,
                            aspectRatio
                        }, () => {
                            if (chrome.runtime.lastError) {}
                        });
                    }
                });
            });
        };

        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
            chrome.storage.local.get(['sr_gen_mode', 'sr_prompt_prefix', 'sr_model_version', 'sr_aspect_ratio', 'sr_prompt_duration', 'sr_direct_create'], (res) => {
                const isCredit = res?.sr_gen_mode === 'distributed' || res?.sr_prompt_duration === '30s';
                if (isCredit) {
                    if (radDist) radDist.checked = true;
                    if (radSingle) radSingle.checked = false;
                } else {
                    if (radSingle) radSingle.checked = true;
                    if (radDist) radDist.checked = false;
                }
                updateHeroBtnSubtitle(isCredit);

                if (res?.sr_prompt_prefix !== undefined && inputPrefix) {
                    inputPrefix.value = res.sr_prompt_prefix;
                }
                if (selModel) {
                    selModel.value = res?.sr_model_version || (isCredit ? '2.0' : '2.5');
                }
                if (res?.sr_aspect_ratio && selAspect) {
                    selAspect.value = res.sr_aspect_ratio;
                }
                if (res?.sr_prompt_duration && selDuration) {
                    selDuration.value = res.sr_prompt_duration;
                }
                if (res?.sr_direct_create !== undefined && chkDirect) {
                    chkDirect.checked = Boolean(res.sr_direct_create);
                }
            });
        }

        // 2. Persist parameters on change
        const saveParams = () => {
            if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return;
            const config = {
                sr_gen_mode: radDist && radDist.checked ? 'distributed' : 'single',
                sr_prompt_prefix: inputPrefix ? inputPrefix.value : 'tạo video: ',
                sr_model_version: selModel ? selModel.value : (radDist && radDist.checked ? '2.0' : '2.5'),
                sr_aspect_ratio: selAspect ? selAspect.value : '16:9',
                sr_prompt_duration: selDuration ? selDuration.value : '15s',
                sr_direct_create: chkDirect ? chkDirect.checked : true
            };
            chrome.storage.local.set(config);
        };

        const triggerProMode = () => {
            if (radSingle) radSingle.checked = true;
            if (radDist) radDist.checked = false;
            if (selDuration && selDuration.value === '30s') {
                selDuration.value = '15s';
            }
            if (selModel) selModel.value = '2.5';
            updateHeroBtnSubtitle(false);
            saveParams();
            syncModeToDolaTabs('pro');
            if (typeof window.showGlobalToast === 'function') {
                window.showGlobalToast('🔄 Đã chọn Chế độ Pro: Dola tự chuyển sang Pro Chat (2 video/chat sau 30s)');
            }
        };

        const triggerCreditMode = () => {
            if (radDist) radDist.checked = true;
            if (radSingle) radSingle.checked = false;
            if (selDuration) selDuration.value = '30s';
            if (selModel) selModel.value = '2.0';
            updateHeroBtnSubtitle(true);
            saveParams();
            syncModeToDolaTabs('credit_video');
            if (typeof window.showGlobalToast === 'function') {
                window.showGlobalToast('⚡ Đã chọn Chế độ Create Video: Dola tự chuyển sang Tạo video 30s (Credit)');
            }
        };

        let modeSwitchDebounceTimer = null;
        const debouncedTriggerMode = (mode) => {
            clearTimeout(modeSwitchDebounceTimer);
            modeSwitchDebounceTimer = setTimeout(() => {
                if (mode === 'credit_video') {
                    triggerCreditMode();
                } else {
                    triggerProMode();
                }
            }, 60);
        };

        if (radSingle) {
            radSingle.addEventListener('change', () => {
                if (radSingle.checked) debouncedTriggerMode('pro');
            });
            const lbl = radSingle.closest('.mode-radio-card');
            if (lbl) {
                lbl.addEventListener('click', (e) => {
                    if (e.target !== radSingle) {
                        radSingle.checked = true;
                        debouncedTriggerMode('pro');
                    }
                });
            }
        }
        if (radDist) {
            radDist.addEventListener('change', () => {
                if (radDist.checked) debouncedTriggerMode('credit_video');
            });
            const lbl = radDist.closest('.mode-radio-card');
            if (lbl) {
                lbl.addEventListener('click', (e) => {
                    if (e.target !== radDist) {
                        radDist.checked = true;
                        debouncedTriggerMode('credit_video');
                    }
                });
            }
        }
        if (inputPrefix) inputPrefix.addEventListener('input', saveParams);
        if (selModel) {
            selModel.addEventListener('change', () => {
                saveParams();
                if (selModel.value === '2.5') {
                    syncModeToDolaTabs('pro');
                } else if (selModel.value === '2.0') {
                    syncModeToDolaTabs('nhanh');
                }
            });
        }
        if (selAspect) {
            selAspect.addEventListener('change', () => {
                saveParams();
                const radDist = document.getElementById('radio-mode-distributed');
                const selDuration = document.getElementById('sel-prompt-duration');
                const isCredit = (radDist && radDist.checked) || (selDuration && selDuration.value === '30s');
                syncModeToDolaTabs(isCredit ? 'credit_video' : 'pro');
                if (typeof window.showGlobalToast === 'function') {
                    window.showGlobalToast(`📐 Đã đồng bộ tỉ lệ ${selAspect.value} sang Dola!`);
                }
            });
        }
        if (selDuration) {
            selDuration.addEventListener('change', () => {
                if (selDuration.value === '30s') {
                    triggerCreditMode();
                } else {
                    saveParams();
                }
            });
        }
        if (chkDirect) chkDirect.addEventListener('change', saveParams);

        // Kiểm tra xem hôm nay tài khoản đã đạt giới hạn hằng ngày chưa
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
            chrome.storage.local.get(['sr_daily_limit_date'], (res) => {
                const today = new Date().toDateString();
                const limitBanner = document.getElementById('daily-limit-warning-banner');
                if (limitBanner) {
                    limitBanner.style.display = res?.sr_daily_limit_date === today ? 'block' : 'none';
                }
            });
        }

        // 3. Scan & Display GPM / Dola Tabs Status with live Ping & F5 Warning
        function showDolaF5Warning(show, tabId = null) {
            const container = document.getElementById('dola-f5-warning-container');
            const btnF5 = document.getElementById('btn-f5-dola-tabs');
            if (!container) return;
            container.style.display = show ? 'block' : 'none';

            if (btnF5 && !btnF5.__sr_bound) {
                btnF5.__sr_bound = true;
                btnF5.addEventListener('click', () => {
                    chrome.tabs.query({ url: ['*://*.dola.com/*', '*://dola.com/*'] }, (tabs) => {
                        const chatTabs = (tabs || []).filter((t) => !(t.url || '').includes('.js'));
                        if (chatTabs.length > 0) {
                            chatTabs.forEach(t => chrome.tabs.reload(t.id));
                            btnF5.textContent = '🔄 Đang tải lại tab Dola...';
                            setTimeout(() => {
                                btnF5.textContent = '🔄 F5 Tab Dola Ngay';
                                updateGpmBadge();
                            }, 2500);
                        }
                    });
                });
            }
        }

        function updateGpmBadge() {
            if (typeof chrome === 'undefined' || !chrome.tabs) return;
            chrome.tabs.query({ url: ['*://*.dola.com/*', '*://dola.com/*'] }, (tabs) => {
                const badge = document.getElementById('gpm-active-tabs-badge');
                const txt = document.getElementById('gpm-tabs-text');
                if (!badge || !txt) return;

                const chatTabs = (tabs || []).filter((t) => {
                    const u = (t.url || '').toLowerCase();
                    return u.includes('/chat') && !u.includes('.js') && !u.includes('worker');
                });
                const activeTabs = chatTabs.length > 0 ? chatTabs : (tabs || []).filter((t) => !(t.url || '').includes('.js'));

                if (activeTabs.length === 0) {
                    badge.className = 'gpm-tab-indicator warning';
                    txt.textContent = '⚠️ Chưa mở Tab Dola nào';
                    showDolaF5Warning(false);
                    return;
                }

                // Gửi ping kiểm tra xem content script có đang phản hồi không
                const targetTab = activeTabs[0];
                chrome.tabs.sendMessage(targetTab.id, { action: 'ping' }, (res) => {
                    if (chrome.runtime.lastError || !res?.pong) {
                        badge.className = 'gpm-tab-indicator warning';
                        txt.textContent = '⚠️ Tab Dola chưa F5! Bấm để tải lại';
                        showDolaF5Warning(true, targetTab.id);
                    } else {
                        badge.className = 'gpm-tab-indicator';
                        let profileHint = '';
                        for (const t of activeTabs) {
                            const m = (t.title || '').match(/GPM\s*\|\s*([^·\s|@]+@[^·\s|]+|[^·\s|]+)/i);
                            if (m && m[1]) {
                                profileHint = ` (${m[1].split('@')[0]})`;
                                break;
                            }
                        }
                        txt.textContent = `🟢 ${activeTabs.length} Tab Dola sẵn sàng${profileHint}`;
                        showDolaF5Warning(false);
                    }
                });
            });
        }

        updateGpmBadge();
        setInterval(updateGpmBadge, 3500);

        // 4. Listen for real-time progress from content script
        if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
            chrome.runtime.onMessage.addListener((msg) => {
                if (!msg) return;
                const btnHitCreate = document.getElementById('btn-hit-create-video');
                const heroSubtitle = document.getElementById('hero-btn-subtitle');
                if (msg.action === 'BATCH_PROGRESS' && btnHitCreate) {
                    const label = btnHitCreate.querySelector('strong');
                    if (label) {
                        label.textContent = `⚡ Đang chạy: ${msg.current}/${msg.total} cảnh`;
                    }
                    if (heroSubtitle) {
                        const isCredit = msg.isCreditMode || msg.chatCount === 1;
                        if (isCredit) {
                            heroSubtitle.textContent = `⚡ Chế độ Create Video: Cảnh ${msg.current}/${msg.total} (Thời lượng 30s)`;
                        } else {
                            heroSubtitle.textContent = `Phiên chat: ${msg.chatCount}/2 prompt · Đang render...`;
                        }
                    }
                }
                if (msg.action === 'NOTIFY_HUMAN_ARTIFACT' && heroSubtitle) {
                    heroSubtitle.textContent = '✨ Đã phát hiện Human Artifact video!';
                }
                if (msg.action === 'DAILY_LIMIT_EXCEEDED') {
                    const limitBanner = document.getElementById('daily-limit-warning-banner');
                    if (limitBanner) limitBanner.style.display = 'block';
                    if (btnHitCreate) {
                        btnHitCreate.disabled = false;
                        btnHitCreate.__sr_busy = false;
                        const label = btnHitCreate.querySelector('strong');
                        if (label) label.textContent = '⚡ BẮN SANG DOLA (CHẠY TỰ ĐỘNG)';
                    }
                    if (heroSubtitle) {
                        heroSubtitle.textContent = 'Đã dừng: hết hạn mức tạo video hôm nay';
                    }
                    if (typeof window.showGlobalToast === 'function') {
                        window.showGlobalToast('Đã dừng: Dola báo hết hạn mức tạo video hôm nay.');
                    }
                }
            });
        }
    }

    function initializeHitCreateVideoButton() {
        const btnHitCreate = document.getElementById('btn-hit-create-video');
        if (!btnHitCreate || btnHitCreate.__sr_bound) return;
        btnHitCreate.__sr_bound = true;

        btnHitCreate.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();

            if (typeof chrome === 'undefined' || !chrome.tabs) return;
            if (btnHitCreate.disabled || btnHitCreate.__sr_busy) return;

            const STORAGE_KEY = 'ctb_saved_prompts';
            const textarea = document.getElementById('textarea-quick-prompts');
            const immediateText = textarea ? textarea.value.trim() : '';

            // 1. Collect Config Options
            const radSingle = document.getElementById('radio-mode-single');
            const radDist = document.getElementById('radio-mode-distributed');
            const inputPrefix = document.getElementById('input-prompt-prefix');
            const selAspect = document.getElementById('sel-aspect-ratio');
            const selDuration = document.getElementById('sel-prompt-duration');
            const selModel = document.getElementById('sel-model-version');
            const chkDirect = document.getElementById('chk-direct-create');
            const heroSubtitle = document.getElementById('hero-btn-subtitle');

            let isCreditVideo = !!(radDist && radDist.checked);
            if (!isCreditVideo && selDuration && selDuration.value === '30s') {
                // 30s chỉ hợp lệ ở Create Video Credit — tránh Pro + dropdown 30s gây hiểu nhầm.
                if (typeof window.showGlobalToast === 'function') {
                    window.showGlobalToast('⚠️ 30s chỉ chạy ở Chế độ Create Video (Credit). Đang chuyển sang Credit…');
                }
                if (radDist) radDist.checked = true;
                if (radSingle) radSingle.checked = false;
            }
            isCreditVideo = !!(radDist && radDist.checked);
            if (isCreditVideo) {
                if (radDist) radDist.checked = true;
                if (radSingle) radSingle.checked = false;
                if (selDuration) selDuration.value = '30s';
                if (selModel) selModel.value = '2.0';
                updateHeroBtnSubtitle(true);
            }
            const model = selModel ? selModel.value : (isCreditVideo ? '2.0' : '2.5');
            const prefix = inputPrefix ? inputPrefix.value : 'tạo video: ';
            const aspectRatio = selAspect ? selAspect.value : '16:9';
            const duration = isCreditVideo ? '30s' : (selDuration?.value || '15s');
            const directCreate = chkDirect ? chkDirect.checked : true;

            const config = {
                prefix,
                aspectRatio,
                duration,
                directCreate,
                model: isCreditVideo ? 'credit' : model,
                mode: isCreditVideo ? 'credit_video' : 'single',
                isUnlimited: !isCreditVideo
            };

            // 2. Fetch Prompts (from textarea or saved queue)
            chrome.storage.local.get([STORAGE_KEY], (res) => {
                const saved = Array.isArray(res?.[STORAGE_KEY]) ? res[STORAGE_KEY] : [];
                let promptList = [];

                if (immediateText) {
                    if (window.CTBParagraphPrompts && typeof window.CTBParagraphPrompts.parseParagraphs === 'function') {
                        promptList = window.CTBParagraphPrompts.parseParagraphs(immediateText);
                    } else {
                        promptList = immediateText.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
                    }
                }

                if (promptList.length === 0) {
                    const uncompleted = saved.filter(p => !p.done);
                    if (uncompleted.length > 0) {
                        promptList = uncompleted.map(p => p.text);
                    } else if (saved.length > 0) {
                        promptList = saved.map(p => p.text);
                    }
                }

                if (promptList.length === 0) {
                    const label = btnHitCreate.querySelector('strong');
                    if (label) {
                        const orig = label.textContent;
                        label.textContent = '⚠️ Hãy nhập hoặc nạp kịch bản!';
                        setTimeout(() => { label.textContent = orig; }, 2500);
                    }
                    return;
                }

                // 3. Query all active Dola tabs
                chrome.tabs.query({ url: ['*://*.dola.com/*', '*://dola.com/*', '*://*.doubao.com/*', '*://doubao.com/*'] }, (tabs) => {
                    const chatTabs = (tabs || []).filter((t) => {
                        const u = (t.url || '').toLowerCase();
                        return u.includes('/chat') && !u.includes('.js') && !u.includes('worker');
                    });
                    const activeTabs = chatTabs.length > 0 ? chatTabs : (tabs || []).filter((t) => !(t.url || '').includes('.js'));

                    // Lọc tab duy nhất theo id tránh trùng lặp
                    const uniqueTabs = [];
                    const seenIds = new Set();
                    for (const t of activeTabs) {
                        if (t && t.id && !seenIds.has(t.id)) {
                            seenIds.add(t.id);
                            uniqueTabs.push(t);
                        }
                    }

                    // Sắp xếp tab: Tab đang active hoặc tab được truy cập gần đây nhất luôn đứng đầu tiên (primaryTab)
                    // Đảm bảo tạo video LUÔN CHẠY TRÊN TAB/CHAT HIỆN TẠI mà người dùng đang mở, không nhảy về chat cũ!
                    uniqueTabs.sort((a, b) => {
                        if (a.active !== b.active) return b.active ? -1 : 1;
                        return (b.lastAccessed || 0) - (a.lastAccessed || 0);
                    });

                    if (uniqueTabs.length === 0) {
                        const label = btnHitCreate.querySelector('strong');
                        if (label) {
                            const orig = label.textContent;
                            label.textContent = '❌ Chưa mở Tab Dola Chat nào!';
                            setTimeout(() => { label.textContent = orig; }, 2500);
                        }
                        if (typeof window.showGlobalToast === 'function') {
                            window.showGlobalToast('❌ Chưa mở Tab Dola Chat nào!');
                        }
                        return;
                    }

                    // 4. KIỂM TRA PING TAB TRƯỚC KHI GỬI
                    const primaryTab = uniqueTabs[0];
                    chrome.tabs.sendMessage(primaryTab.id, { action: 'ping' }, (pingResp) => {
                        const label = btnHitCreate.querySelector('strong');
                        if (chrome.runtime.lastError || !pingResp?.pong) {
                            // CẢNH BÁO TAB DOLA CHƯA F5
                            const container = document.getElementById('dola-f5-warning-container');
                            if (container) container.style.display = 'block';
                            if (label) {
                                label.textContent = '⚠️ Tab Dola chưa nhận extension! Bấm nút F5 đỏ ở trên nhé.';
                            }
                            if (typeof window.showGlobalToast === 'function') {
                                window.showGlobalToast('⚠️ Tab Dola chưa nhận extension! Bấm nút F5 đỏ ở trên nhé.');
                            }
                            return;
                        }

                        // 5. NẾU TAB ĐÃ SẴN SÀNG -> TIẾN HÀNH PHÂN PHỐI PROMPTS
                        btnHitCreate.disabled = true;
                        btnHitCreate.__sr_busy = true;

                        // Kích hoạt tab Dola lên phía trước để người dùng thấy ngay tiến trình chạy
                        try {
                            if (primaryTab.windowId) {
                                chrome.windows.update(primaryTab.windowId, { focused: true });
                            }
                            chrome.tabs.update(primaryTab.id, { active: true });
                        } catch (e) {}

                        if (typeof window.showGlobalToast === 'function') {
                            window.showGlobalToast(`🚀 Đã bắn ${promptList.length} cảnh sang Dola! Đang tự động tạo...`);
                        }

                        // Phân phối prompt:
                        // 1. Chế độ Create Video (Credit 30s): Mỗi tab/acc nhận ĐÚNG 1 PROMPT (1 video 30s)
                        // 2. Chế độ Pro Model: Cụm tối đa 2 prompt/phiên chat
                        const tabBuckets = Array.from({ length: uniqueTabs.length }, () => []);

                        if (isCreditVideo) {
                            // Chế độ Create Video: Mỗi acc nhận 1 prompt (30s)
                            promptList.forEach((p, pIdx) => {
                                const bucketIdx = pIdx % uniqueTabs.length;
                                tabBuckets[bucketIdx].push(p);
                            });
                        } else {
                            // Chế độ Pro: cụm tối đa 2 prompt / phiên chat
                            for (let i = 0; i < promptList.length; i += 2) {
                                const chunk = promptList.slice(i, i + 2);
                                const bucketIdx = Math.floor(i / 2) % uniqueTabs.length;
                                tabBuckets[bucketIdx].push(...chunk);
                            }
                        }

                        let tabDispatches = 0;
                        uniqueTabs.forEach((tab, tabIdx) => {
                            const tabPrompts = tabBuckets[tabIdx];
                            if (tabPrompts && tabPrompts.length > 0) {
                                tabDispatches++;
                                const sendBatch = () => {
                                    chrome.tabs.sendMessage(tab.id, {
                                        action: 'execute_batch_prompt_session',
                                        prompts: tabPrompts,
                                        config
                                    }, (resp) => {
                                        if (chrome.runtime.lastError) {
                                            console.warn(`[Seedance Studio Pro] Send to Tab ${tab.id} error:`, chrome.runtime.lastError);
                                            if (typeof window.showGlobalToast === 'function') {
                                                window.showGlobalToast('⚠️ Lỗi gửi sang Tab Dola: ' + (chrome.runtime.lastError.message || 'Tab chưa sẵn sàng'));
                                            }
                                        } else if (resp && resp.success === false) {
                                            if (typeof window.showGlobalToast === 'function') {
                                                window.showGlobalToast('⚠️ Dola phản hồi: ' + (resp.reason || resp.error || 'Chưa thể tạo'));
                                            }
                                        }
                                    });
                                };

                                if (isCreditVideo) {
                                    chrome.runtime.sendMessage({
                                        action: 'apply_create_video_settings',
                                        tabId: tab.id,
                                        duration: duration || '30s',
                                        aspectRatio
                                    }, (resp) => {
                                        if (!resp || resp.success !== true) {
                                            const err = (resp && resp.error) || 'Chưa chọn được Duration 30s trên Dola.';
                                            if (typeof window.showGlobalToast === 'function') {
                                                window.showGlobalToast('⚠️ ' + err);
                                            }
                                            if (label) {
                                                label.textContent = '⚠️ Chưa khóa được 30s — F5 Dola';
                                                setTimeout(() => {
                                                    label.textContent = '⚡ BẮN SANG DOLA (CHẠY TỰ ĐỘNG)';
                                                }, 4000);
                                            }
                                            btnHitCreate.disabled = false;
                                            btnHitCreate.__sr_busy = false;
                                            return;
                                        }
                                        if (typeof window.showGlobalToast === 'function') {
                                            window.showGlobalToast(`✅ Dola: ${resp.appliedDuration || '30s'} · ${resp.appliedRatio || aspectRatio}`);
                                        }
                                        setTimeout(sendBatch, 450);
                                        // Sau khi gửi, kiểm tra interceptor có vá duration=30 không
                                        setTimeout(() => {
                                            chrome.storage.local.get(['sr_last_ability_patch'], (st) => {
                                                const patch = st?.sr_last_ability_patch;
                                                const age = patch?.at ? (Date.now() - patch.at) : 999999;
                                                if (patch && age < 20000 && Number(patch?.ability?.duration) === 30) {
                                                    if (typeof window.showGlobalToast === 'function') {
                                                        window.showGlobalToast('🔒 API đã gửi duration=30 (Create Video)');
                                                    }
                                                } else if (typeof window.showGlobalToast === 'function') {
                                                    window.showGlobalToast('⚠️ Chưa thấy patch duration=30 trên API — bật Debugger ON rồi F5 Dola');
                                                }
                                            });
                                        }, 3500);
                                    });
                                } else {
                                    sendBatch();
                                }
                            }
                        });

                        if (label) {
                            if (isCreditVideo) {
                                label.textContent = `⚡ Create Video (Credit 30s): Đang chạy ${promptList.length} cảnh trên ${tabDispatches} Nick (1 video 30s/nick)...`;
                            } else if (uniqueTabs.length === 1 && promptList.length > 2) {
                                label.textContent = `⚡ 1 Nick (${promptList.length} cảnh): Cứ 30s sẽ mở Chat mới gửi tiếp!`;
                            } else {
                                label.textContent = `⚡ Đang chạy ${promptList.length} cảnh trên ${tabDispatches} Nick (2 video/nick)...`;
                            }
                        }

                        if (heroSubtitle) {
                            if (isCreditVideo) {
                                heroSubtitle.textContent = `Chế độ Create Video: 1 video 30s/nick (tính Credit) · Tự động tải 1080P Master`;
                            } else if (uniqueTabs.length === 1 && promptList.length > 2) {
                                heroSubtitle.textContent = `Chế độ Pro: Cứ 30s tạo Chat mới đẩy 2 cảnh → Tối đa ~10 video Pro/ngày`;
                            } else {
                                heroSubtitle.textContent = `Mỗi nick chạy tối đa 2 video song song · Tự động tải 1080P sạch logo`;
                            }
                        }

                        setTimeout(() => {
                            btnHitCreate.disabled = false;
                            btnHitCreate.__sr_busy = false;
                            if (label) {
                                label.textContent = '⚡ BẮN SANG DOLA (CHẠY TỰ ĐỘNG)';
                            }
                            if (heroSubtitle) {
                                if (isCreditVideo) {
                                    heroSubtitle.textContent = '1 video / nick · Thời lượng 30s (Credit)';
                                } else {
                                    heroSubtitle.textContent = 'Tối đa 2 video / nick · Tự động chia đều các Nick';
                                }
                            }
                        }, 5000);

                        if (saved.length > 0) {
                            saved.forEach(p => { p.done = true; });
                            chrome.storage.local.set({ [STORAGE_KEY]: saved });
                        }
                    });
                });
            });
        });
    }

    function initializeStopAutomationButton() {
        const btnStop = document.getElementById('btn-stop-automation');
        if (!btnStop || btnStop.__sr_bound) return;
        btnStop.__sr_bound = true;

        btnStop.addEventListener('click', (e) => {
            e.preventDefault();
            if (typeof chrome === 'undefined' || !chrome.tabs) return;

            // 1. Gửi tín hiệu abort_batch_session tới toàn bộ các Tab Dola đang mở
            chrome.tabs.query({}, (tabs) => {
                const dolaTabs = (tabs || []).filter(t => {
                    const u = (t.url || '').toLowerCase();
                    return (u.includes('dola.com') || u.includes('doubao.com')) && !u.includes('.js');
                });
                dolaTabs.forEach(tab => {
                    if (tab.id) {
                        chrome.tabs.sendMessage(tab.id, { action: 'abort_batch_session' }, () => {
                            if (chrome.runtime.lastError) {}
                        });
                    }
                });
            });

            // 2. Mở khóa lại nút Start Bắn sang Dola
            const btnHitCreate = document.getElementById('btn-hit-create-video');
            if (btnHitCreate) {
                btnHitCreate.disabled = false;
                btnHitCreate.__sr_busy = false;
                const label = btnHitCreate.querySelector('strong');
                if (label) label.textContent = '⚡ BẮN SANG DOLA (CHẠY TỰ ĐỘNG)';
            }

            if (typeof window.showGlobalToast === 'function') {
                window.showGlobalToast('🛑 Đã gửi lệnh DỪNG (STOP) tới toàn bộ các Tab Dola!');
            }
        });
    }

    function initializeSettingsControls() {
        const selDuration = document.getElementById('sel-duration');
        const chkAutoRotate = document.getElementById('chk-autorotate');
        const chkAutoNext = document.getElementById('chk-autonext');
        const chkAutoDownload = document.getElementById('chk-autodownload');

        if (!selDuration) return;

        // 1. Load saved settings from chrome.storage.local
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
            chrome.storage.local.get(['durationOverride', 'autoRotate', 'autoNext', 'autoDownload'], (res) => {
                const dur = res?.durationOverride || '30';
                selDuration.value = dur;
                if (chkAutoRotate && res?.autoRotate !== undefined) chkAutoRotate.checked = Boolean(res.autoRotate);
                if (chkAutoNext && res?.autoNext !== undefined) chkAutoNext.checked = Boolean(res.autoNext);
                if (chkAutoDownload && res?.autoDownload !== undefined) chkAutoDownload.checked = Boolean(res.autoDownload);
            });
        }

        // 2. Listen to duration dropdown changes
        selDuration.addEventListener('change', () => {
            const val = selDuration.value;
            if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
                chrome.storage.local.set({ durationOverride: val }, () => {
                    console.log('[StudioRelay Settings] Saved durationOverride:', val);
                    chrome.tabs.query({ url: ['*://*.dola.com/*', '*://dola.com/*'] }, (tabs) => {
                        tabs.forEach((tab) => {
                            if (tab.id) {
                                chrome.tabs.sendMessage(tab.id, { action: 'set_duration', duration: val }).catch(() => {});
                            }
                        });
                    });
                });
            }
        });

        // 3. Listen to checkbox toggles
        if (chkAutoRotate) {
            chkAutoRotate.addEventListener('change', () => {
                chrome.storage.local.set({ autoRotate: chkAutoRotate.checked });
            });
        }
        if (chkAutoNext) {
            chkAutoNext.addEventListener('change', () => {
                chrome.storage.local.set({ autoNext: chkAutoNext.checked });
            });
        }
        if (chkAutoDownload) {
            chkAutoDownload.addEventListener('change', () => {
                chrome.storage.local.set({ autoDownload: chkAutoDownload.checked });
            });
        }
    }

    // =========================================================================
    // MULTI-ACCOUNT MANAGEMENT UI (Lưu tab, Nạp cookie, Mở tab song song)
    // =========================================================================
    function initializeAccountsManagement() {
        const accountsCounter = document.getElementById('accounts-counter');
        const profilesContainer = document.getElementById('profiles-container');
        const btnCapture = document.getElementById('btn-capture-session');
        const btnImport = document.getElementById('btn-import-profile');
        const btnUploadTrigger = document.getElementById('btn-trigger-upload-accounts');
        const fileInput = document.getElementById('file-upload-accounts');
        const btnClearAll = document.getElementById('btn-clear-all-accounts');
        const inputName = document.getElementById('input-profile-name');
        const inputCookies = document.getElementById('input-profile-cookies');

        function showAccountToast(msg, duration = 3000) {
            const statusEl = document.getElementById('bulk-account-open-status');
            if (statusEl) {
                statusEl.textContent = msg;
            }
            if (typeof window.showGlobalToast === 'function') {
                window.showGlobalToast(msg, duration);
            }
        }

        function renderProfilesList() {
            if (!profilesContainer) return;
            chrome.storage.local.get(['multi_profiles'], (res) => {
                const profiles = res?.multi_profiles || {};
                const names = Object.keys(profiles);

                if (accountsCounter) {
                    accountsCounter.textContent = String(names.length);
                }

                if (names.length === 0) {
                    profilesContainer.innerHTML = `
                        <div class="empty-state-card">
                            <div class="empty-state-icon">👥</div>
                            <div class="empty-state-text">
                                <strong>Chưa có tài khoản nào được lưu</strong>
                                <small>Đăng nhập Dola rồi bấm "💾 Lưu Tab Này" để lưu nick đầu tiên nhé!</small>
                            </div>
                        </div>
                    `;
                    return;
                }

                profilesContainer.innerHTML = '';
                names.forEach((name, idx) => {
                    const prof = profiles[name] || {};
                    const color = prof.color || '#6366f1';
                    const cookieCount = Array.isArray(prof.cookies) ? prof.cookies.length : 0;

                    const card = document.createElement('div');
                    card.className = 'profile-card studio-card';
                    card.dataset.name = name;
                    card.style.cssText = `
                        border-left: 4px solid ${color};
                        margin-bottom: 8px;
                        padding: 10px 14px;
                        display: flex;
                        justify-content: space-between;
                        align-items: center;
                        background: rgba(30, 41, 59, 0.7);
                        border-radius: 8px;
                    `;

                    card.innerHTML = `
                        <div class="profile-info-col" style="display: flex; flex-direction: column; gap: 3px;">
                            <div class="profile-name-row" style="display: flex; align-items: center; gap: 8px;">
                                <span style="width: 10px; height: 10px; border-radius: 50%; background: ${color}; display: inline-block;"></span>
                                <strong class="profile-name-text" style="color: #f8fafc; font-size: 13px;">${name}</strong>
                            </div>
                            <small style="color: #94a3b8; font-size: 11px;">${cookieCount} cookies · Tab cô lập declarativeNetRequest</small>
                        </div>
                        <div class="profile-actions-row" style="display: flex; gap: 8px;">
                            <button class="btn-pill-primary btn-open-profile-tab" data-name="${name}" type="button" style="padding: 5px 12px; font-size: 11px;" title="Mở Tab Dola độc lập với tài khoản này">⚡ Mở Tab</button>
                            <button class="btn-pill-danger btn-delete-profile" data-name="${name}" type="button" style="padding: 5px 10px; font-size: 11px;" title="Xóa tài khoản này">🗑️</button>
                        </div>
                    `;

                    // Event: Mở Tab riêng cho nick này
                    const btnOpen = card.querySelector('.btn-open-profile-tab');
                    if (btnOpen) {
                        btnOpen.addEventListener('click', () => {
                            btnOpen.disabled = true;
                            btnOpen.textContent = '⏳ Đang mở…';
                            chrome.runtime.sendMessage({ action: 'open_account_in_new_tab', profileName: name }, (resp) => {
                                btnOpen.disabled = false;
                                btnOpen.textContent = '⚡ Mở Tab';
                                if (resp && resp.success) {
                                    showAccountToast(`🚀 Đã mở Tab Dola riêng cho nick ${name}!`);
                                } else {
                                    showAccountToast(`⚠️ ${resp?.error || 'Không mở được tab nick'}`);
                                }
                            });
                        });
                    }

                    // Event: Xóa nick
                    const btnDelete = card.querySelector('.btn-delete-profile');
                    if (btnDelete) {
                        btnDelete.addEventListener('click', () => {
                            chrome.runtime.sendMessage({ action: 'delete_account_profile', profileName: name }, (resp) => {
                                renderProfilesList();
                                showAccountToast(`🗑️ Đã xóa nick ${name}!`);
                            });
                        });
                    }

                    profilesContainer.appendChild(card);
                });
            });
        }

        // 1. Lưu Tab Hiện Tại (Capture Session)
        // Chặn triệt để alert lỗi "Could not capture cookies from this tab" từ code cũ trong popup.js
        try {
            const _origAlert = window.alert;
            window.alert = function (msg) {
                if (typeof msg === 'string' && (msg.includes('Could not capture cookies') || msg.includes('Could not capture'))) {
                    console.log('[Seedance Studio Pro] Suppressed legacy alert:', msg);
                    return;
                }
                return _origAlert ? _origAlert.apply(this, arguments) : undefined;
            };
        } catch (e) {}

        if (btnCapture) {
            btnCapture.addEventListener('click', (e) => {
                if (e) {
                    e.stopImmediatePropagation();
                    e.preventDefault();
                }
                const orig = btnCapture.textContent;
                btnCapture.disabled = true;
                btnCapture.textContent = '⏳ Đang lưu…';

                chrome.runtime.sendMessage({ action: 'capture_active_session' }, (resp) => {
                    btnCapture.disabled = false;
                    btnCapture.textContent = orig;
                    if (resp && resp.success) {
                        showAccountToast(`🎉 Đã lưu ${resp.profileName} (${resp.cookieCount} cookies)!`);
                        renderProfilesList();
                    } else {
                        showAccountToast(`⚠️ ${resp?.error || 'Lỗi lưu phiên Dola'}`);
                    }
                });
            }, true);
        }

        // 2. Nhập thủ công Cookie
        if (btnImport) {
            btnImport.addEventListener('click', () => {
                const name = inputName ? inputName.value.trim() : '';
                const rawCookies = inputCookies ? inputCookies.value.trim() : '';
                if (!rawCookies) {
                    showAccountToast('⚠️ Hãy dán JSON Cookie hoặc chuỗi Netscape / Header!');
                    if (inputCookies) inputCookies.focus();
                    return;
                }

                btnImport.disabled = true;
                btnImport.textContent = '⏳ Đang phân tích…';

                chrome.runtime.sendMessage({ action: 'import_account_profile', name, cookies: rawCookies }, (resp) => {
                    btnImport.disabled = false;
                    btnImport.textContent = '➕ Lưu / Nạp Cookie Tài Khoản';
                    if (resp && resp.success) {
                        if (inputName) inputName.value = '';
                        if (inputCookies) inputCookies.value = '';
                        showAccountToast(`🎉 Đã lưu tài khoản ${resp.name} (${resp.cookieCount} cookies)!`);
                        renderProfilesList();
                    } else {
                        showAccountToast(`⚠️ ${resp?.error || 'Cookie không đúng định dạng'}`);
                    }
                });
            });
        }

        // 3. Nạp file Cookie
        if (btnUploadTrigger && fileInput) {
            btnUploadTrigger.addEventListener('click', () => {
                fileInput.click();
            });

            fileInput.addEventListener('change', async (e) => {
                const files = Array.from(e.target.files || []);
                if (files.length === 0) return;

                let importedCount = 0;
                for (const file of files) {
                    try {
                        const text = await file.text();
                        const baseName = file.name.replace(/\.[^/.]+$/, '');
                        await new Promise((resolve) => {
                            chrome.runtime.sendMessage({
                                action: 'import_account_profile',
                                name: baseName,
                                cookies: text
                            }, (resp) => {
                                if (resp && resp.success) importedCount++;
                                resolve();
                            });
                        });
                    } catch (err) {
                        console.warn('[Seedance Accounts] File read error:', err);
                    }
                }
                fileInput.value = '';
                showAccountToast(`📁 Đã nạp thành công ${importedCount} tài khoản từ file!`);
                renderProfilesList();
            });
        }

        // 4. Xóa toàn bộ tài khoản
        if (btnClearAll) {
            btnClearAll.addEventListener('click', () => {
                if (confirm('Bạn có chắc chắn muốn xóa toàn bộ danh sách nick Dola đã lưu?')) {
                    chrome.runtime.sendMessage({ action: 'clear_all_accounts' }, () => {
                        renderProfilesList();
                        showAccountToast('🗑️ Đã xóa toàn bộ tài khoản!');
                    });
                }
            });
        }

        // Lắng nghe thay đổi storage để tự cập nhật danh sách nick
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
            chrome.storage.onChanged.addListener((changes, area) => {
                if (area === 'local' && changes.multi_profiles) {
                    renderProfilesList();
                }
            });
        }

        // Render lần đầu
        renderProfilesList();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            initializeGeneratorControls();
            initializeHitCreateVideoButton();
            initializeStopAutomationButton();
            initializeSettingsControls();
            initializeAccountsManagement();
        }, { once: true });
    } else {
        initializeGeneratorControls();
        initializeHitCreateVideoButton();
        initializeStopAutomationButton();
        initializeSettingsControls();
        initializeAccountsManagement();
    }
})();
