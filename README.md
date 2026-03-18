# Stream Chat

A desktop app that combines Twitch and YouTube live chat into a single interface, with moderation tools, channel management commands, and an OBS overlay.

---

## Table of Contents

- [Installation](#installation)
- [Setup](#setup)
  - [Firebase](#firebase)
  - [Twitch](#twitch)
  - [YouTube](#youtube)
  - [Broadcaster Token](#broadcaster-token)
  - [OBS Overlay](#obs-overlay)
- [Features](#features)
  - [Chat](#chat)
  - [Moderation](#moderation)
  - [Community Panel](#community-panel)
  - [Commands Panel](#commands-panel)
  - [OBS Overlay](#obs-overlay-1)
- [Building from Source](#building-from-source)

---

## Installation

1. Go to [Releases](https://github.com/AnimeGrils/stream-chat/releases) and download the latest `Stream.Chat.Setup.x.x.x.exe`
2. Run the installer. Windows may show a "Windows protected your PC" warning — click **More info** then **Run anyway**
3. The app will open automatically after installing

To update from a previous version, open the app and click **Check for Updates** in the settings panel.

---

## Setup

Open Settings with the gear icon (top right).

### Firebase

Firebase is used to sync message deletions across multiple instances of the app (e.g. streamer + mods both see the same messages removed).

1. Go to [console.firebase.google.com](https://console.firebase.google.com) and sign in with a Google account
2. Click **Create a project**, give it a name, and click through the setup (you can disable Google Analytics when prompted — it isn't needed)
3. Once inside the project, click **Databases & Storage → Realtime Database** in the left sidebar, then **Create Database**
4. Choose a server location, select **Start in locked mode**, and click **Enable**
5. Click **Rules** at the top of the Realtime Database page and replace the existing content with:
```json
{
  "rules": {
    "stream-chat": {
      "deleted": { ".read": true, ".write": true }
    }
  }
}
```

6. Click **Publish**
7. Click **Data** at the top — copy the URL just below the tabs (looks like `https://your-project-default-rtdb.firebaseio.com`). This is your **Database URL**
8. Click the **settings** in the left sidebar → **General**
9. Scroll down to **Your apps** and click the **</>** (Web) icon
10. Give the app a nickname, click **Register app**, and ignore the remaining setup steps shown
11. In the config block that appears, copy the **apiKey** value. This is your **API Key**
12. Paste the **Database URL** and **API Key** into the matching fields in the Stream Chat app

### Twitch

1. Enter your **Channel Name** (the channel whose chat you want to read/moderate)
2. Go to [dev.twitch.tv/console/apps](https://dev.twitch.tv/console/apps) and create a new application
   - Set **OAuth Redirect URL** to `http://localhost`
   - Category: **Chat Bot**
   - Client Type: **Public**
3. Copy the **Client ID** and paste it into the **Client ID** field in Settings
4. Click **Get Twitch Token** — a browser window will open to Twitch's login page
5. Log in with your account (mod or streamer account)
6. After authorizing, you will be redirected to a "This site can't be reached" page — copy the full URL from the address bar and paste it into the **Twitch Token** field. The token will be extracted automatically.
7. Click **Open as Streamer** or **Open as Mod** to connect

### YouTube

No API key or developer account needed.

1. Enter your YouTube channel handle (`@channelname`), channel ID, or a live stream URL in the **YouTube Channel** field
2. Click **Connect YouTube** at the top of the app
3. A Chrome window will open in the background — log in to your Google account if prompted (only required once, login persists between sessions)
4. The YouTube stream must be live for the connection to succeed. If the stream isn't live, the Chrome tab will close automatically.
5. Use **Show Window** / **Hide Window** to bring the Chrome tab on or offscreen. It must remain open for YouTube chat to function.

### Broadcaster Token

The broadcaster token allows mods to create polls, predictions, and edit stream info without logging in as the streamer. It cannot be used to send messages or perform any other actions.

**Streamer setup:**
1. Click **Get Broadcaster Token** in Settings and log in with the **streamer's** Twitch account
2. Paste the redirect URL into the **Broadcaster Token** field
3. Share the token with trusted mods

**What it unlocks:**
- Create and manage polls
- Create and manage predictions
- Edit stream title and category
- Show moderators and VIPs in the Community panel

### OBS Overlay

The overlay is a browser source that displays chat messages in OBS. It respects the stream delay and removes deleted messages automatically.

1. Make sure Stream Chat is running
2. In OBS, add a **Browser Source**
3. Set the URL to `http://localhost:3899`
4. To change font size, append `?size=20` to the URL (default is 15) or use the Stream App **Font Size** input

The overlay displays Twitch and YouTube messages with emotes (including 7TV global and channel emotes), badges, and usernames. Messages only appear after the configured delay has passed, matching what the streamer sees.

---

## Features

### Chat

**Dual platform** — Twitch and YouTube messages appear in a single unified feed, color-coded by platform.

**Chat delay** — Set a delay in seconds at the top left of chat. All incoming messages are held for that duration before appearing, keeping the chat view in sync with what viewers see on stream.

**Emotes** — Twitch emotes (global and channel), 7TV emotes (global and channel), and YouTube emotes are all rendered inline.

**Emote picker** — Click the emote button (smiley face) next to the chat input to browse and insert emotes. Supports search.

**Autocomplete:**
- Type `:` followed by letters to autocomplete emote names
- Type `@` to autocomplete usernames from recent chat
- Type `/` to bring up a list of channel commands (see Commands Panel)

**Timestamps** — Each message shows a timestamp.

**Streamer / Mod mode** — Select your mode when connecting. Streamer mode shows chat without delay for the broadcaster's view; Mod mode applies the configured delay. Can be swapped in the top left of chat.

### Moderation

**Right-click a message** to open the context menu:

| Action | Description |
|---|---|
| **Reply** | Quote the message and reply |
| **View profile** | Open the chatter's profile panel (see below) |
| **Delete message** | Delete a single message |

**Click a username** in chat to open the chatter's profile panel directly.

The profile panel shows the user's account info, follow date, and subscription status, and has buttons for all moderation actions:

| Action | Description |
|---|---|
| **Warn** | *(Twitch)* Send an official warning |
| **Timeout** | Temporarily time out the user (choose duration) |
| **Untimeout** | Remove an active timeout |
| **Ban** | Permanently ban the user |
| **Unban** | Remove a ban |

Deleted and timed-out messages are removed from the chat view and from the OBS overlay. On YouTube, deletions are synced to other connected instances of the app via Firebase.

### Community Panel

Click the **👥** button (top right of chat) to open the Community panel, which shows everyone currently in the chat.

Twitch chatters are grouped by role:

| Group | Description |
|---|---|
| **Broadcaster** | The channel owner |
| **Moderators** | Requires the broadcaster token to be set (see [Broadcaster Token](#broadcaster-token)) |
| **VIPs** | Requires the broadcaster token to be set |
| **Viewers** | Everyone else |

YouTube chatters appear in a separate section below.

**Click any username** in the panel to open their profile.

### Commands Panel

Click the **⚡** button next to the chat input, or type `/` to open the commands list.

**Broadcaster commands** *(require broadcaster token)*

| Command | Description |
|---|---|
| `/poll` | Create a viewer poll with up to 5 options |
| `/managepoll` | End or archive the current active poll |
| `/prediction` | Start a channel points prediction |
| `/managepred` | Resolve or cancel the active prediction |
| `/streaminfo` | Edit the stream title and game/category |

**Mod commands**

| Command | Description |
|---|---|
| `/announce` | Send a highlighted announcement in chat (choose color) |
| `/shoutout` | Send an official Twitch shoutout to a channel |
| `/chatmodes` | Toggle slow mode, subscriber-only, emote-only, or follower-only mode |

**Streamer only**

| Command | Description |
|---|---|
| `/raid` | Raid another channel (requires streamer's Twitch token) |

### OBS Overlay

See [OBS Overlay setup](#obs-overlay) above. The overlay shows:

- Twitch and YouTube messages
- Twitch badges (broadcaster, moderator, subscriber, VIP, etc.)
- Twitch emotes, 7TV emotes, and YouTube emotes
- Colored announcements with a 📣 badge
- Messages are automatically removed when deleted or timed out in the main app

---

## Building from Source

**Requirements:** Node.js v18+, Google Chrome installed

```bash
git clone https://github.com/AnimeGrils/stream-chat
cd stream-chat
npm install
npm start
```

**Build installers:**

```bash
npm run build:win    # Windows .exe
npm run build:mac    # macOS .dmg
npm run build:linux  # Linux AppImage
```

Output is placed in the `dist/` folder. When publishing a release, upload the `.exe`, `latest.yml`, and `.exe.blockmap` files so the in-app updater works.
