const { app, BrowserWindow, ipcMain, session } = require('electron');
const path = require('path');
const puppeteer = require('puppeteer-core');

let mainWindow = null;
let ytBrowser = null;
let ytPage = null;
let ytObserverActive = false;
let ytStatus = 'disconnected'; // 'disconnected' | 'connecting' | 'connected' | 'error'

// ═══════ MAIN WINDOW ═════════════════════════════════════════════════

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 480,
    height: 900,
    minWidth: 380,
    minHeight: 600,
    title: 'Stream Chat',
    backgroundColor: '#0e0e10',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.setMenuBarVisibility(false);

  mainWindow.on('closed', () => {
    mainWindow = null;
    closeYoutubeChat();
  });
}

app.whenReady().then(createWindow);

// ═══════ AUTO UPDATER ════════════════════════════════════════════════

const { autoUpdater } = require('electron-updater');
const AUTO_UPDATE_KEY = 'autoUpdateEnabled';

autoUpdater.autoDownload = false;   // Don't download without user consent
autoUpdater.autoInstallOnAppQuit = true;

// Logging
autoUpdater.logger = require('electron').app && (() => {
  const log = { info: (m) => console.log('[updater]', m), warn: (m) => console.warn('[updater]', m), error: (m) => console.error('[updater]', m) };
  return log;
})();

function sendUpdateStatus(data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update:status', data);
  }
}

autoUpdater.on('checking-for-update', () => sendUpdateStatus({ type: 'checking' }));
autoUpdater.on('update-not-available', () => sendUpdateStatus({ type: 'not-available' }));
autoUpdater.on('error', (err) => sendUpdateStatus({ type: 'error', message: err.message }));
autoUpdater.on('update-available', (info) => {
  sendUpdateStatus({ type: 'available', version: info.version, releaseNotes: info.releaseNotes });
});
autoUpdater.on('download-progress', (p) => {
  sendUpdateStatus({ type: 'progress', percent: Math.round(p.percent) });
});
autoUpdater.on('update-downloaded', (info) => {
  sendUpdateStatus({ type: 'downloaded', version: info.version });
});

