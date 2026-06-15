const { ipcRenderer } = require('electron');

// Runs in the hidden YouTube BrowserWindow on every page navigation.
// Finds the live-chat container and observes it for new messages.
// Uses ipcRenderer.send() to forward events to main, which relays them to the main window.

document.addEventListener('DOMContentLoaded', () => {
  injectTitleBar();
  startObserver();
});

function injectTitleBar() {
  if (document.getElementById('sc-yt-bar')) return;

  const bar = document.createElement('div');
  bar.id = 'sc-yt-bar';
  bar.setAttribute('style', [
    'position:fixed', 'top:0', 'left:0', 'right:0', 'height:36px',
    'background:#1a1a1e', 'border-bottom:1px solid #2e2e34',
    'display:flex', 'align-items:center', 'padding:0 12px',
    'z-index:2147483647', '-webkit-app-region:drag',
    'user-select:none', 'gap:8px',
  ].join(';'));

  const title = document.createElement('span');
  title.textContent = 'YouTube Chat';
  title.setAttribute('style', 'flex:1;color:#999;font-size:12px;font-family:system-ui,sans-serif;font-weight:500;letter-spacing:.02em;');

  const hideBtn = document.createElement('button');
  hideBtn.textContent = '✕';
  hideBtn.title = 'Hide window';
  hideBtn.setAttribute('style', [
    '-webkit-app-region:no-drag',
    'background:none', 'border:none', 'color:#bbb',
    'font-size:15px', 'line-height:1', 'cursor:pointer',
    'padding:4px 7px', 'border-radius:4px',
    'display:flex', 'align-items:center', 'transition:background .1s,color .1s',
  ].join(';'));
  hideBtn.addEventListener('mouseenter', () => { hideBtn.style.background = '#3a1212'; hideBtn.style.color = '#ff6b6b'; });
  hideBtn.addEventListener('mouseleave', () => { hideBtn.style.background = 'none'; hideBtn.style.color = '#bbb'; });
  hideBtn.addEventListener('click', () => ipcRenderer.send('yt:fwd:hide'));

  bar.appendChild(title);
  bar.appendChild(hideBtn);
  document.body.insertBefore(bar, document.body.firstChild);
}

function startObserver() {
  const container =
    document.querySelector('yt-live-chat-item-list-renderer #items') ||
    document.querySelector('#items.yt-live-chat-item-list-renderer');

  if (!container) {
    setTimeout(startObserver, 1000);
    return;
  }

  const seen = new Set();
  let msgIndex = 0;

  container.querySelectorAll('yt-live-chat-text-message-renderer').forEach(el => processMsg(el, seen, msgIndex++, false));
  container.querySelectorAll('yt-live-chat-paid-message-renderer').forEach(el => processPaidMsg(el, seen, msgIndex++, false));
  container.querySelectorAll('yt-live-chat-membership-item-renderer').forEach(el => processMembershipMsg(el, seen, msgIndex++, false));

  const observer = new MutationObserver(mutations => {
    mutations.forEach(m => {
      m.addedNodes.forEach(node => {
        if (node.nodeType !== 1) return;
        const tag = node.tagName && node.tagName.toLowerCase();
        if (tag === 'yt-live-chat-text-message-renderer') processMsg(node, seen, msgIndex++, true);
        node.querySelectorAll && node.querySelectorAll('yt-live-chat-text-message-renderer').forEach(el => processMsg(el, seen, msgIndex++, true));
        if (tag === 'yt-live-chat-paid-message-renderer') processPaidMsg(node, seen, msgIndex++, true);
        node.querySelectorAll && node.querySelectorAll('yt-live-chat-paid-message-renderer').forEach(el => processPaidMsg(el, seen, msgIndex++, true));
        if (tag === 'yt-live-chat-membership-item-renderer') processMembershipMsg(node, seen, msgIndex++, true);
        node.querySelectorAll && node.querySelectorAll('yt-live-chat-membership-item-renderer').forEach(el => processMembershipMsg(el, seen, msgIndex++, true));
      });
    });
  });

  observer.observe(container, { childList: true, subtree: true });
}

