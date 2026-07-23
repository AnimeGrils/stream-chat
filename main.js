const { app, BrowserWindow, ipcMain, session } = require('electron');
const path = require('path');
const http = require('http');
const fs = require('fs');

let mainWindow = null;
let ytWin = null;
let ytObserverActive = false;
let ytStatus = 'disconnected'; // 'disconnected' | 'connecting' | 'connected' | 'error'

// ═══════ OVERLAY SSE SERVER ══════════════════════════════════════════

const OVERLAY_PORT = 3899;
let sseClients = [];

function startOverlayServer() {
  const server = http.createServer((req, res) => {
    if (req.url === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });
      res.write(':ok\n\n');
      sseClients.push(res);
      req.on('close', () => { sseClients = sseClients.filter(c => c !== res); });
    } else {
      const file = path.join(__dirname, 'renderer', 'overlay.html');
      fs.readFile(file, (err, data) => {
        if (err) { res.writeHead(404); res.end('Not found'); return; }
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(data);
      });
    }
  });
  server.listen(OVERLAY_PORT, '127.0.0.1');
}

function broadcastOverlay(data) {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach(c => { try { c.write(payload); } catch {} });
}

ipcMain.on('overlay:msg', (_, data) => broadcastOverlay(data));

// ═══════ MAIN WINDOW ═════════════════════════════════════════════════

function getWindowStatePath() {
  return path.join(app.getPath('userData'), 'window-state.json');
}
function readWindowState() {
  try { return JSON.parse(fs.readFileSync(getWindowStatePath(), 'utf8')); } catch { return {}; }
}
function writeWindowState(data) {
  try { fs.writeFileSync(getWindowStatePath(), JSON.stringify(data)); } catch {}
}

