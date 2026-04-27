# Bodhi + SpatialReal Integration Plan

## What Bodhi Is

**Bodhi** (by Navana.ai) is a multilingual voice AI platform built for Indian languages. It provides:
- **Streaming ASR** — real-time speech-to-text via WebSocket
- **10+ Indian languages** + 40+ dialects (Hindi, Tamil, Kannada, Bengali, etc.)
- **Code-switching support** — handles Hinglish and other mixed-language speech
- **Audio Intelligence API** — sentiment, intent, keyword extraction

**Docs**: https://navana.gitbook.io/bodhi  
**GitHub**: https://github.com/navana-tech/bodhi-streaming-asr-node-example

---

## Bodhi ASR API Summary

| Detail | Value |
|---|---|
| **Endpoint** | `wss://bodhi.navana.ai` |
| **Auth** | `x-api-key` + `x-customer-id` headers (WebSocket handshake) |
| **Audio In** | 16-bit PCM, mono, ≥8000 Hz |
| **Chunk Size** | 50–500 ms (recommended: 100 ms) |
| **Config Message** | `{"config": {"sample_rate": 8000, "transaction_id": "uuid", "model": "en-general-v2-8khz"}}` |
| **Response** | `{"call_id": "...", "segment_id": "...", "type": "partial|complete", "text": "...", "eos": false}` |
| **End Signal** | `{"eof": 1}` |

**Available Models** (relevant ones):
- `en-general-v2-8khz` — English (India)
- `en-banking-v2-8khz` — English banking domain
- `hi-general-v2-8khz` — Hindi (+ English code-switching)
- `ta-general-v2-8khz` — Tamil (+ English code-switching)
- `kn-general-v2-8khz` — Kannada (+ English code-switching)

---

## Integration Architecture

Because **browsers cannot set custom headers on WebSocket connections**, we route Bodhi through our backend to keep API keys secure.

```
┌─────────────┐      ┌─────────────────┐      ┌──────────────┐
│   Browser   │─────▶│  Our Backend    │─────▶│ Bodhi ASR    │
│  (Capture   │ WS   │  (Express + WS) │ WS   │ (Navana.ai)  │
│   mic PCM)  │      │                 │      │              │
└─────────────┘      └─────────────────┘      └──────────────┘
                            │
                            ▼
                     ┌──────────────┐
                     │  OpenAI LLM  │
                     │  + TTS       │
                     └──────────────┘
                            │
                            ▼
                     ┌──────────────┐
                     │ SpatialReal  │
                     │   Avatar     │
                     └──────────────┘
```

### Full Flow (One Voice Turn)

