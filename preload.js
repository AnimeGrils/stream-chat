const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {

  // ── Utilities ────────────────────────────────────────────────────
  openExternal: (url) => ipcRenderer.invoke('open:external', url),

  // ── Updates ──────────────────────────────────────────────────────
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  getAutoUpdateEnabled: () => ipcRenderer.invoke('update:getAutoEnabled'),
  setAutoUpdateEnabled: (v) => ipcRenderer.invoke('update:setAutoEnabled', v),
  onUpdateStatus: (cb) => ipcRenderer.on('update:status', (_, data) => cb(data)),
  getYoutubeEmotes: () => ipcRenderer.invoke('yt:getEmotes'),

  // ── OAuth ─────────────────────────────────────────────────────────
  loginTwitch: (params) => ipcRenderer.invoke('tw:login', params),
  loginYoutubeOAuth: (params) => ipcRenderer.invoke('yt:loginOAuth', params),

  // ── YouTube scraper ───────────────────────────────────────────────

  // Open a Puppeteer-controlled YouTube chat window for a given URL/channel
  openYoutubeChat: (url) => ipcRenderer.invoke('yt:open', url),

  // Close the YouTube chat scraper
  closeYoutubeChat: () => ipcRenderer.invoke('yt:close'),

  // Bring the YouTube Chrome window on-screen / send it back off
  showYoutubeWindow: () => ipcRenderer.invoke('yt:showWindow'),
  hideYoutubeWindow: () => ipcRenderer.invoke('yt:hideWindow'),

  // Send a message to YouTube chat
  sendYoutubeMessage: (text) => ipcRenderer.invoke('yt:send', text),

  // Delete a YouTube chat message by internal ID
  deleteYoutubeMessage: (params) => ipcRenderer.invoke('yt:delete', params),
  debugYoutube: () => ipcRenderer.invoke('yt:debug'),

  // Timeout a YouTube user (channelId, durationSeconds)
  timeoutYoutubeUser: (channelId, duration) => ipcRenderer.invoke('yt:timeout', { channelId, duration }),

  // Ban a YouTube user by channelId
  banYoutubeUser: (channelId) => ipcRenderer.invoke('yt:ban', channelId),

  // Get the current YouTube channel name (logged-in user)
  getYoutubeChannelName: () => ipcRenderer.invoke('yt:getChannelName'),

  // ── Listeners (main → renderer) ───────────────────────────────────

  // Called when a new YouTube chat message arrives
  onYoutubeMessage: (cb) => {
    ipcRenderer.on('yt:message', (_, msg) => cb(msg));
  },

  // Called when YouTube connection status changes
  onYoutubeStatus: (cb) => {
    ipcRenderer.on('yt:status', (_, status) => cb(status));
  },

  // Called when a YouTube message is detected as deleted via DOM observation
  onYoutubeDeleted: (cb) => {
    ipcRenderer.on('yt:deleted', (_, id) => cb(id));
  },

  // Remove all listeners (cleanup)
  removeAllListeners: () => {
    ipcRenderer.removeAllListeners('yt:message');
    ipcRenderer.removeAllListeners('yt:status');
    ipcRenderer.removeAllListeners('yt:deleted');
  },

  // ── Overlay ───────────────────────────────────────────────────────
  overlayMsg: (data) => ipcRenderer.send('overlay:msg', data),
});