function createWindow() {
  const ws = readWindowState();
  const useSaved = !!ws.rememberBounds && ws.width && ws.height;
  mainWindow = new BrowserWindow({
    width: useSaved ? ws.width : 480,
    height: useSaved ? ws.height : 900,
    x: useSaved ? ws.x : undefined,
    y: useSaved ? ws.y : undefined,
    minWidth: 380,
    minHeight: 600,
    title: 'Stream Chat',
    backgroundColor: '#0e0e10',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.setMenuBarVisibility(false);

  mainWindow.on('close', () => {
    if (readWindowState().rememberBounds) {
      const b = mainWindow.getBounds();
      writeWindowState({ ...readWindowState(), x: b.x, y: b.y, width: b.width, height: b.height });
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    closeYoutubeChat();
  });
}

ipcMain.handle('windowState:get', () => { const ws = readWindowState(); return { rememberBounds: !!ws.rememberBounds }; });
ipcMain.handle('windowState:set', (_, data) => { writeWindowState({ ...readWindowState(), ...data }); });

app.whenReady().then(() => { createWindow(); startOverlayServer(); });

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

// ═══════ YOUTUBE EMBEDDED WINDOW ════════════════════════════════════

function sendStatus(status, detail) {
  ytStatus = status;
  if (mainWindow) mainWindow.webContents.send('yt:status', { status, detail });
}

function sendMessage(msg) {
  if (mainWindow) mainWindow.webContents.send('yt:message', msg);
}

function sendMembership(data) {
  if (mainWindow) mainWindow.webContents.send('yt:membership', data);
}

function sendDeletion(id) {
  if (mainWindow) mainWindow.webContents.send('yt:deleted', id);
}

// Forward IPC messages sent by yt-preload.js to the main window
ipcMain.on('yt:fwd:message', (event, msg) => {
  if (ytWin && event.sender === ytWin.webContents) sendMessage(msg);
});
ipcMain.on('yt:fwd:deleted', (event, id) => {
  if (ytWin && event.sender === ytWin.webContents) sendDeletion(id);
});
ipcMain.on('yt:fwd:membership', (event, data) => {
  if (ytWin && event.sender === ytWin.webContents) sendMembership(data);
});
ipcMain.on('yt:fwd:hide', (event) => {
  if (ytWin && !ytWin.isDestroyed() && event.sender === ytWin.webContents) {
    notifyYtWindowHidden();
    ytWin.hide();
  }
});

function createYtWindow() {
  ytWin = new BrowserWindow({
    show: false,
    width: 520,
    height: 700,
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, 'yt-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      partition: 'persist:youtube',
      backgroundThrottling: false,
    },
  });
  // Alt+F4 / system close — hide instead of destroy
  ytWin.on('close', (event) => { event.preventDefault(); notifyYtWindowHidden(); ytWin.hide(); });
  ytWin.on('closed', () => { ytWin = null; ytObserverActive = false; });
}

function notifyYtWindowHidden() {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('yt:windowHidden');
}

async function closeYoutubeChat() {
  ytObserverActive = false;
  if (ytWin && !ytWin.isDestroyed()) {
    try { ytWin.destroy(); } catch {}
    ytWin = null;
  }
  sendStatus('disconnected');
}

// Run JS in the YT window's page context
function ytExec(js) {
  if (!ytWin || ytWin.isDestroyed()) return Promise.reject(new Error('YouTube window not open'));
  return ytWin.webContents.executeJavaScript(js);
}

// Navigate the YT window. YouTube's own client-side JS sometimes redirects mid-navigation
// (e.g. appending ?themeRefresh=1), which aborts our loadURL() with ERR_ABORTED even though
// the page goes on to load fine — that's not a real failure, so swallow just that error.
async function ytLoad(url) {
  try {
    await ytWin.loadURL(url);
  } catch (e) {
    if (!/ERR_ABORTED/.test(e.message)) throw e;
  }
}

// Poll until js expression returns truthy, or timeout
async function ytWaitFor(js, timeout) {
  timeout = timeout || 10000;
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const r = await ytExec(js);
      if (r) return r;
    } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  return null;
}

// ═══════ IPC HANDLERS ════════════════════════════════════════════════

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

ipcMain.handle('yt:open', async (_, input) => {
  if (ytWin && !ytWin.isDestroyed()) {
    ytObserverActive = false;
  } else {
    createYtWindow();
  }
  sendStatus('connecting');

  try {
    const chatUrlResult = await resolveYoutubeChatUrl(input);
    let chatUrl;

    if (chatUrlResult.needsExtract) {
      sendStatus('connecting', 'Looking up live stream...');
      await ytLoad(chatUrlResult.channelUrl);

      const details = await ytWaitFor(
        'window.ytInitialPlayerResponse && window.ytInitialPlayerResponse.videoDetails && window.ytInitialPlayerResponse.videoDetails.videoId ? ' +
        '{ videoId: window.ytInitialPlayerResponse.videoDetails.videoId } : null',
        10000
      );

      if (!details || !details.videoId) {
        sendStatus('error', 'Could not find a live stream for this channel. Make sure they are currently live.');
        return { ok: false, error: 'No live stream found' };
      }

      chatUrl = 'https://www.youtube.com/live_chat?is_popout=1&v=' + details.videoId;
    } else {
      chatUrl = chatUrlResult;
    }

    await ytLoad(chatUrl);

    const currentUrl = ytWin.webContents.getURL();
    const needsLogin = await ytExec(
      '(function() {' +
      '  var s = document.querySelector(' +
      '    "yt-live-chat-message-input-renderer a[href*=\'accounts.google\']," +' +
      '    "yt-live-chat-message-input-renderer #sign-in-button," +' +
      '    "yt-live-chat-message-input-renderer yt-button-renderer[has-no-emphasis] a," +' +
      '    "yt-live-chat-message-input-renderer ytd-button-renderer a[href*=\'ServiceLogin\']"' +
      '  );' +
      '  if (s) return true;' +
      '  var a = document.querySelector("yt-live-chat-message-input-renderer");' +
      '  if (a && /sign in/i.test(a.textContent)) return true;' +
      '  return false;' +
      '})()'
    ).catch(() => false);

    if (currentUrl.includes('accounts.google.com') || currentUrl.includes('signin') || needsLogin) {
      ytWin.show();
      ytWin.focus();
      if (needsLogin) {
        await ytExec(
          '(function() {' +
          '  var s = document.querySelector(' +
          '    "yt-live-chat-message-input-renderer a[href*=\'accounts.google\']," +' +
          '    "yt-live-chat-message-input-renderer #sign-in-button," +' +
          '    "yt-live-chat-message-input-renderer yt-button-renderer[has-no-emphasis] a," +' +
          '    "yt-live-chat-message-input-renderer ytd-button-renderer a[href*=\'ServiceLogin\']"' +
          '  );' +
          '  if (s) s.click();' +
          '})()'
        ).catch(() => {});
      }
      sendStatus('connecting', 'Please log in to Google in the YouTube window, then click Connect YouTube again');
      return { ok: false, error: 'Please log in to Google in the YouTube window, then click Connect YouTube again.' };
    }

    // Wait for chat messages to appear (observer starts automatically via yt-preload.js)
    await ytWaitFor('!!document.querySelector("yt-live-chat-text-message-renderer, #message")', 20000);

    // Override visibility API so YouTube doesn't pause auto-scroll in the hidden window
    await ytExec(
      'try {' +
      '  Object.defineProperty(document, "visibilityState", { get: function() { return "visible"; }, configurable: true });' +
      '  Object.defineProperty(document, "hidden", { get: function() { return false; }, configurable: true });' +
      '  document.dispatchEvent(new Event("visibilitychange"));' +
      '} catch(e) {}'
    ).catch(() => {});

    const channelName = await ytExec(
      '(function() {' +
      '  var el = document.querySelector("yt-live-chat-header-renderer #channel-name, ytd-topbar-logo-renderer");' +
      '  return el ? el.textContent.trim() : "";' +
      '})()'
    ).catch(() => '');

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
  if (!ytWin || ytWin.isDestroyed()) return { ok: false, error: 'YouTube not connected' };
  try {
    const safeText = JSON.stringify(text);
    const sent = await ytExec(
      '(function() {' +
      '  var input = document.querySelector("#input[contenteditable], yt-live-chat-text-input-field-renderer #input[contenteditable]");' +
      '  if (input) {' +
      '    input.focus();' +
      '    document.execCommand("selectAll");' +
      '    document.execCommand("insertText", false, ' + safeText + ');' +
      '    var sendBtn = document.querySelector("#send-button button, #submit-button button, yt-icon-button#send-button");' +
      '    if (sendBtn) { sendBtn.click(); return true; }' +
      '    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));' +
      '    return true;' +
      '  }' +
      '  return false;' +
      '})()'
    );
    if (!sent) throw new Error('Chat input not found — is YouTube chat open?');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('yt:debug', async () => {
  if (!ytWin || ytWin.isDestroyed()) return { ok: false };
  const info = await ytExec(
    '(function() {' +
    '  var msgs = Array.from(document.querySelectorAll("yt-live-chat-text-message-renderer")).slice(-5);' +
    '  return msgs.map(function(el) {' +
    '    return {' +
    '      id: el.getAttribute("id"),' +
    '      dataId: el.getAttribute("data-id"),' +
    '      scId: el.getAttribute("data-sc-id"),' +
    '      authorId: el.getAttribute("author-id") || el.getAttribute("data-author-id"),' +
    '      text: (el.querySelector("#message") || el).textContent.trim().slice(0, 40),' +
    '    };' +
    '  });' +
    '})()'
  );
  return { ok: true, info };
});

// Builds a page-main-world script that finds a chat message element (findElJs must
// assign to `el`), fetches its InnerTube context menu, and invokes the menu action
// whose label matches actionRe — the same two calls YouTube's UI makes for mod actions.
// Auth = SAPISIDHASH from the page's cookie + X-Goog-AuthUser/X-Goog-PageId identity
// headers (PageId is required for brand accounts to be recognized as mods).
function ytModerateScript(findElJs, actionRe, notFoundMsg, timeoutSeconds) {
  const wantSecs = parseInt(timeoutSeconds, 10) > 0 ? parseInt(timeoutSeconds, 10) : 300;
  return '(async function() {' +
    '  var el = null;' +
    findElJs +
    '  if (!el) return { error: "' + notFoundMsg + '" };' +
    '  var d = el.data || (el.__data && (el.__data.data || el.__data)) || {};' +
    '  var ep = d.contextMenuEndpoint && d.contextMenuEndpoint.liveChatItemContextMenuEndpoint;' +
    '  if (!ep || !ep.params) return { error: "no context menu params on message element" };' +
    '  if (!window.ytcfg) return { error: "ytcfg not available" };' +
    '  var key = window.ytcfg.get("INNERTUBE_API_KEY"), ctx = window.ytcfg.get("INNERTUBE_CONTEXT");' +
    '  if (!key || !ctx) return { error: "InnerTube config missing" };' +
    '  var sapisid = (document.cookie.match(/(?:^|;\\s*)SAPISID=([^;]+)/) || document.cookie.match(/(?:^|;\\s*)__Secure-3PAPISID=([^;]+)/) || [])[1];' +
    '  if (!sapisid) return { error: "SAPISID cookie not found — not logged in?" };' +
    '  var time = Math.floor(Date.now() / 1000);' +
    '  var buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(time + " " + sapisid + " https://www.youtube.com"));' +
    '  var hash = Array.from(new Uint8Array(buf)).map(function(b) { return b.toString(16).padStart(2, "0"); }).join("");' +
    '  var headers = { "Content-Type": "application/json", "Authorization": "SAPISIDHASH " + time + "_" + hash, "X-Origin": "https://www.youtube.com" };' +
    '  headers["X-Goog-AuthUser"] = String(window.ytcfg.get("SESSION_INDEX") || "0");' +
    '  var pageId = window.ytcfg.get("DELEGATED_SESSION_ID");' +
    '  if (pageId) headers["X-Goog-PageId"] = pageId;' +
    '  var menuResp = await fetch("/youtubei/v1/live_chat/get_item_context_menu?prettyPrint=false&params=" + encodeURIComponent(ep.params) + "&key=" + encodeURIComponent(key),' +
    '    { method: "POST", headers: headers, credentials: "include", body: JSON.stringify({ context: ctx }) });' +
    '  var menuData = await menuResp.json().catch(function() { return null; });' +
    '  if (!menuResp.ok) return { error: "context menu HTTP " + menuResp.status + ((menuData && menuData.error && menuData.error.message) ? ": " + menuData.error.message : "") };' +
    '  var items = (menuData && menuData.liveChatItemContextMenuSupportedRenderers && menuData.liveChatItemContextMenuSupportedRenderers.menuRenderer && menuData.liveChatItemContextMenuSupportedRenderers.menuRenderer.items) || [];' +
    '  var re = ' + actionRe + ';' +
    '  var params = null;' +
    '  for (var j = 0; j < items.length; j++) {' +
    '    var r = items[j].menuServiceItemRenderer;' +
    '    if (!r || !re.test(JSON.stringify(r.text || {}))) continue;' +
    '    var se = r.serviceEndpoint || r.navigationEndpoint || {};' +
    '    var m = se.moderateLiveChatEndpoint;' +
    // Some actions (e.g. Hide user) sit behind a confirm dialog — dig out the confirm button's endpoint
    '    if (!m && se.confirmDialogEndpoint) {' +
    '      var cd = se.confirmDialogEndpoint.content && se.confirmDialogEndpoint.content.confirmDialogRenderer;' +
    '      var cb = cd && cd.confirmButton && cd.confirmButton.buttonRenderer && cd.confirmButton.buttonRenderer.serviceEndpoint;' +
    '      if (cb) m = cb.moderateLiveChatEndpoint;' +
    '    }' +
    // Timeout opens a duration-picker dialog: six options (10s/1m/5m/10m/30m/24h), each
    // carrying its own pre-encoded moderate params — pick the closest to the requested duration
    '    if (!m && se.signalServiceEndpoint && se.signalServiceEndpoint.actions) {' +
    '      var acts = se.signalServiceEndpoint.actions;' +
    '      for (var a = 0; a < acts.length && !m; a++) {' +
    '        var dlg = acts[a].openPopupAction && acts[a].openPopupAction.popup && acts[a].openPopupAction.popup.showActionDialogRenderer;' +
    '        var content = (dlg && dlg.body && dlg.body.showActionDialogContentRenderer && dlg.body.showActionDialogContentRenderer.content) || [];' +
    '        var opts = [];' +
    '        for (var c = 0; c < content.length; c++) {' +
    '          var flds = (content[c].formRenderer && content[c].formRenderer.fields) || [];' +
    '          for (var f = 0; f < flds.length; f++) {' +
    '            var oi = (flds[f].optionsRenderer && flds[f].optionsRenderer.items) || [];' +
    '            for (var o = 0; o < oi.length; o++) {' +
    '              var os = oi[o].optionSelectableItemRenderer;' +
    '              var mp = os && os.submitEndpoint && os.submitEndpoint.moderateLiveChatEndpoint;' +
    '              if (mp && mp.params) opts.push(mp.params);' +
    '            }' +
    '          }' +
    '        }' +
    '        if (opts.length) {' +
    '          var durs = [10, 60, 300, 600, 1800, 86400];' +
    '          var want = ' + wantSecs + ';' +
    '          var best = 0;' +
    '          for (var b = 1; b < durs.length; b++) {' +
    '            if (Math.abs(Math.log(durs[b] / want)) < Math.abs(Math.log(durs[best] / want))) best = b;' +
    '          }' +
    '          if (best >= opts.length) best = opts.length - 1;' +
    '          m = { params: opts[best] };' +
    '        }' +
    '      }' +
    '    }' +
    '    if (m && m.params) { params = m.params; break; }' +
    '  }' +
    '  if (!params) {' +
    '    var labels = items.map(function(it) {' +
    '      var rr = it.menuServiceItemRenderer || it.menuNavigationItemRenderer || {};' +
    '      var t = rr.text || {};' +
    '      return t.simpleText || (t.runs ? t.runs.map(function(x) { return x.text; }).join("") : Object.keys(it).join("+"));' +
    '    }).join(" | ");' +
    '    return { error: "Action not in menu. Offered: [" + labels + "]" };' +
    '  }' +
    '  var modResp = await fetch("/youtubei/v1/live_chat/moderate?prettyPrint=false&key=" + encodeURIComponent(key),' +
    '    { method: "POST", headers: headers, credentials: "include", body: JSON.stringify({ context: ctx, params: params }) });' +
    '  var modData = await modResp.json().catch(function() { return null; });' +
    '  if (!modResp.ok || (modData && modData.error)) return { error: "moderate HTTP " + modResp.status + ((modData && modData.error && modData.error.message) ? ": " + modData.error.message : "") };' +
    '  return { ok: true };' +
    '})()';
}

async function ytDeleteImpl({ msgId, authorId, text }) {
  if (!ytWin || ytWin.isDestroyed()) return { ok: false, error: 'YouTube not connected' };
  try {
    const safeId = (msgId || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const safeText = ((text || '').slice(0, 20)).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const safeAuthorId = (authorId || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');

    const findEl =
      '  el = document.querySelector("[data-sc-id=\\"' + safeId + '\\"]");' +
      '  if (!el) {' +
      '    var aId = "' + safeAuthorId + '", prefix = "' + safeText + '";' +
      '    var all = Array.from(document.querySelectorAll("yt-live-chat-text-message-renderer"));' +
      '    var cands = aId ? all.filter(function(m) { return (m.getAttribute("author-id")||m.getAttribute("data-author-id")||"") === aId; }) : all;' +
      '    for (var i = cands.length - 1; i >= 0; i--) {' +
      '      if ((cands[i].querySelector("#message")||cands[i]).textContent.trim().startsWith(prefix)) { el = cands[i]; break; }' +
      '    }' +
      '  }';

    const result = await ytExec(ytModerateScript(findEl, '/remove|supprimer/i', 'Message not found in chat'));

    if (result && result.ok) return { ok: true };
    return { ok: false, error: (result && result.error) || 'Delete failed' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

ipcMain.handle('yt:delete', (_, params) => ytDeleteImpl(params));

// Perform a moderation action (timeout / ban) on a user via the InnerTube API, using
// any of their visible messages as the entry point for the context menu.
async function ytModAction(channelId, actionLabel, timeoutSeconds) {
  if (!ytWin || ytWin.isDestroyed()) return { ok: false, error: 'YouTube not connected' };
  try {
    const safeId = channelId.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const actionPatterns = {
      timeout: '/timeout|bloquer temporairement/i',
      ban: '/hide user|masquer l.utilisateur/i',
    };
    const actionRe = actionPatterns[actionLabel.toLowerCase()];
    if (!actionRe) return { ok: false, error: 'Unknown mod action: ' + actionLabel };

    const findEl =
      '  var msgs = document.querySelectorAll("yt-live-chat-text-message-renderer");' +
      '  for (var i = msgs.length - 1; i >= 0; i--) {' +
      '    if ((msgs[i].getAttribute("author-id")||msgs[i].getAttribute("data-author-id")||"") === "' + safeId + '") { el = msgs[i]; break; }' +
      '  }';

    const result = await ytExec(ytModerateScript(findEl, actionRe, 'User not found in current chat — they must have a visible message', timeoutSeconds));

    if (result && result.ok) return { ok: true };
    return { ok: false, error: (result && result.error) || actionLabel + ' failed' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

ipcMain.handle('yt:timeout', async (_, { channelId, duration }) => {
  // Duration snaps to the closest of YouTube's native intervals: 10s/1m/5m/10m/30m/24h
  return ytModAction(channelId, 'timeout', duration);
});

ipcMain.handle('yt:ban', async (_, channelId) => {
  return ytModAction(channelId, 'ban');
});

ipcMain.handle('yt:getEmotes', async () => {
  if (!ytWin || ytWin.isDestroyed()) return { ok: false, error: 'YouTube not connected' };
  try {
    const emotes = await ytExec(
      '(async function() {' +
      '  var emojiBtn = document.querySelector(' +
      '    "#picker-buttons yt-icon-button, button#emoji-picker-button," +' +
      '    "yt-live-chat-message-input-renderer #picker-buttons button"' +
      '  );' +
      '  if (!emojiBtn) return [];' +
      '  emojiBtn.click();' +
      '  await new Promise(function(r) { setTimeout(r, 800); });' +
      '  var results = [];' +
      '  var seen = new Set();' +
      '  var items = document.querySelectorAll(' +
      '    "yt-emoji-picker-renderer yt-emoji-icon-renderer," +' +
      '    "yt-live-chat-emoji-picker-entity-view-model img," +' +
      '    "yt-emoji-picker-renderer img"' +
      '  );' +
      '  items.forEach(function(el) {' +
      '    var img = el.tagName === "IMG" ? el : el.querySelector("img");' +
      '    if (!img) return;' +
      '    var src = img.src || img.dataset.src || "";' +
      '    if (!src || !src.startsWith("http")) return;' +
      '    var name = img.alt || el.getAttribute("aria-label") ||' +
      '               (el.closest("[aria-label]") && el.closest("[aria-label]").getAttribute("aria-label")) || "";' +
      '    if (!name || seen.has(name)) return;' +
      '    seen.add(name);' +
      '    results.push({ name: name.replace(/^:|:$/g, ""), url: src });' +
      '  });' +
      '  emojiBtn.click();' +
      '  return results;' +
      '})()'
    );
    return { ok: true, emotes };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('yt:showWindow', async () => {
  if (!ytWin || ytWin.isDestroyed()) return { ok: false, error: 'YouTube not connected' };
  ytWin.show();
  ytWin.focus();
  return { ok: true };
});

ipcMain.handle('yt:hideWindow', async () => {
  if (!ytWin || ytWin.isDestroyed()) return { ok: false, error: 'YouTube not connected' };
  ytWin.hide();
  return { ok: true };
});

ipcMain.handle('yt:getChannelName', async () => {
  if (!ytWin || ytWin.isDestroyed()) return { ok: false };
  try {
    const name = await ytExec(
      '(function() {' +
      '  var el = document.querySelector("#author-name, yt-live-chat-author-chip");' +
      '  return el ? el.textContent.trim() : "";' +
      '})()'
    );
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

// ═══════ STREAMELEMENTS SOCKET ═══════════════════════════════════════

const io = require('socket.io-client');
let seSocket = null;

function mapSEEvent(data) {
  const ts = Date.now();
  const d = data.data || {};
  const user = d.displayName || d.username || 'unknown';
  const userId = d.providerId || d.userId || '';
  const twId = data._id ? 'se_' + data._id : '';
  switch (data.type) {
    case 'follow':     return { twId, type: 'follow', user, userId, ts };
    case 'tip':        return { twId, type: 'tip', user, amount: d.amount, currency: d.currency, message: d.message, ts };
    case 'cheer':      return { twId, type: 'cheer', user, amount: d.amount, message: d.message, ts };
    case 'subscriber': {
      if (d.gifted && d.sender) return { twId, type: 'gift_sub', user: d.sender, userId, recipient: user, tier: d.tier, ts };
      if ((d.month || 0) > 1 || (d.streak || 0) > 1) return { twId, type: 'resub', user, userId, months: d.month || d.streak, tier: d.tier, message: d.message, ts };
      return { twId, type: 'sub', user, userId, tier: d.tier, ts };
    }
    case 'raid':       return { twId, type: 'raid', user, userId, count: d.amount, ts };
    case 'host':       return { twId, type: 'host', user, userId, count: d.amount, ts };
    case 'redemption': return { twId, type: 'redeem', user, userId, reward: (typeof d.redemption==='string'?d.redemption:'')||d.message||'', input: d.userInput||'', ts };
    default:           return null;
  }
}

ipcMain.handle('se:connect', (_, jwt) => {
  if (seSocket) { seSocket.disconnect(); seSocket = null; }
  if (!jwt) return;
  seSocket = io('https://realtime.streamelements.com', { transports: ['websocket'] });
  seSocket.on('connect', () => { console.log('[SE] Socket connected, authenticating...'); seSocket.emit('authenticate', { method: 'jwt', token: jwt }); });
  seSocket.on('authenticated', (authData) => {
    console.log('[SE] Socket authenticated, channel:', authData.channelId);
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('se:channelId', authData.channelId);
  });
  seSocket.on('event', (data) => {
    const alert = mapSEEvent(data);
    if (alert && mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('se:alert', alert);
  });
  seSocket.on('unauthorized', (err) => console.warn('[SE] Unauthorized:', err?.message || err));
  seSocket.on('connect_error', (e) => console.warn('[SE] connect error:', e.message));
});

ipcMain.handle('se:disconnect', () => {
  if (seSocket) { seSocket.disconnect(); seSocket = null; }
});

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

