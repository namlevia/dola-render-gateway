// Seedance Studio Pro - Page Bridge (Runs in MAIN world)
// 1. Extracts fallback_api & key_seed from React Fiber
// 2. ProseMirror prompt inject / Create Videos skill click
// NOTE: Do NOT hook fetch/XHR here — Dola detects it and kicks sessions.

(function () {
  'use strict';
  const seenFallbackApis = new Set();
  try { localStorage.removeItem('seedance-studio-video-params'); } catch (e) {}

  function scanReactCards() {
    try {
      const cards = document.querySelectorAll(
        '.block-video-MzfWVN, .video-player-NmhH16, [class*="video-player"], [class*="block-video"]'
      );
      for (const card of cards) {
        const fiberKey = Object.keys(card).find(
          (k) => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance')
        );
        if (!fiberKey) continue;
        let curr = card[fiberKey];
        while (curr) {
          if (curr.memoizedProps && curr.memoizedProps.creationsVideoList) {
            for (const item of curr.memoizedProps.creationsVideoList) {
              if (item.video && item.video.video_model) {
                try {
                  const vm =
                    typeof item.video.video_model === 'string'
                      ? JSON.parse(item.video.video_model)
                      : item.video.video_model;
                  const fallbackApi = vm.fallback_api;
                  const vid = item.video.vid || vm.video_id;
                  const keySeed = vm.key_seed;
                  if (fallbackApi && !seenFallbackApis.has(fallbackApi)) {
                    seenFallbackApis.add(fallbackApi);
                    window.postMessage(
                      {
                        type: 'SEEDANCE_PAGE_FALLBACK_API',
                        fallbackApi,
                        keySeed,
                        vid
                      },
                      '*'
                    );
                  }
                } catch (e) {}
              }
            }
          }
          curr = curr.return;
        }
      }
    } catch (e) {
      console.warn('[Seedance Bridge] scanReactCards error:', e);
    }
  }

  setInterval(scanReactCards, 1200);
  setTimeout(scanReactCards, 500);

  // ==========================================================================
  // DIRECT PROSEMIRROR & REACT COMPOSER INJECTOR (MAIN WORLD)
  // ==========================================================================
  function findActiveEditorElement() {
    const allProse = Array.from(document.querySelectorAll('.tiptap.ProseMirror, .ProseMirror, div[contenteditable="true"]'));
    const bottomProse = allProse.filter((el) => {
      if (el.closest('header, nav, aside, [class*="sidebar"]')) return false;
      const r = el.getBoundingClientRect();
      return r.height > 15 && r.width > 80 && r.top > window.innerHeight * 0.35;
    });
    if (bottomProse.length > 0) {
      bottomProse.sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top);
      return bottomProse[0];
    }
    return null;
  }

  function findEditorView(el) {
    if (!el) return null;
    let curr = el;
    while (curr && curr !== document.body) {
      if (curr.pmViewDesc && curr.pmViewDesc.editorView) {
        return curr.pmViewDesc.editorView;
      }
      curr = curr.parentElement;
    }
    const child = el.querySelector?.('.ProseMirror');
    if (child && child.pmViewDesc && child.pmViewDesc.editorView) {
      return child.pmViewDesc.editorView;
    }
    return null;
  }

  function findSendButton() {
    // 1. Selector chính xác của Dola web
    const exact = document.getElementById('flow-end-msg-send') ||
                  document.querySelector('#flow-end-msg-send') ||
                  document.querySelector('button[class*="send-msg-btn"]') ||
                  document.querySelector('[class*="send-msg-btn"]') ||
                  document.querySelector('.send-btn-wrapper button') ||
                  document.querySelector('[data-testid*="send"]') ||
                  document.querySelector('button[aria-label*="send" i]') ||
                  document.querySelector('button[aria-label*="gửi" i]') ||
                  document.querySelector('[id*="msg-send"]');
    if (exact) return exact.closest('button') || exact;

    // 2. Tìm nút nằm trong cùng composer container với ô soạn thảo (nút tròn xanh mũi tên lên)
    const input = findActiveEditorElement();
    if (input) {
      const composerBox = input.closest('form, [class*="composer"], [class*="chat-input"], [class*="input-wrap"], [class*="relative"]') || input.parentElement?.parentElement;
      if (composerBox) {
        const composerButtons = Array.from(composerBox.querySelectorAll('button, div[role="button"]'));
        const sendCandidate = composerButtons.reverse().find((btn) => {
          const r = btn.getBoundingClientRect();
          if (r.width < 15 || r.height < 15) return false;
          if (btn.closest('[class*="exit"], .bg-g-exit-skill-btn-bg')) return false;
          const t = (btn.innerText || btn.textContent || '').trim().toLowerCase();
          if (/^(?:fast|pro|nhanh|2\.0|2\.5|5s|10s|15s|30s|ratio|tỉ\s*lệ|skills?|kỹ\s*năng|dự\s*án|\+|\.\.\.)$/i.test(t)) return false;
          return btn.querySelector('svg') || /send|submit|gửi/i.test(btn.className + (btn.id || ''));
        });
        if (sendCandidate) return sendCandidate;
      }
    }

    // 3. Fallback nút ở góc dưới phải
    const candidates = Array.from(document.querySelectorAll('button, div[role="button"]'));
    const bottomCandidates = candidates.filter((btn) => {
      const rect = btn.getBoundingClientRect();
      return rect.height > 15 && rect.width > 15 && rect.top > window.innerHeight * 0.45 && rect.left > window.innerWidth * 0.35;
    });

    for (const btn of bottomCandidates) {
      const text = (btn.textContent || '').trim().toLowerCase();
      const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
      const id = (btn.id || '').toLowerCase();
      const cls = (btn.className || '').toString().toLowerCase();
      if (/pro|nhanh|dự\s*án|kỹ\s*năng|mic|voice|attach|upload|ghi\s*âm|đính\s*kèm/i.test(text + aria + id + cls)) continue;
      if (id.includes('send') || cls.includes('send') || /send|submit|gửi/i.test(aria)) {
        return btn;
      }
    }
    return null;
  }

  function findCreateVideoSkillButton() {
    try {
      const skillItems = Array.from(document.querySelectorAll('button[data-component-type="skill-item"], button.skill-bar-button'));
      const exact = skillItems.find((el) => {
        if (el.closest('header, nav, aside, [class*="sidebar"], [class*="conversation-item"], a[id^="conversation_"]')) return false;
        const r = el.getBoundingClientRect();
        if (r.left < 280 && r.width < 300) return false;
        const t = (el.innerText || el.textContent || '').trim();
        return /^(?:create\s*videos?|tạo\s*videos?)$/i.test(t);
      });
      if (exact) return exact;

      const candidates = Array.from(document.querySelectorAll('button, [role="button"]'));
      return candidates.find((el) => {
        if (el.closest('header, nav, aside, [class*="sidebar"], [class*="conversation-item"], a[id^="conversation_"]')) return false;
        const r = el.getBoundingClientRect();
        if (r.top < window.innerHeight * 0.55 || r.left < 280 || r.width < 20 || r.height < 16) return false;
        const t = (el.innerText || el.textContent || '').trim();
        return /^(?:create\s*videos?|tạo\s*videos?)$/i.test(t);
      }) || null;
    } catch (e) {}
    return null;
  }

  function handleBridgeActivateVideoSkill() {
    try {
      const btn = findCreateVideoSkillButton();
      if (btn) {
        btn.click();
        if (btn.firstElementChild) btn.firstElementChild.click();
        console.log('[Seedance Bridge] Clicked Create Videos skill button from MAIN world!');
        window.postMessage({ type: 'SEEDANCE_SKILL_CLICK_RESULT', success: true }, '*');
        return true;
      }
    } catch (e) {}
    window.postMessage({ type: 'SEEDANCE_SKILL_CLICK_RESULT', success: false }, '*');
    return false;
  }

  function handleBridgePromptInjection(text, autoSubmit = false) {
    try {
      const editorEl = findActiveEditorElement();
      if (!editorEl) {
        console.warn('[Seedance Bridge] Không tìm thấy ô soạn thảo active!');
        window.postMessage({ type: 'SEEDANCE_INJECT_RESULT', success: false, reason: 'No editor element' }, '*');
        return false;
      }

      editorEl.focus();
      const view = findEditorView(editorEl);
      let injected = false;

      if (view && view.state && view.state.schema) {
        try {
          const { schema } = view.state;
          const lines = String(text || '').split(/\r?\n/).filter(Boolean);
          const paragraphs = lines.length > 0
            ? lines.map((line) => schema.nodes.paragraph.create(null, schema.text(line)))
            : [schema.nodes.paragraph.create(null, schema.text(String(text || '')))];
          const newDoc = schema.nodes.doc.create(null, paragraphs);
          const replaceTr = view.state.tr.replaceWith(0, view.state.doc.content.size, newDoc.content);
          view.dispatch(replaceTr);
          view.focus();
          injected = true;
          console.log('[Seedance Bridge] Đã inject prompt trực tiếp qua ProseMirror view.dispatch!');
        } catch (err) {
          console.warn('[Seedance Bridge] ProseMirror dispatch error, trying DOM fallback:', err);
        }
      }

      if (!injected) {
        let p = editorEl.querySelector('p');
        if (!p) {
          p = document.createElement('p');
          editorEl.appendChild(p);
        }
        p.textContent = text;
        try {
          const sel = window.getSelection();
          const range = document.createRange();
          range.selectNodeContents(p);
          range.collapse(false);
          sel.removeAllRanges();
          sel.addRange(range);
        } catch (e) {}

        p.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: text }));
        p.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: text }));
        editorEl.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: text }));
        editorEl.dispatchEvent(new Event('input', { bubbles: true }));
        editorEl.dispatchEvent(new Event('change', { bubbles: true }));
        injected = true;
      }

      window.postMessage({ type: 'SEEDANCE_INJECT_RESULT', success: true }, '*');

      // Gửi duy nhất 1 lần: Tuyệt đối không vừa dispatch Enter vừa click sendBtn gây lỗi prompt đôi!
      if (autoSubmit) {
        setTimeout(() => {
          const sendBtn = findSendButton();
          if (sendBtn) {
            sendBtn.removeAttribute('disabled');
            sendBtn.setAttribute('aria-disabled', 'false');
            sendBtn.click();
            console.log('[Seedance Bridge] Đã click nút gửi Dola duy nhất từ MAIN world!');
          } else {
            const enterProps = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
            editorEl.dispatchEvent(new KeyboardEvent('keydown', enterProps));
            editorEl.dispatchEvent(new KeyboardEvent('keyup', enterProps));
            console.log('[Seedance Bridge] Đã gửi Enter duy nhất từ MAIN world!');
          }
        }, 300);
      }
      return true;
    } catch (e) {
      console.warn('[Seedance Bridge] handleBridgePromptInjection error:', e);
      window.postMessage({ type: 'SEEDANCE_INJECT_RESULT', success: false, error: e.message }, '*');
      return false;
    }
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data) return;
    if (event.data.type === 'SEEDANCE_INJECT_PROMPT') {
      handleBridgePromptInjection(event.data.text, event.data.autoSubmit);
    }
    if (event.data.type === 'SEEDANCE_ACTIVATE_VIDEO_SKILL') {
      handleBridgeActivateVideoSkill();
    }
  });
})();