// IPC handlers
ipcMain.handle('update:check', async () => {
  try { await autoUpdater.checkForUpdates(); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('update:download', async () => {
  try { await autoUpdater.downloadUpdate(); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('update:install', () => {
  autoUpdater.quitAndInstall(false, true);
});

ipcMain.handle('update:getAutoEnabled', () => {
  const store = require('electron').app.getPath('userData');
  const fs = require('fs');
  const settingsPath = require('path').join(store, 'settings.json');
  try {
    const s = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    return s[AUTO_UPDATE_KEY] !== false; // default true
  } catch { return true; }
});

ipcMain.handle('update:setAutoEnabled', (_, enabled) => {
  const store = require('electron').app.getPath('userData');
  const fs = require('fs');
  const path = require('path');
  const settingsPath = path.join(store, 'settings.json');
  let s = {};
  try { s = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch {}
  s[AUTO_UPDATE_KEY] = enabled;
  fs.writeFileSync(settingsPath, JSON.stringify(s));
  return true;
});

// Auto-check on startup (respects user setting)
app.whenReady().then(async () => {
  // Small delay so the window is ready to receive messages
  setTimeout(async () => {
    try {
      const store = app.getPath('userData');
      const fs = require('fs');
      const path = require('path');
      const settingsPath = path.join(store, 'settings.json');
      let autoEnabled = true;
      try { autoEnabled = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))[AUTO_UPDATE_KEY] !== false; } catch {}
      if (autoEnabled) await autoUpdater.checkForUpdates();
    } catch (e) { console.log('[updater] auto-check failed:', e.message); }
  }, 3000);
});

app.on('window-all-closed', () => {
  closeYoutubeChat();
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (!mainWindow) createWindow();
});

// ═══════ YOUTUBE SCRAPER ═════════════════════════════════════════════

function sendStatus(status, detail) {
  ytStatus = status;
  if (mainWindow) mainWindow.webContents.send('yt:status', { status, detail });
}

function sendMessage(msg) {
  if (mainWindow) mainWindow.webContents.send('yt:message', msg);
}

async function closeYoutubeChat() {
  ytObserverActive = false;
  if (ytBrowser) {
    try { await ytBrowser.close(); } catch {}
    ytBrowser = null;
    ytPage = null;
  }
  sendStatus('disconnected');
}

// Resolve input to a YouTube live chat URL
// Accepts: full youtube.com/watch?v=... URL, youtu.be/... short URL,
//          UC... channel ID, or @handle / channel name
async function resolveYoutubeChatUrl(input) {
  input = input.trim();

  // Direct video URL — extract video ID and go straight to live_chat popout
  const videoMatch = input.match(/(?:youtube\.com\/watch\?.*v=|youtu\.be\/|youtube\.com\/live\/)([a-zA-Z0-9_-]{11})/);
  if (videoMatch) {
    return `https://www.youtube.com/live_chat?is_popout=1&v=${videoMatch[1]}`;
  }

  // Channel ID or handle — we'll navigate there and extract the video ID after page loads
  // Return a sentinel that tells the caller to do a two-step navigation
  if (/^UC[a-zA-Z0-9_-]{20,}$/.test(input)) {
    return { channelUrl: `https://www.youtube.com/channel/${input}/live`, needsExtract: true };
  }

  const handle = input.startsWith('@') ? input : '@' + input;
  return { channelUrl: `https://www.youtube.com/${handle}/live`, needsExtract: true };
}

// Inject MutationObserver into the YouTube live chat page
async function injectChatObserver(page) {
  await page.exposeFunction('onYTChatMessage', (msg) => {
    sendMessage(msg);
  });

  await page.evaluate(() => {
    // Wait for chat container to appear
    function observe() {
      const container =
        document.querySelector('yt-live-chat-item-list-renderer #items') ||
        document.querySelector('#items.yt-live-chat-item-list-renderer');

      if (!container) {
        setTimeout(observe, 1000);
        return;
      }

      const seen = new Set();

      // Process existing messages
      container.querySelectorAll('yt-live-chat-text-message-renderer').forEach(el => processMsg(el, seen));

      const observer = new MutationObserver(mutations => {
        mutations.forEach(m => {
          m.addedNodes.forEach(node => {
            if (node.nodeType !== 1) return;
            // Direct message element
            if (node.tagName && node.tagName.toLowerCase() === 'yt-live-chat-text-message-renderer') {
              processMsg(node, seen);
            }
            // Nested (sometimes wrapped)
            node.querySelectorAll && node.querySelectorAll('yt-live-chat-text-message-renderer').forEach(el => processMsg(el, seen));
          });
        });
      });

      observer.observe(container, { childList: true, subtree: true });
    }

    // Map from our internal message ID → DOM element, so the delete handler can find
    // the exact element without relying on text matching or YouTube's ID attributes.
    if (!window.__scMsgMap) window.__scMsgMap = new Map();

    function processMsg(el, seen) {
      // Try multiple ID sources — YouTube uses different attrs in different contexts
      const id = el.getAttribute('id') ||
                 el.getAttribute('data-id') ||
                 el.getAttribute('data-item-id') ||
                 (el.querySelector('[data-id]') && el.querySelector('[data-id]').getAttribute('data-id')) ||
                 (Math.random().toString(36).slice(2));
      if (seen.has(id)) return;
      seen.add(id);

      // Store a direct reference to this element keyed by our ID
      window.__scMsgMap.set(id, el);

      const authorEl = el.querySelector('#author-name');
      const msgEl = el.querySelector('#message');
      const badgeEl = el.querySelector('yt-live-chat-author-badge-renderer');
      const avatarEl = el.querySelector('yt-img-shadow img, #author-photo img');

      const author = authorEl ? authorEl.textContent.trim() : '';
      // Extract text + emote names (emotes are <img> with alt text)
      let text = '';
      if (msgEl) {
        msgEl.childNodes.forEach(node => {
          if (node.nodeType === 3) { // text node
            text += node.textContent;
          } else if (node.nodeName === 'IMG') {
            text += node.getAttribute('alt') || node.getAttribute('shared-tooltip-text') || '';
          } else {
            text += node.textContent;
          }
        });
        text = text.trim();
      }
      if (!author) return;
      if (!text) text = '[emote]'; // fallback if we still can't extract it

      // Check if moderator or channel owner
      const badgeType = badgeEl ? (badgeEl.getAttribute('type') || '') : '';
      const isMod = badgeType === 'moderator' || badgeType === 'owner' ||
                    !!el.querySelector('yt-live-chat-author-badge-renderer[type="moderator"]') ||
                    !!el.querySelector('yt-live-chat-author-badge-renderer[type="owner"]');

      // Get author channel ID from action menu or data attribute
      const authorId = el.getAttribute('author-id') || el.getAttribute('data-author-id') || '';

      window.onYTChatMessage({
        id,
        author,
        text,
        authorId,
        isMod,
        platform: 'youtube',
        ts: Date.now(),
      });
    }

    observe();
  });
}

// ═══════ IPC HANDLERS ════════════════════════════════════════════════

ipcMain.handle('yt:open', async (_, input) => {
  if (ytBrowser) await closeYoutubeChat();
  sendStatus('connecting');

  try {
    // Find the user's installed Chrome to reuse their Google login session
    const chromePaths = {
      win32: [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
      ],
      darwin: [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
      ],
      linux: [
        '/usr/bin/google-chrome',
        '/usr/bin/chromium-browser',
        '/usr/bin/chromium',
      ],
    };

    const candidates = chromePaths[process.platform] || chromePaths.linux;
    let executablePath = null;
    const fs = require('fs');
    for (const p of candidates) {
      if (p && fs.existsSync(p)) { executablePath = p; break; }
    }

    if (!executablePath) {
      sendStatus('error', 'Chrome not found. Please install Google Chrome.');
      return { ok: false, error: 'Chrome not found' };
    }

    // Use a persistent user data dir so Google login persists between app restarts
    const userDataDir = path.join(app.getPath('userData'), 'yt-chrome-profile');

    ytBrowser = await puppeteer.launch({
      executablePath,
      userDataDir,
      headless: false,
      defaultViewport: null,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
      ],
    });

    // Open the live chat URL
    const chatUrlResult = await resolveYoutubeChatUrl(input);
    const pages = await ytBrowser.pages();
    ytPage = pages[0] || await ytBrowser.newPage();

    if (chatUrlResult.needsExtract) {
      // Load the channel's /live page and read ytInitialPlayerResponse — this is the
      // global YouTube sets specifically for the video in the player, never sidebar/recs
      sendStatus('connecting', 'Looking up live stream...');
      await ytPage.goto(chatUrlResult.channelUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

      let videoId = null;
      try {
        await ytPage.waitForFunction(
          () => !!window.ytInitialPlayerResponse?.videoDetails?.videoId,
          { timeout: 10000 }
        );
        const details = await ytPage.evaluate(() => ({
          videoId: window.ytInitialPlayerResponse?.videoDetails?.videoId || null,
          isLive: window.ytInitialPlayerResponse?.videoDetails?.isLiveContent || false,
          channelId: window.ytInitialPlayerResponse?.videoDetails?.channelId || null,
          title: window.ytInitialPlayerResponse?.videoDetails?.title || '',
        }));
        videoId = details.videoId;
      } catch {}

      if (!videoId) {
        sendStatus('error', 'Could not find a live stream for this channel. Make sure they are currently live.');
        if (ytBrowser) { await ytBrowser.close().catch(() => {}); ytBrowser = null; ytPage = null; }
        return { ok: false, error: 'No live stream found' };
      }

      const chatUrl = `https://www.youtube.com/live_chat?is_popout=1&v=${videoId}`;
      await ytPage.goto(chatUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } else {
      await ytPage.goto(chatUrlResult, { waitUntil: 'domcontentloaded', timeout: 30000 });
    }

    // Check if the chat input requires login (sign-in button visible, or input disabled)
    const needsLogin = await ytPage.evaluate(() => {
      // Logged-out state: a "Sign in" button appears in the chat input area
      const signInBtn = document.querySelector(
        'yt-live-chat-message-input-renderer a[href*="accounts.google"], ' +
        'yt-live-chat-message-input-renderer #sign-in-button, ' +
        'yt-live-chat-message-input-renderer yt-button-renderer[has-no-emphasis] a, ' +
        'yt-live-chat-message-input-renderer ytd-button-renderer a[href*="ServiceLogin"]'
      );
      if (signInBtn) return true;
      // Also check if input area contains a sign-in prompt text
      const inputArea = document.querySelector('yt-live-chat-message-input-renderer');
      if (inputArea && /sign in/i.test(inputArea.textContent)) return true;
      return false;
    });

    if (ytPage.url().includes('accounts.google.com') || ytPage.url().includes('signin') || needsLogin) {
      sendStatus('connecting', 'Please log in to Google in the YouTube window, then click Connect YouTube again');
      // Restore the window so the user can see it and log in
      try {
        const client = await ytPage.target().createCDPSession();
        const { windowId } = await client.send('Browser.getWindowForTarget');
        await client.send('Browser.setWindowBounds', {
          windowId, bounds: { left: 100, top: 100, width: 520, height: 700, windowState: 'normal' }
        });
      } catch {}
      // Click the sign-in button if present so the login page opens automatically
      await ytPage.evaluate(() => {
        const signInBtn = document.querySelector(
          'yt-live-chat-message-input-renderer a[href*="accounts.google"], ' +
          'yt-live-chat-message-input-renderer #sign-in-button, ' +
          'yt-live-chat-message-input-renderer yt-button-renderer[has-no-emphasis] a, ' +
          'yt-live-chat-message-input-renderer ytd-button-renderer a[href*="ServiceLogin"]'
        );
        if (signInBtn) signInBtn.click();
      });
      // Don't proceed — user needs to log in and reconnect
      return { ok: false, error: 'Please log in to Google in the YouTube window, then click Connect YouTube again.' };
    }

    // Move Chrome window off-screen (stays in normal/rendering state so Puppeteer interactions work)
    try {
      const client = await ytPage.target().createCDPSession();
      const { windowId } = await client.send('Browser.getWindowForTarget');
      await client.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
      await new Promise(r => setTimeout(r, 150));
      await client.send('Browser.setWindowBounds', { windowId, bounds: { left: -9999, top: -9999, width: 900, height: 700 } });
    } catch {}

    // Wait for chat to load
    await ytPage.waitForSelector('yt-live-chat-text-message-renderer, #message', { timeout: 20000 })
      .catch(() => {}); // Don't fail if no messages yet

    await injectChatObserver(ytPage);

    // Get the channel name of logged-in user
    const channelName = await ytPage.evaluate(() => {
      const el = document.querySelector('yt-live-chat-header-renderer #channel-name, ytd-topbar-logo-renderer');
      return el ? el.textContent.trim() : '';
    }).catch(() => '');

    ytObserverActive = true;
    sendStatus('connected', channelName);
    return { ok: true, channelName };

  } catch (e) {
    sendStatus('error', e.message);
    await closeYoutubeChat();
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('yt:close', async () => {
  await closeYoutubeChat();
  return { ok: true };
});

ipcMain.handle('yt:send', async (_, text) => {
  if (!ytPage) return { ok: false, error: 'YouTube not connected' };
  try {
    // Use evaluate to type directly — more reliable than keyboard events on background page
    const sent = await ytPage.evaluate(async (msg) => {
      // Try contenteditable input first (newer YouTube chat)
      const input = document.querySelector('#input[contenteditable], yt-live-chat-text-input-field-renderer #input[contenteditable]');
      if (input) {
        input.focus();
        // Use execCommand for contenteditable
        document.execCommand('selectAll');
        document.execCommand('insertText', false, msg);
        // Find and click the send button
        const sendBtn = document.querySelector('#send-button button, #submit-button button, yt-icon-button#send-button');
        if (sendBtn) { sendBtn.click(); return true; }
        // Fallback: dispatch Enter keydown
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
        return true;
      }
      return false;
    }, text);
    if (!sent) throw new Error('Chat input not found — is YouTube chat open?');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('yt:debug', async () => {
  if (!ytPage) return { ok: false };
  const info = await ytPage.evaluate(() => {
    const msgs = [...document.querySelectorAll('yt-live-chat-text-message-renderer')].slice(-5);
    return msgs.map(el => ({
      id: el.getAttribute('id'),
      dataId: el.getAttribute('data-id'),
      authorId: el.getAttribute('author-id') || el.getAttribute('data-author-id'),
      text: (el.querySelector('#message') || el).textContent.trim().slice(0, 40),
      hasOverflow: !!el.querySelector('#overflow, yt-icon-button#overflow, button#overflow'),
    }));
  });
  return { ok: true, info };
});

ipcMain.handle('yt:delete', async (_, { msgId, authorId, text }) => {
  if (!ytPage) return { ok: false, error: 'YouTube not connected' };
  try {
    // Step 1: get an ElementHandle for the target message.
    // ElementHandle.click() uses CDP (isTrusted=true) and handles scrollIntoView internally.
    const msgHandle = await ytPage.evaluateHandle((id, txt, aId) => {
      // Primary: look up the exact element we stored when the message was first observed
      let msgEl = window.__scMsgMap?.get(id) || null;
      // Validate it's still in the DOM (YouTube may have recycled it)
      if (msgEl && !document.contains(msgEl)) msgEl = null;

      // Fallback: YouTube attribute lookup
      if (!msgEl) {
        msgEl = document.getElementById(id) ||
                document.querySelector(`[id="${id}"], [data-id="${id}"]`) ||
                null;
      }

      // Last resort: text + author search (only when both ID paths fail)
      if (!msgEl && txt) {
        const prefix = txt.slice(0, 20);
        const all = [...document.querySelectorAll('yt-live-chat-text-message-renderer')];
        const candidates = aId
          ? all.filter(m => (m.getAttribute('author-id') || m.getAttribute('data-author-id') || '') === aId)
          : all;
        const matches = candidates.filter(m => (m.querySelector('#message') || m).textContent.trim().startsWith(prefix));
        msgEl = matches.findLast(m => !!m) || null;
      }
      return msgEl;
    }, msgId, text || '', authorId || '');

    const found = await msgHandle.evaluate(el => !!el);
    if (!found) return { ok: false, error: 'Message not found in chat' };

    // Step 2: CDP click on the message body (isTrusted=true, scroll handled automatically)
    await msgHandle.click();
    await new Promise(r => setTimeout(r, 700));

    // Step 3: find the Remove item's screen coordinates and do a second CDP click on it.
    // This avoids all Polymer/API complexity — two real clicks, same as a user would do.
    const removeCoords = await ytPage.evaluate(() => {
      const containers = document.querySelectorAll(
        'tp-yt-paper-listbox, ytd-menu-popup-renderer, yt-live-chat-item-context-menu-renderer, tp-yt-iron-dropdown[opened]'
      );
      for (const c of containers) {
        const items = [...c.querySelectorAll('tp-yt-paper-item, ytd-menu-service-item-renderer')];
        const hit = items.find(i => /remove/i.test(i.textContent));
        if (hit) {
          const r = hit.getBoundingClientRect();
          if (r.width && r.height) return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        }
      }
      // Debug: show what menus/items are present
      const info = [...document.querySelectorAll('tp-yt-paper-listbox, ytd-menu-popup-renderer, yt-live-chat-item-context-menu-renderer, tp-yt-iron-dropdown[opened]')]
        .map(c => `${c.tagName}[${[...c.querySelectorAll('tp-yt-paper-item,ytd-menu-service-item-renderer')].map(i => i.textContent.trim().slice(0, 25)).join('|')}]`)
        .join(' / ');
      return { error: `No Remove found. Menus: ${info || 'none'}` };
    });

    if (removeCoords.error) return { ok: false, error: removeCoords.error };

    // CDP click on the Remove item — isTrusted=true, menu is stable at this point
    await ytPage.mouse.click(removeCoords.x, removeCoords.y);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// Helper: click a user's avatar/name in chat to open their panel, then find a mod action
async function ytModAction(channelId, actionLabel) {
  if (!ytPage) return { ok: false, error: 'YouTube not connected' };
  try {
    // Find a message from this user and click their avatar to open mod menu
    const found = await ytPage.evaluate((cid) => {
      const messages = [...document.querySelectorAll('yt-live-chat-text-message-renderer')];
      for (const msg of messages) {
        const authorId = msg.getAttribute('author-id') || msg.getAttribute('data-author-id') || '';
        if (authorId === cid) {
          // Click the author avatar/chip to open the user action menu
          const chip = msg.querySelector('yt-live-chat-author-chip, #author-name');
          if (chip) { chip.click(); return true; }
        }
      }
      return false;
    }, channelId);

    if (!found) return { ok: false, error: 'User not found in current chat — they must have a visible message' };

    // Wait for the action panel/menu to appear
    await ytPage.waitForSelector(
      'yt-live-chat-user-info-panel, ytd-menu-popup-renderer, tp-yt-paper-listbox',
      { timeout: 3000 }
    );

    // Find and click the matching action button
    const clicked = await ytPage.evaluate((label) => {
      // Try action panel buttons first
      const panel = document.querySelector('yt-live-chat-user-info-panel');
      if (panel) {
        const btns = [...panel.querySelectorAll('button, tp-yt-paper-button, yt-button-renderer')];
        const btn = btns.find(b => b.textContent.trim().toLowerCase().includes(label.toLowerCase()));
        if (btn) { btn.click(); return true; }
      }
      // Try popup menu items
      const items = [...document.querySelectorAll('tp-yt-paper-item, ytd-menu-service-item-renderer')];
      const item = items.find(i => i.textContent.trim().toLowerCase().includes(label.toLowerCase()));
      if (item) { item.click(); return true; }
      return false;
    }, actionLabel);

    if (!clicked) return { ok: false, error: `Could not find "${actionLabel}" action in the menu` };

    // If a confirmation dialog appears, confirm it
    await new Promise(r => setTimeout(r, 500));
    await ytPage.evaluate(() => {
      const confirmBtns = [...document.querySelectorAll('button, tp-yt-paper-button')];
      const confirm = confirmBtns.find(b => /confirm|ok|yes|submit/i.test(b.textContent));
      if (confirm) confirm.click();
    });

    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

ipcMain.handle('yt:timeout', async (_, { channelId, duration }) => {
  // YouTube chat timeout is called "Put in timeout" in the UI
  const result = await ytModAction(channelId, 'timeout');
  // Note: YouTube's DOM timeout is always a fixed duration set by YouTube (~5 min)
  // There's no way to set custom duration via DOM — the duration param is ignored
  return result;
});

ipcMain.handle('yt:ban', async (_, channelId) => {
  return ytModAction(channelId, 'ban');
});

ipcMain.handle('yt:getEmotes', async () => {
  if (!ytPage) return { ok: false, error: 'YouTube not connected' };
  try {
    const emotes = await ytPage.evaluate(async () => {
      // Click the emoji button to open the picker
      const emojiBtn = document.querySelector(
        '#picker-buttons yt-icon-button, button#emoji-picker-button, ' +
        'yt-live-chat-message-input-renderer #picker-buttons button'
      );
      if (!emojiBtn) return [];
      emojiBtn.click();

      // Wait for the picker panel to appear
      await new Promise(r => setTimeout(r, 800));

      const results = [];
      const seen = new Set();

      // Scrape all emoji items from the panel
      const items = document.querySelectorAll(
        'yt-emoji-picker-renderer yt-emoji-icon-renderer, ' +
        'yt-live-chat-emoji-picker-entity-view-model img, ' +
        'yt-emoji-picker-renderer img'
      );

      items.forEach(el => {
        const img = el.tagName === 'IMG' ? el : el.querySelector('img');
        if (!img) return;
        const src = img.src || img.dataset.src || '';
        if (!src || !src.startsWith('http')) return;
        // Get the name from aria-label, alt, or tooltip
        const name = img.alt || el.getAttribute('aria-label') ||
                     el.closest('[aria-label]')?.getAttribute('aria-label') || '';
        if (!name || seen.has(name)) return;
        seen.add(name);
        results.push({ name: name.replace(/^:|:$/g, ''), url: src });
      });

      // Close picker
      emojiBtn.click();
      return results;
    });

    return { ok: true, emotes };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('yt:showWindow', async () => {
  if (!ytPage) return { ok: false, error: 'YouTube not connected' };
  try {
    const client = await ytPage.target().createCDPSession();
    const { windowId } = await client.send('Browser.getWindowForTarget');
    // On Windows, must restore to normal first, then set position in a second call
    await client.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
    await new Promise(r => setTimeout(r, 150));
    await client.send('Browser.setWindowBounds', { windowId, bounds: { left: 100, top: 100, width: 520, height: 700 } });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('yt:hideWindow', async () => {
  if (!ytPage) return { ok: false, error: 'YouTube not connected' };
  try {
    const client = await ytPage.target().createCDPSession();
    const { windowId } = await client.send('Browser.getWindowForTarget');
    await client.send('Browser.setWindowBounds', { windowId, bounds: { left: -9999, top: -9999, width: 900, height: 700 } });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('yt:getChannelName', async () => {
  if (!ytPage) return { ok: false };
  try {
    const name = await ytPage.evaluate(() => {
      const el = document.querySelector('#author-name, yt-live-chat-author-chip');
      return el ? el.textContent.trim() : '';
    });
    return { ok: true, name };
  } catch {
    return { ok: false };
  }
});

// ═══════ OAUTH (Twitch + Google) ════════════════════════════════════
// Uses a tiny local HTML page served by Electron's protocol module
// so no external server is needed and no redirect_uri registration issues.
// Redirect URI = 'http://localhost/callback' — register this in Twitch console.

function openOAuthWindow(authUrl, title) {
  return new Promise((resolve) => {
    const http = require('http');
    const { BrowserWindow } = require('electron');
    let resolved = false;
    let win = null; // hoisted so request handler can access it

    const OAUTH_PORT = 17543;

    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/token' && url.searchParams.get('access_token')) {
        const token = url.searchParams.get('access_token');
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body><script>window.close();</script><p>Login successful! You can close this window.</p></body></html>');
        server.close();
        if (!resolved) { resolved = true; if (win && !win.isDestroyed()) win.destroy(); resolve({ ok: true, token }); }
      } else if (url.pathname === '/error') {
        const error = url.searchParams.get('error_description') || url.searchParams.get('error') || 'Unknown error';
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body><p>Login failed: ' + error + '</p></body></html>');
        server.close();
        if (!resolved) { resolved = true; if (win && !win.isDestroyed()) win.destroy(); resolve({ ok: false, error }); }
      } else {
        // Check if error came directly as query params (e.g. Twitch redirect_mismatch)
        const qError = url.searchParams.get('error');
        if (qError) {
          const errDesc = url.searchParams.get('error_description') || qError;
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end('<html><body><p>Login failed: ' + errDesc + '</p></body></html>');
          server.close();
          if (!resolved) { resolved = true; if (win && !win.isDestroyed()) win.destroy(); resolve({ ok: false, error: errDesc }); }
        } else {
          // Main callback page — reads hash fragment and redirects to /token
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(`<html><body><script>
            const hash = window.location.hash.slice(1);
            const params = new URLSearchParams(hash || window.location.search.slice(1));
            const token = params.get('access_token');
            const error = params.get('error');
            if (token) {
              window.location = '/token?access_token=' + encodeURIComponent(token);
            } else if (error) {
              window.location = '/error?error=' + encodeURIComponent(error) + '&error_description=' + encodeURIComponent(params.get('error_description') || error);
            }
          </script><p>Completing login...</p></body></html>`);
        }
      }
    });

    server.on('error', (err) => {
      console.error('OAuth server error:', err.message);
      if (!resolved) resolve({ ok: false, error: 'Could not start login server: ' + err.message });
    });

    // Listen on all interfaces to handle both localhost (::1) and 127.0.0.1
    server.listen(OAUTH_PORT, () => {
      console.log('OAuth server listening on port', OAUTH_PORT);
      const redirectUri = 'http://localhost:' + OAUTH_PORT + '/callback';
      const finalUrl = authUrl.replace('REDIRECT_URI_PLACEHOLDER', encodeURIComponent(redirectUri));

      win = new BrowserWindow({
        width: 520, height: 720, title,
        webPreferences: { nodeIntegration: false, contextIsolation: true }
      });
      win.loadURL(finalUrl);
      win.on('closed', () => {
        server.close();
        if (!resolved) resolve({ ok: false, error: 'Window closed' });
      });
    });
  });
}

// Twitch login handled via pre-obtained token — no OAuth server needed

ipcMain.handle('open:external', (_, url) => {
  const { shell } = require('electron');
  shell.openExternal(url);
});

ipcMain.handle('yt:loginOAuth', async (_, { clientId }) => {
  const scope = encodeURIComponent('https://www.googleapis.com/auth/youtube.force-ssl');
  const url = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${encodeURIComponent(clientId)}&redirect_uri=REDIRECT_URI_PLACEHOLDER&response_type=token&prompt=select_account&scope=${scope}`;
  return openOAuthWindow(url, 'Login with Google');
});

