# VoiceKord 🎙

> Low-latency in-game voice communication for Windows gamers. Built with Electron + WebRTC.

---

## 🗂 Project Structure

```
voicekord/
├── backend/          ← Node.js signaling + auth server
│   ├── .env          ← Your credentials (copy from .env.example)
│   ├── server.js
│   └── src/
│       ├── auth.js       (JWT + Google OAuth)
│       ├── rooms.js      (room registry)
│       └── signaling.js  (WebSocket WebRTC relay)
└── desktop/          ← Electron app
    ├── main.js           (main process)
    ├── preload.js        (IPC bridge)
    └── src/
        ├── index.html    (3-view SPA)
        ├── overlay.html  (in-game overlay)
        ├── styles/main.css
        └── js/
            ├── app.js    (router, state)
            ├── auth.js   (login/register/Google)
            ├── voice.js  (WebRTC engine)
            └── room.js   (room UI)
```

---

## ⚙️ Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| Node.js | 18+ | https://nodejs.org |
| npm | 9+ | (comes with Node.js) |

---

## 🔑 Step 1 — Get Google OAuth Credentials

> Skip this if you only want username/password auth. The app works without Google OAuth.

### 1.1 Create a Google Cloud Project
1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Click the project dropdown at the top → **New Project**
3. Name it `VoiceKord` → **Create**

### 1.2 Configure the OAuth Consent Screen
1. In the left sidebar → **APIs & Services → OAuth consent screen**
2. Select **External** → **Create**
3. Fill in:
   - **App name**: VoiceKord
   - **User support email**: your email
   - **Developer contact email**: your email
4. Click **Save and Continue** through all steps (no scopes needed for Basic)
5. On **Test users** page, add your Google email address

### 1.3 Create OAuth 2.0 Credentials
1. **APIs & Services → Credentials → + Create Credentials → OAuth 2.0 Client ID**
2. **Application type**: `Web application`
3. **Name**: VoiceKord Local
4. **Authorized redirect URIs** → click **+ Add URI** → paste:
   ```
   http://localhost:3001/api/auth/google/callback
   ```
5. Click **Create**
6. A dialog shows your **Client ID** and **Client Secret** — copy both

### 1.4 Add Credentials to Backend
```bash
cd voicekord/backend
copy .env.example .env
```
Open `.env` and fill in:
```
GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-client-secret
JWT_SECRET=any-long-random-string-here
```

---

## 🚀 Step 2 — Start the Backend

```bash
cd voicekord/backend
npm install
npm start
```

You should see:
```
╔═══════════════════════════════════╗
║   🎙  VoiceKord Server v1.0.0     ║
║   Running on port 3001            ║
╚═══════════════════════════════════╝
  ✅  Google OAuth configured
```

---

## 🖥 Step 3 — Start the Desktop App

Open a **new terminal**:

```bash
cd voicekord/desktop
npm install
npm start
```

The VoiceKord app window will open.

---

## 🎮 Using the App

| Action | How |
|--------|-----|
| Login with Google | Click **Continue with Google** on login screen |
| Login with password | Enter username + password → **Sign In** |
| Register | Switch to **Register** tab → create account |
| Join a room | Type room name or click a Quick Join button |
| Mute mic | Click **Mute** button or press `CapsLock` |
| Deafen | Click **Deafen** button |
| Toggle overlay | Press `F9` or click the ⊡ icon |
| Leave room | Click **Leave** (📴) button |

---

## 🔧 Hotkeys

| Key | Action |
|-----|--------|
| `F9` | Toggle in-game overlay |
| `V` | Toggle mute/unmute |

---

## 🏗 Architecture

```
Game PC
├── VoiceKord Desktop (Electron)
│   ├── Renderer: HTML/CSS/JS + WebRTC
│   └── Main: global shortcuts, overlay window, OAuth
│
└── VoiceKord Backend (Node.js)
    ├── REST API: /api/login  /api/register  /api/auth/google
    ├── WebSocket: /ws  (WebRTC signaling)
    └── Rooms: in-memory peer registry

WebRTC P2P: Direct UDP between peers (via STUN)
Audio: getUserMedia → Opus codec → RTCPeerConnection
```

---

## 🛠 Development

### Run backend with auto-reload
```bash
cd backend && npm run dev
```

### Open DevTools in Electron
```bash
cd desktop && npm run dev  # passes --dev flag, opens DevTools automatically
```

### Build distributable installer
```bash
cd desktop && npm run build
# Output: desktop/dist/VoiceKord Setup x.x.x.exe
```

---

## 🔒 Security Notes

- Passwords are hashed with **bcrypt** (cost factor 10)
- JWTs expire after **24 hours**
- Google OAuth uses **PKCE** flow (via Passport.js)
- WebRTC audio is encrypted with **DTLS-SRTP** by default
- Never commit your `.env` file — it's in `.gitignore`

---

## 🗺 Roadmap

- [x] Phase 0: MVP — voice chat, P2P WebRTC
- [x] Phase 1: Auth — Google OAuth + JWT password
- [x] Phase 2: In-game overlay (transparent always-on-top)
- [ ] Phase 3: SFU for large rooms (>4 players)
- [ ] Phase 4: Friends & invite system
- [ ] Phase 5: AI noise suppression (RNNoise)
- [ ] Phase 6: Android app (Kotlin, same backend)