1. **User holds mic button** → browser captures raw PCM16 mono 16kHz from `getUserMedia`
2. **Browser resamples** → down to 8kHz (Bodhi's sweet spot) and chunks to 100ms packets
3. **Browser streams** → WebSocket to our backend (`/ws/voice-session`)
4. **Backend forwards** → opens WebSocket to `wss://bodhi.navana.ai` with `x-api-key` + `x-customer-id`
5. **Backend sends config** → `{config: {sample_rate: 8000, model: "en-general-v2-8khz", transaction_id}}`
6. **Backend forwards audio chunks** → as they arrive from browser
7. **Bodhi returns transcripts** → `type: "partial"` (live) and `type: "complete"` (final per segment)
8. **Backend detects silence/end** → sends `{"eof": 1}` to Bodhi, collects final transcript
9. **Backend calls LLM** → sends transcript to OpenAI GPT-4o-mini with persona prompt
10. **Backend calls TTS** → OpenAI TTS returns MP3
11. **Backend converts** → ffmpeg MP3 → PCM16 mono 16kHz
12. **Backend sends** → `{type: "response", text: "...", audioPcmBase64: "..."}` over WebSocket
13. **Browser receives** → feeds PCM bytes to `avatarView.controller.send(pcmBytes, true)`
14. **Avatar speaks** → SpatialReal renders lip-synced animation

---

## Why This Architecture

| Approach | Pros | Cons |
|---|---|---|
| **Backend Proxy (chosen)** | API keys hidden; full orchestration; easy to add logging | Slightly more latency (~50-100ms) |
| Browser → Bodhi direct | Lower latency | Exposes API keys; custom headers impossible in browser WS |
| REST file upload | Simple; no WebSocket | Not real-time; higher latency per turn |

---

## Files to Change / Add

### Backend (`server/`)

| File | Change |
|---|---|
| `server.js` | Add WebSocket server (using `ws` npm package). Handle `/ws/voice-session` connections. Proxy to Bodhi. Orchestrate LLM + TTS. |
| `package.json` | Add `ws` dependency |
| `.env.example` | Add `BODHI_API_KEY`, `BODHI_CUSTOMER_ID`, `BODHI_MODEL` |

### Frontend (`client/src/`)

| File | Change |
|---|---|
| `app.ts` | Add mic button + `getUserMedia` audio capture. Add WebSocket client. Resample audio to 8kHz. Feed received PCM to avatar. |
| `style.css` | Add mic button styles, recording state animations |

---

## Audio Pipeline Details

### Browser Capture → Bodhi
- `getUserMedia` captures at **16 kHz** (browser default)
- We resample to **8 kHz** (Bodhi works best at 8kHz for the `-8khz` models)
- Chunk size: **100 ms** = 800 samples @ 8kHz = 1600 bytes (16-bit)
- Send chunks immediately over WS to backend

### Backend → SpatialReal
- OpenAI TTS returns **MP3 @ 24kHz**
- ffmpeg converts to **PCM16 mono 16kHz** (SpatialReal's default)
- Base64 encode and send over WS to browser

---

## State Machine (Backend per WebSocket Connection)

```
[connected]
   │
   ▼
[awaiting_audio] ◄── user starts talking
   │
   ▼
[streaming_to_bodhi] ──► forward chunks ──► collect partials
   │                                          │
   │                                          ▼
   │                                    [got_final_transcript]
   │                                          │
   │                                          ▼
   └──────────────────────────────────── [generating_response]
                                             │
                                             ▼
                                      [sending_pcm_to_client]
                                             │
                                             ▼
                                      [awaiting_audio] (loop)
```

---

## Error Handling

| Scenario | Action |
|---|---|
| Bodhi WS fails | Return `{type: "error", code: "bodhi_connection_failed"}` |
| No speech detected | Return `{type: "error", code: "no_speech"}` |
| OpenAI fails | Return `{type: "error", code: "llm_failed", fallbackText: "..."}` |
| SpatialReal not initialized | Browser plays browser TTS + shows text |

---

## Environment Variables (add to `.env`)

```env
# Bodhi ASR (Navana.ai)
BODHI_API_KEY=your_bodhi_api_key
BODHI_CUSTOMER_ID=your_bodhi_customer_id
BODHI_MODEL=en-general-v2-8khz
BODHI_ENDPOINT=wss://bodhi.navana.ai
```

---

## Demo Experience After Integration

1. User clicks **"Initialize Avatar"** → loads SpatialReal avatar
2. User clicks and **holds mic button** → "Listening..." animation
3. User speaks → sees live partial transcript from Bodhi
4. User releases mic → avatar thinks briefly → speaks the AI reply
5. Full loop: **Voice → Bodhi ASR → GPT-4o-mini → OpenAI TTS → SpatialReal Avatar**

---

## Optional Enhancements (Phase 2)

1. **VAD (Voice Activity Detection)** — auto-detect silence instead of hold-to-talk
2. **Interrupt** — while avatar is speaking, user can tap mic to interrupt
3. **Language Switching** — UI dropdown to switch Bodhi model (Hindi, Tamil, etc.)
4. **Bodhi Audio Intelligence** — after transcription, send to Bodhi sentiment API for emotion-aware responses

---

## Next Step

Approve this plan → I'll implement the full integration.