function processMsg(el, seen, index, isLive) {
  const id = el.getAttribute('id') ||
             el.getAttribute('data-id') ||
             el.getAttribute('data-item-id') ||
             (el.querySelector('[data-id]') && el.querySelector('[data-id]').getAttribute('data-id')) ||
             Math.random().toString(36).slice(2);
  if (seen.has(id)) return;
  seen.add(id);
  el.setAttribute('data-sc-id', id);

  const authorEl = el.querySelector('#author-name');
  const msgEl = el.querySelector('#message');
  const badgeEl = el.querySelector('yt-live-chat-author-badge-renderer');
  const author = authorEl ? authorEl.textContent.trim() : '';
  if (!author) return;

  let text = '';
  const runs = [];
  if (msgEl) {
    msgEl.childNodes.forEach(node => {
      if (node.nodeType === 3) {
        const v = node.textContent;
        if (v) { text += v; runs.push({ type: 'text', value: v }); }
      } else if (node.nodeName === 'IMG') {
        const alt = node.getAttribute('alt') || node.getAttribute('shared-tooltip-text') || '';
        const src = node.src || node.getAttribute('src') || '';
        text += alt;
        runs.push({ type: 'emoji', alt, src });
      } else {
        const v = node.textContent;
        if (v) { text += v; runs.push({ type: 'text', value: v }); }
      }
    });
    text = text.trim();
  }
  if (!text) text = '[emote]';

  const badgeType = badgeEl ? (badgeEl.getAttribute('type') || '') : '';
  const isMod = badgeType === 'moderator' || badgeType === 'owner' ||
                !!el.querySelector('yt-live-chat-author-badge-renderer[type="moderator"]') ||
                !!el.querySelector('yt-live-chat-author-badge-renderer[type="owner"]');
  const authorId = el.getAttribute('author-id') || el.getAttribute('data-author-id') || '';

  let ts = Date.now();
  if (!isLive) {
    const tsText = el.querySelector('#timestamp') && el.querySelector('#timestamp').textContent.trim();
    if (tsText) {
      const m = tsText.match(/(\d+):(\d+)\s*(AM|PM)?/i);
      if (m) {
        let h = parseInt(m[1]), min = parseInt(m[2]);
        const ampm = (m[3] || '').toUpperCase();
        if (ampm === 'PM' && h < 12) h += 12;
        if (ampm === 'AM' && h === 12) h = 0;
        const d = new Date();
        d.setHours(h, min, 0, 0);
        if (d.getTime() > Date.now() + 3600000) d.setDate(d.getDate() - 1);
        ts = d.getTime() + (index || 0);
      }
    }
  }

  ipcRenderer.send('yt:fwd:message', { id, author, text, runs, authorId, isMod, isLive, platform: 'youtube', ts });

  if (!el.hasAttribute('is-deleted')) {
    const delObs = new MutationObserver(() => {
      if (el.hasAttribute('is-deleted')) {
        delObs.disconnect();
        ipcRenderer.send('yt:fwd:deleted', id);
      }
    });
    delObs.observe(el, { attributes: true, attributeFilter: ['is-deleted'] });
  }
}

function processPaidMsg(el, seen, index, isLive) {
  const id = el.getAttribute('id') || el.getAttribute('data-id') || ('paid-' + Math.random().toString(36).slice(2));
  if (seen.has(id)) return;
  seen.add(id);
  el.setAttribute('data-sc-id', id);

  const authorEl = el.querySelector('#author-name');
  const msgEl = el.querySelector('#message');
  const amountEl = el.querySelector('#purchase-amount');
  const author = authorEl ? authorEl.textContent.trim() : '';
  if (!author) return;
  const amount = amountEl ? amountEl.textContent.trim() : '';
  const text = msgEl ? msgEl.textContent.trim() : '';
  const headerBg = el.getAttribute('header-background-color') || el.style.getPropertyValue('--yt-live-chat-paid-message-primary-color') || '';
  const authorId = el.getAttribute('author-id') || el.getAttribute('data-author-id') || '';

  let ts = Date.now();
  if (!isLive) {
    const tsText = el.querySelector('#timestamp') && el.querySelector('#timestamp').textContent.trim();
    if (tsText) {
      const m = tsText.match(/(\d+):(\d+)\s*(AM|PM)?/i);
      if (m) {
        let h = parseInt(m[1]), min = parseInt(m[2]);
        const ampm = (m[3] || '').toUpperCase();
        if (ampm === 'PM' && h < 12) h += 12;
        if (ampm === 'AM' && h === 12) h = 0;
        const d = new Date(); d.setHours(h, min, 0, 0);
        if (d.getTime() > Date.now()) d.setDate(d.getDate() - 1);
        ts = d.getTime();
      }
    }
  }

  ipcRenderer.send('yt:fwd:message', {
    id, author, text, authorId, isMod: false, isLive, platform: 'youtube',
    isSuperchat: true, superAmount: amount, superColor: headerBg, ts, runs: [],
  });
}

function processMembershipMsg(el, seen, index, isLive) {
  const id = el.getAttribute('id') || ('member-' + Math.random().toString(36).slice(2));
  if (seen.has(id)) return;
  seen.add(id);
  el.setAttribute('data-sc-id', id);

  const authorEl = el.querySelector('#author-name');
  const author = authorEl ? authorEl.textContent.trim() : '';
  if (!author) return;

  const debugChildren = Array.from(el.querySelectorAll('*'))
    .filter(c => c.id)
    .map(c => '#' + c.id + ': "' + c.textContent.trim().slice(0, 60) + '"')
    .join(' | ');
  console.log('[YT Membership] author:', author, '| children:', debugChildren);

  const tierEl = el.querySelector('#header-primary-text') || el.querySelector('#header-subtext');
  const tier = tierEl ? tierEl.textContent.trim() : '';
  const msgEl = el.querySelector('#message');
  const message = msgEl ? msgEl.textContent.trim() : '';

  ipcRenderer.send('yt:fwd:membership', { id, author, tier, message, isLive, ts: Date.now() });
}
