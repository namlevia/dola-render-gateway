// Cookie Sync Popup Logic
document.addEventListener('DOMContentLoaded', async () => {
  const platformSel = document.getElementById('platform');
  const accNameInput = document.getElementById('accName');
  const gatewayUrlInput = document.getElementById('gatewayUrl');
  const adminKeyInput = document.getElementById('adminKey');
  const cookieStatus = document.getElementById('cookieStatus');
  const btnSync = document.getElementById('btnSync');
  const btnCopy = document.getElementById('btnCopy');
  const statusDiv = document.getElementById('status');

  // Load saved preferences
  chrome.storage.local.get(['gatewayUrl', 'adminKey', 'lastPlatform'], (res) => {
    if (res.gatewayUrl) gatewayUrlInput.value = res.gatewayUrl;
    if (res.adminKey) adminKeyInput.value = res.adminKey;
    if (res.lastPlatform) platformSel.value = res.lastPlatform;
  });

  // Check current active tab to smart-detect platform
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url) {
      const url = new URL(tab.url);
      if (url.hostname.includes('dola.com')) {
        platformSel.value = 'dola';
      } else if (url.hostname.includes('facebook.com')) {
        platformSel.value = 'facebook';
      }
    }
  } catch (e) {
    console.error('Error querying tab:', e);
  }

  // Generate default account name if empty
  function updateDefaultName() {
    if (!accNameInput.value || accNameInput.value.startsWith('dola_') || accNameInput.value.startsWith('fb_')) {
      const p = platformSel.value;
      const prefix = p === 'facebook' ? 'fb' : 'dola';
      const rand = Math.floor(100 + Math.random() * 900);
      accNameInput.value = `${prefix}_${rand}`;
    }
  }
  updateDefaultName();

  // Inspect & get cookies
  let cachedCookies = [];

  async function refreshCookies() {
    cachedCookies = [];
    const p = platformSel.value;
    cookieStatus.innerHTML = 'Fetching cookies…';

    try {
      let rawCookies = [];
      let checkKey = 'sessionid';
      let displayDomain = 'dola.com';

      if (p === 'dola') {
        displayDomain = 'dola.com';
        checkKey = 'sessionid';
        const [cDomain, cUrl] = await Promise.all([
          chrome.cookies.getAll({ domain: 'dola.com' }),
          chrome.cookies.getAll({ url: 'https://www.dola.com' })
        ]);
        const map = new Map();
        for (const c of [...cDomain, ...cUrl]) {
          map.set(c.name + '@@' + c.domain + '@@' + c.path, c);
        }
        rawCookies = Array.from(map.values());
      } else if (p === 'facebook') {
        displayDomain = 'facebook.com';
        checkKey = 'c_user';
        const [cDomain, cUrl] = await Promise.all([
          chrome.cookies.getAll({ domain: 'facebook.com' }),
          chrome.cookies.getAll({ url: 'https://www.facebook.com' })
        ]);
        const map = new Map();
        for (const c of [...cDomain, ...cUrl]) {
          map.set(c.name + '@@' + c.domain + '@@' + c.path, c);
        }
        rawCookies = Array.from(map.values());
      } else {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab && tab.url) {
          const u = new URL(tab.url);
          displayDomain = u.hostname;
          const [cDomain, cUrl] = await Promise.all([
            chrome.cookies.getAll({ domain: u.hostname.replace(/^www\./, '') }),
            chrome.cookies.getAll({ url: tab.url })
          ]);
          const map = new Map();
          for (const c of [...cDomain, ...cUrl]) {
            map.set(c.name + '@@' + c.domain + '@@' + c.path, c);
          }
          rawCookies = Array.from(map.values());
        }
        checkKey = '';
      }

      // Convert and preserve persistence attributes
      const future = Math.floor(Date.now() / 1000) + 365 * 86400;
      cachedCookies = rawCookies.map(c => {
        let sameSite = undefined;
        if (c.sameSite === 'lax') sameSite = 'Lax';
        else if (c.sameSite === 'strict') sameSite = 'Strict';
        else if (c.sameSite === 'no_restriction') sameSite = 'None';

        return {
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path || '/',
          expires: (c.expirationDate && c.expirationDate > 0) ? c.expirationDate : future,
          httpOnly: Boolean(c.httpOnly),
          secure: Boolean(c.secure),
          sameSite: sameSite
        };
      });

      const hasSession = checkKey ? cachedCookies.some(c => c.name === checkKey) : true;
      const count = cachedCookies.length;

      if (count === 0) {
        cookieStatus.innerHTML = `⚠️ <span style="color:#f59e0b">No cookies found for <b>${displayDomain}</b>.</span><br>Make sure you have visited and logged into the site.`;
      } else {
        cookieStatus.innerHTML = `Found <span class="highlight">${count} cookies</span> for <b>${displayDomain}</b>.<br>` +
          (checkKey
            ? (hasSession
                ? `Key token <code>${checkKey}</code>: <span style="color:#34d399">Present ✓</span>`
                : `Key token <code>${checkKey}</code>: <span style="color:#ef4444">Missing ✗ (Not logged in?)</span>`)
            : `Custom domain cookies ready.`);
      }
    } catch (err) {
      cookieStatus.innerHTML = `<span style="color:#ef4444">Failed to read cookies: ${err.message}</span>`;
    }
  }

  platformSel.addEventListener('change', () => {
    chrome.storage.local.set({ lastPlatform: platformSel.value });
    updateDefaultName();
    refreshCookies();
  });

  await refreshCookies();

  function setStatus(msg, type) {
    statusDiv.textContent = msg;
    statusDiv.className = type;
  }

  // 1-Click Sync
  btnSync.addEventListener('click', async () => {
    const name = accNameInput.value.trim();
    const platform = platformSel.value;
    const gateway = gatewayUrlInput.value.trim().replace(/\/+$/, '');
    const adminKey = adminKeyInput.value.trim();

    if (!name) {
      return setStatus('Please enter an Account Name', 'error');
    }
    if (!cachedCookies.length) {
      return setStatus('No cookies to sync. Please log in first!', 'error');
    }

    // Save preferences
    chrome.storage.local.set({ gatewayUrl: gateway, adminKey });

    btnSync.disabled = true;
    btnSync.innerHTML = '<span>Verifying & Syncing…</span>';
    setStatus('Injecting cookies into Gateway & verifying session…', '');

    try {
      const headers = { 'Content-Type': 'application/json' };
      if (adminKey) headers['X-Admin-Key'] = adminKey;

      const res = await fetch(`${gateway}/api/admin/accounts/cookie`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          name,
          platform,
          cookie: JSON.stringify(cachedCookies)
        })
      });

      const text = await res.text();
      let data = {};
      try {
        data = JSON.parse(text);
      } catch (e) {
        data = { detail: text };
      }
      if (!res.ok) {
        throw new Error(data.detail || `HTTP ${res.status}: ${text.slice(0, 100)}`);
      }

      const activeText = data.active ? 'Status: Active ✓' : 'Status: Unverified';
      setStatus(`✓ Success! Imported ${data.cookie_count} cookies for account "${data.name}". ${activeText}!`, 'success');
      // Update name for next import
      updateDefaultName();
    } catch (err) {
      setStatus(`Failed to sync: ${err.message}`, 'error');
    } finally {
      btnSync.disabled = false;
      btnSync.innerHTML = '<span>⚡ 1-Click Sync to Gateway</span>';
    }
  });

  // Copy JSON
  btnCopy.addEventListener('click', async () => {
    if (!cachedCookies.length) {
      return setStatus('No cookies available to copy', 'error');
    }
    try {
      const jsonStr = JSON.stringify(cachedCookies, null, 2);
      await navigator.clipboard.writeText(jsonStr);
      setStatus(`Copied ${cachedCookies.length} cookies JSON to clipboard! You can paste directly into the dashboard.`, 'success');
    } catch (err) {
      setStatus(`Failed to copy: ${err.message}`, 'error');
    }
  });
});
