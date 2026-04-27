# SpatialReal Persona Demo — "Ava"

A full-stack voice-avatar demo. You speak, Ava listens, thinks, and speaks back — with full lip-sync on a 3D avatar.

```
Browser mic (PCM16 @ 16 kHz)
       ↓  WebSocket stream
Cartesia Ink STT  ──or──  Bodhi ASR
       ↓  transcript
DeepSeek Chat (LLM)  →  AI reply text
       ↓
Cartesia Sonic-2 TTS  ──or──  ElevenLabs  ──or──  OpenAI TTS
       ↓  raw PCM16 @ 16 kHz
SpatialReal AvatarKit  →  lip-synced 3D avatar
       ↓
User sees + hears "Ava" respond
```

---

## Requirements

| Dependency | Purpose | Notes |
|---|---|---|
| Node.js 18+ | Runtime | Required |
| SpatialReal account | 3D avatar | API Key + App ID + Avatar ID |
| Cartesia account | TTS + STT | Free tier: 20K credits/month |
| DeepSeek account | LLM brain | Fast, cheap, OpenAI-compatible |
| ElevenLabs *(optional)* | TTS alternative | Falls back automatically |
| OpenAI *(optional)* | TTS fallback | Used if others fail |
| Bodhi/Navana *(optional)* | Indian-language STT | Alternative to Cartesia STT |
| LiveKit *(optional)* | RTC room | For multi-party or RTC mode |

---

## Quick Start

### 1. Install dependencies

```bash
npm run install:all
```

### 2. Configure environment

```bash
cp .env.example .env
```

Fill in `.env`:

```env
# Avatar (required)
SPATIALREAL_API_KEY=sk_...
SPATIALREAL_APP_ID=your_app_id
SPATIALREAL_AVATAR_ID=your_avatar_id
SPATIALREAL_CONSOLE_ENDPOINT=https://console.us-west.spatialwalk.cloud/v1/console

# LLM — DeepSeek (recommended)
DEEPSEEK_API_KEY=sk-...

# TTS — Cartesia (primary)
CARTESIA_API_KEY=sk_car_...
CARTESIA_VOICE_ID=694f9389-aac1-45b6-b726-9d9369183238

# STT — Cartesia Ink (recommended) or Bodhi
STT_PROVIDER=cartesia

# Client env (required — same values as above)
VITE_SPATIALREAL_APP_ID=your_app_id
VITE_SPATIALREAL_AVATAR_ID=your_avatar_id
```

### 3. Start dev server

```bash
npm run dev
```

- Backend → http://localhost:3001
- Frontend → http://localhost:5173

### 4. Use the demo

1. Open http://localhost:5173
2. Click **Initialize** → loads the 3D avatar
3. Click **Start Service** → opens the avatar WebSocket
4. Click **Talk to Ava** → mic opens, speak naturally
5. Ava hears, thinks, and speaks back with lip-sync

---

## Project Structure

```
├── server/
│   └── server.js          # Express + WebSocket voice session server
├── client/
│   └── src/
│       ├── main.ts        # Entry point
│       ├── app.ts         # UI · mic capture · SpatialReal SDK lifecycle
│       ├── api.ts         # Fetch wrappers for all backend routes
│       └── style.css      # Dark UI
├── .env
├── .env.example
└── package.json           # Root scripts (dev, install:all)
```

---

## Architecture Detail

### Voice Session (WebSocket `/ws/voice-session`)

```
Browser                         Server
  │                               │
  │── {type: "start"} ──────────►│  opens STT WebSocket (Cartesia or Bodhi)
  │── {type: "audio", data: b64}─►│  streams PCM chunks to STT
  │◄─ {type: "partial", text}─────│  interim transcript
  │◄─ {type: "status", state}─────│  listening / thinking / speaking
  │◄─ {type: "response",          │  final reply: text + base64 PCM audio
  │     text, audioBase64} ───────│
  │── {type: "interrupt"} ───────►│  abort current LLM/TTS call
  │── {type: "end"} ────────────►│  close session
```

### SpatialReal Avatar Lifecycle (client)

