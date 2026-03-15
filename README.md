# Stream Chat — Desktop App

## Setup

1. Install [Node.js](https://nodejs.org) (v18 or later)
2. Install dependencies:
   ```
   npm install
   ```
3. Run the app:
   ```
   npm start
   ```

## Build installer

```
npm run build:win   # Windows .exe
npm run build:mac   # macOS .dmg
npm run build:linux # Linux AppImage
```

## YouTube Connection

- No API key or OAuth needed
- Click **Connect YouTube** after entering your channel/URL
- A Chrome window will open — log in to Google if prompted (only needed once)
- Chrome login persists between app restarts

## Firebase Rules

Update your Firebase rules to include the YouTube bridge paths:

```json
{
  "rules": {
    "stream-chat": {
      "deleted":   { ".read": true, ".write": true },
      "yt-msgs":   { ".read": true, ".write": true },
      "yt-leader": { ".read": true, ".write": true }
    }
  }
}
```