Per the [lifecycle docs](https://docs.spatialreal.ai/concepts/lifecycle), the correct sequence is:

```ts
// 1. Initialize SDK (once at startup)
await AvatarSDK.initialize(appId, {
  environment: Environment.intl,
  drivingServiceMode: DrivingServiceMode.sdk,
  audioFormat: { channelCount: 1, sampleRate: 16000 },
});

// 2. Authenticate
AvatarSDK.setSessionToken(token);

// 3. Load avatar assets
const avatar = await AvatarManager.shared.load(avatarId);

// 4. Render
const view = new AvatarView(avatar, container);

// 5. Start service (must be inside a user-gesture handler)
await view.controller.initializeAudioContext();  // once only
await view.controller.start();

// 6. Send audio after connection is established
view.controller.send(pcmChunk, /* isLast */ false);
view.controller.send(pcmChunk, /* isLast */ true);
```

### TTS Fallback Chain

| Priority | Provider | Format | Notes |
|---|---|---|---|
| 1 | Cartesia Sonic-2 | raw PCM16 @ 16 kHz | No conversion needed |
| 2 | ElevenLabs | raw PCM16 @ 16 kHz | No conversion needed |
| 3 | OpenAI TTS | MP3 → PCM16 via ffmpeg | Requires ffmpeg |
| — | Browser fallback | Web Audio API | Avatar won't animate |

### LLM Fallback Chain

| Priority | Provider | Model |
|---|---|---|
| 1 | DeepSeek | `deepseek-chat` (default) |
| 2 | TokenRouter | `gpt-4o-mini` |
| 3 | OpenAI | `gpt-4o-mini` |
| — | Hardcoded replies | keyword-matched |

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Avatar loads but doesn't speak | Audio not reaching controller | Click **Start Service** before talking; ensure avatar WebSocket shows `connected` in console |
| `send() returned null` in console | Avatar WebSocket not connected | Check SpatialReal credentials; look for `onConnectionState: failed` in console |
| No transcript appears | STT not configured | Set `STT_PROVIDER=cartesia` and verify `CARTESIA_API_KEY` |
| `Cartesia STT error` | Wrong API version or key | Verify key; default Cartesia version is `2025-04-16` |
| Mic permission denied | Browser blocking mic | Allow mic in browser address bar; use localhost or HTTPS |
| No audio at all | TTS providers all failing | Check `CARTESIA_API_KEY`, `ELEVENLABS_API_KEY`, or `OPENAI_API_KEY` in server logs |
| LLM using fallback replies | No LLM key set | Add `DEEPSEEK_API_KEY` to `.env` |

---

## Environment Variables Reference

### Required

| Variable | Description |
|---|---|
| `SPATIALREAL_API_KEY` | SpatialReal API key |
| `SPATIALREAL_APP_ID` | SpatialReal App ID |
| `SPATIALREAL_AVATAR_ID` | Avatar ID to load |
| `VITE_SPATIALREAL_APP_ID` | Same as above (Vite exposes to browser) |
| `VITE_SPATIALREAL_AVATAR_ID` | Same as above (Vite exposes to browser) |

### LLM (choose one)

| Variable | Description |
|---|---|
| `DEEPSEEK_API_KEY` | DeepSeek API key — **recommended** |
| `OPENAI_API_KEY` | OpenAI API key (also used for TTS fallback) |
| `TOKENROUTER_API_KEY` | TokenRouter key (LLM routing) |
| `LLM_MODEL` | Override model name (e.g. `deepseek-reasoner`) |

### TTS

| Variable | Description |
|---|---|
| `CARTESIA_API_KEY` | Cartesia API key — **recommended** |
| `CARTESIA_VOICE_ID` | Cartesia voice ID |
| `ELEVENLABS_API_KEY` | ElevenLabs API key (fallback) |
| `ELEVENLABS_VOICE_ID` | ElevenLabs voice ID |

### STT

| Variable | Description |
|---|---|
| `STT_PROVIDER` | `cartesia` or `bodhi` |
| `CARTESIA_STT_MODEL` | Cartesia STT model (default: `ink-whisper`) |
| `BODHI_API_KEY` | Bodhi ASR key (if using Bodhi) |
| `BODHI_CUSTOMER_ID` | Bodhi customer ID |
| `BODHI_MODEL` | Bodhi model (e.g. `en-general-v2-8khz`) |

### Optional

| Variable | Description |
|---|---|
| `SPATIALREAL_CONSOLE_ENDPOINT` | Token endpoint URL (default: US West) |
| `LIVEKIT_URL` | LiveKit server URL |
| `LIVEKIT_API_KEY` | LiveKit API key |
| `LIVEKIT_API_SECRET` | LiveKit API secret |
| `PORT` | Server port (default: `3001`) |

---

## Docs

- SpatialReal: https://docs.spatialreal.ai/overview/introduction
- SpatialReal Lifecycle: https://docs.spatialreal.ai/concepts/lifecycle
- Cartesia: https://docs.cartesia.ai/get-started/overview
- DeepSeek API: https://platform.deepseek.com/api-docs
- ElevenLabs: https://elevenlabs.io/docs
- Bodhi/Navana: https://navana.gitbook.io/bodhi
