import { AvatarSDK, AvatarManager, AvatarView, Environment, DrivingServiceMode, LogLevel } from '@spatialwalk/avatarkit';
import { Room, RoomEvent, Track, LocalAudioTrack } from 'livekit-client';
import { getToken, sendMessage, getHealth, getLiveKitToken } from './api';

let avatarView: AvatarView | null = null;
let isSdkInitialized = false;
let isServiceStarted = false;
let isAvatarConnected = false;
let isAvatarPlaying = false;
let isLoading = false;

// Persona state
let selectedPersona = 'ava';
type PersonaMeta = { id: string; name: string; tagline: string };
let personas: PersonaMeta[] = [];

// Conversation state
let isConversationActive = false;
let voiceWs: WebSocket | null = null;

// Mic capture state
let audioContext: AudioContext | null = null;
let mediaStream: MediaStream | null = null;
let scriptProcessor: ScriptProcessorNode | null = null;
let sourceNode: MediaStreamAudioSourceNode | null = null;
let micGainNode: GainNode | null = null;
let pcmBuffers: Int16Array[] = [];

// Audio send state
let cancelAudioSend: (() => void) | null = null;

// Fallback audio context (used when SpatialReal avatar can't play)
let fallbackAudioCtx: AudioContext | null = null;

// Streaming interval
let streamIntervalId: ReturnType<typeof setInterval> | null = null;

// LiveKit state
let livekitRoom: Room | null = null;
let isLiveKitConnected = false;
let livekitAudioTrack: LocalAudioTrack | null = null;

// Audio chunking constants (from official demo)
const PCM_CHUNK_SIZE = 32000;
const PCM_CHUNK_INTERVAL_MS = 80;

export async function initApp(container: HTMLElement) {
  renderUI(container);
  checkHealth();
  await loadPersonas();
}

function renderUI(container: HTMLElement) {
  container.innerHTML = `
    <div class="app voice-only">

      <div class="app-header">
        <div class="brand">
          <div class="brand-dot"></div>
          <span id="brand-name" class="brand-name">Ava</span>
          <span id="brand-sub" class="brand-sub">AI Guide</span>
        </div>
        <div id="status" class="status-badge">Connecting…</div>
      </div>

      <div id="persona-strip" class="persona-strip"></div>

      <div class="avatar-stage">
        <div class="avatar-card">
          <div id="avatar-container" class="avatar-container">
            <div class="avatar-placeholder">
              <div class="placeholder-icon">✦</div>
              <p>Click Initialize to load</p>
            </div>
          </div>
        </div>
        <div id="live-transcript" class="live-transcript"></div>
      </div>

      <div class="voice-controls">
        <div class="controls-main">
          <button id="init-btn"      class="btn primary">Initialize</button>
          <button id="start-btn"     class="btn primary"  disabled>Start Service</button>
          <button id="conv-btn"      class="btn accent"   disabled>🎙 Talk</button>
          <button id="interrupt-btn" class="btn danger"   disabled>Stop</button>
        </div>
        <div class="controls-extra">
          <button id="test-tone-btn"  class="btn secondary" disabled>Test Tone</button>
          <button id="test-voice-btn" class="btn secondary">Test Voice</button>
          <button id="lk-btn"         class="btn secondary" disabled>LiveKit</button>
        </div>
      </div>

    </div>
  `;

  const initBtn = document.getElementById('init-btn') as HTMLButtonElement;
  const startBtn = document.getElementById('start-btn') as HTMLButtonElement;
  const convBtn = document.getElementById('conv-btn') as HTMLButtonElement;
  const interruptBtn = document.getElementById('interrupt-btn') as HTMLButtonElement;
  const testToneBtn = document.getElementById('test-tone-btn') as HTMLButtonElement;
  const testVoiceBtn = document.getElementById('test-voice-btn') as HTMLButtonElement;
  const lkBtn = document.getElementById('lk-btn') as HTMLButtonElement;

  initBtn.addEventListener('click', onInitialize);
  startBtn.addEventListener('click', onStartService);
  convBtn.addEventListener('click', onToggleConversation);
  interruptBtn.addEventListener('click', onInterrupt);
  testToneBtn.addEventListener('click', onTestTone);
  testVoiceBtn.addEventListener('click', onTestVoice);
  lkBtn.addEventListener('click', onLiveKitToggle);
}

async function loadPersonas() {
  try {
    const res = await fetch('/api/personas');
    if (!res.ok) return;
    personas = await res.json();
    renderPersonaStrip();
  } catch {
    // personas unavailable — strip stays empty
  }
}

function renderPersonaStrip() {
  const strip = document.getElementById('persona-strip');
  if (!strip || personas.length === 0) return;
  strip.innerHTML = personas.map(p => `
    <button
      class="persona-btn${p.id === selectedPersona ? ' active' : ''}"
      data-persona="${p.id}"
    >${p.name}</button>
  `).join('');
  strip.querySelectorAll('.persona-btn').forEach(btn => {
    btn.addEventListener('click', () => selectPersona((btn as HTMLElement).dataset.persona!));
  });
}

function selectPersona(id: string) {
  if (isConversationActive) return; // don't switch mid-conversation
  selectedPersona = id;
  const p = personas.find(x => x.id === id);
  if (p) {
    (document.getElementById('brand-name') as HTMLElement).textContent = p.name;
    (document.getElementById('brand-sub') as HTMLElement).textContent = p.tagline;
  }
  renderPersonaStrip();
}

async function checkHealth() {
  try {
    const health = await getHealth();
    const statusEl = document.getElementById('status')!;
    const parts: string[] = [];
    if (health.spatialrealConfigured) parts.push('Avatar');
    if (health.cartesiaConfigured || health.openaiConfigured) parts.push('Voice');
    if (health.sttConfigured) parts.push('STT');
    if (health.openaiConfigured) parts.push('AI');
    if (health.livekitConfigured) parts.push('LiveKit');

    if (parts.length >= 3) {
      statusEl.textContent = parts.join(' · ');
      statusEl.className = 'status-badge ready';
    } else {
      statusEl.textContent = 'Add API keys to .env';
      statusEl.className = 'status-badge error';
    }

    if (health.livekitConfigured) {
      const lkBtn = document.getElementById('lk-btn') as HTMLButtonElement;
      if (lkBtn) lkBtn.disabled = false;
    }
  } catch {
    const statusEl = document.getElementById('status')!;
    statusEl.textContent = 'Server offline';
    statusEl.className = 'status-badge error';
  }
}

// ============================================================
// Initialize SDK + Load Avatar
// ============================================================
async function onInitialize() {
  if (isLoading || isSdkInitialized) return;
  isLoading = true;
  setStatus('Initializing SDK...');

  const btn = document.getElementById('init-btn') as HTMLButtonElement;
  btn.disabled = true;

  try {
    const appId = (import.meta.env.VITE_SPATIALREAL_APP_ID as string) || '';
    await AvatarSDK.initialize(appId, {
      environment: Environment.intl,
      drivingServiceMode: DrivingServiceMode.sdk,
      logLevel: LogLevel.warning,
      audioFormat: { channelCount: 1, sampleRate: 16000 },
    });

    setStatus('Fetching session token...');
    const { token } = await getToken();
    AvatarSDK.setSessionToken(token);

    const avatarId = (import.meta.env.VITE_SPATIALREAL_AVATAR_ID as string) || '';
    if (!avatarId) throw new Error('VITE_SPATIALREAL_AVATAR_ID not set');

    setStatus('Downloading avatar assets...');
    const avatar = await AvatarManager.shared.load(avatarId, (progress) => {
      if (progress.type === 'downloading' && typeof progress.progress === 'number') {
        setStatus(`Loading... ${Math.round(progress.progress * 100)}%`);
      }
    });

    const container = document.getElementById('avatar-container')!;
    container.innerHTML = '';
    container.style.width = '100%';
    container.style.height = '100%';

    avatarView = new AvatarView(avatar, container);

    avatarView.controller.onConnectionState = (state) => {
      console.log('[Avatar] Connection:', state);
      isAvatarConnected = state === 'connected';
      const statusEl = document.getElementById('status')!;
      if (state === 'connected') {
        statusEl.className = 'status-badge ready';
      } else if (state === 'failed' || state === 'disconnected') {
        isAvatarConnected = false;
        statusEl.className = 'status-badge error';
        if (state === 'failed') setStatus('Avatar connection failed — check credentials');
      }
    };
    avatarView.controller.onConversationState = (state) => {
      console.log('[Avatar] Conversation:', state);
      isAvatarPlaying = state === 'playing';
      if (state === 'idle') {
        setStatus('Ready');
        const statusEl = document.getElementById('status')!;
        statusEl.className = 'status-badge ready';
      } else if (state === 'playing') {
        setStatus('Speaking');
      }
    };
    avatarView.controller.onError = (error) => {
      console.error('[Avatar] Error:', error.code);
      setStatus(`Error: ${error.code}`);
    };
    avatarView.onFirstRendering = () => {
      console.log('[Avatar] First frame rendered');
    };

    isSdkInitialized = true;
    setStatus('Avatar loaded. Start service.');

    const startBtn = document.getElementById('start-btn') as HTMLButtonElement;
    if (startBtn) startBtn.disabled = false;
  } catch (err: any) {
    console.error('Init error:', err);
    setStatus(`Error: ${err.message}`);
    btn.disabled = false;
  } finally {
    isLoading = false;
  }
}

// ============================================================
// Start Service — user gesture required
// ============================================================
async function onStartService() {
  if (!avatarView || isServiceStarted) return;
  const btn = document.getElementById('start-btn') as HTMLButtonElement;
  btn.disabled = true;
  btn.textContent = 'Starting...';

  try {
    await avatarView.controller.initializeAudioContext();
    await avatarView.controller.start();

    isServiceStarted = true;
    setStatus('Connecting to avatar...');
    btn.textContent = 'Started';

    // Conv + tone buttons are enabled once onConversationState fires 'idle',
    // which confirms the avatar WebSocket is connected and ready.
    const convBtn = document.getElementById('conv-btn') as HTMLButtonElement;
    const testToneBtn = document.getElementById('test-tone-btn') as HTMLButtonElement;
    if (convBtn) convBtn.disabled = false;
    if (testToneBtn) testToneBtn.disabled = false;
  } catch (err: any) {
    console.error('[Avatar] Start failed:', err);
    setStatus(`Start failed: ${err.message}`);
    btn.disabled = false;
    btn.textContent = 'Start Service';
  }
}

// ============================================================
// Conversation Toggle — start/stop live voice chat
// ============================================================
async function onToggleConversation() {
  const btn = document.getElementById('conv-btn') as HTMLButtonElement;
  if (isConversationActive) {
    await stopConversation();
    btn.textContent = '🎙 Talk to Ava';
    btn.classList.remove('recording');
  } else {
    await startConversation();
    btn.textContent = '⏹ End Conversation';
    btn.classList.add('recording');
  }
}

async function startConversation() {
  if (!isServiceStarted || isConversationActive) return;
  isConversationActive = true;

  // Unlock fallback AudioContext while we still have the user-gesture token
  if (!fallbackAudioCtx || fallbackAudioCtx.state === 'closed') {
    fallbackAudioCtx = new AudioContext({ sampleRate: 16000 });
  }
  if (fallbackAudioCtx.state === 'suspended') {
    await fallbackAudioCtx.resume().catch(() => {});
  }

  setStatus('Connecting...');
  showTranscript('');
  console.log('[Conv] Starting conversation...');

  try {
    // Start mic capture FIRST (user gesture context)
    console.log('[Conv] Starting mic capture...');
    await startMicCapture();
    console.log('[Conv] Mic capture started');

    // Open WebSocket to backend
    const wsUrl = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws/voice-session`;
    console.log('[Conv] Connecting WS:', wsUrl);
    voiceWs = new WebSocket(wsUrl);

    await new Promise<void>((resolve, reject) => {
      if (!voiceWs) return reject(new Error('WS null'));
      voiceWs.onopen = () => {
        console.log('[Conv] WS connected');
        resolve();
      };
      voiceWs.onerror = (err) => {
        console.error('[Conv] WS error:', err);
        reject(new Error('WS failed'));
      };
      voiceWs.onclose = () => {
        console.log('[Conv] WS closed');
        reject(new Error('WS closed'));
      };
    });

    voiceWs.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      handleVoiceMessage(msg);
    };
    voiceWs.onerror = (err) => {
      console.error('[Conv] WS runtime error:', err);
    };
    voiceWs.onclose = () => {
      console.log('[Conv] WS runtime close');
      if (isConversationActive) stopConversation();
    };

    // Send start to backend
    voiceWs.send(JSON.stringify({ type: 'start', sampleRate: 16000, persona: selectedPersona }));
    console.log('[Conv] Sent start to backend');

    // Begin streaming chunks
    startChunkStreaming();

    const interruptBtn = document.getElementById('interrupt-btn') as HTMLButtonElement;
    if (interruptBtn) interruptBtn.disabled = false;

    setStatus('Listening...');
  } catch (err: any) {
    console.error('[Conv] Start error:', err);
    setStatus(`Error: ${err.message}`);
    stopConversation();
  }
}

async function stopConversation() {
  if (!isConversationActive) return;
  isConversationActive = false;
  console.log('[Conv] Stopping conversation');

  if (streamIntervalId) {
    clearInterval(streamIntervalId);
    streamIntervalId = null;
  }
  stopMicCapture();

  if (voiceWs && voiceWs.readyState === WebSocket.OPEN) {
    voiceWs.send(JSON.stringify({ type: 'end' }));
    voiceWs.close();
  }
  voiceWs = null;

  const interruptBtn = document.getElementById('interrupt-btn') as HTMLButtonElement;
  if (interruptBtn) interruptBtn.disabled = true;

  setStatus('Ready');
  showTranscript('');
}

function handleVoiceMessage(msg: any) {
  if (msg.type === 'ready') {
    setStatus('Listening...');
    return;
  }

  if (msg.type === 'status') {
    const state = msg.state;
    if (state === 'listening') setStatus('Listening...');
    else if (state === 'thinking') setStatus('Thinking...');
    else if (state === 'speaking') setStatus('Speaking...');
    else if (state === 'idle') setStatus('Ready');
    else if (state === 'connecting') setStatus('Connecting STT...');
    return;
  }

  if (msg.type === 'partial') {
    showTranscript(msg.text);
    return;
  }

  if (msg.type === 'response') {
    showTranscript(msg.transcript || '');
    if (msg.audioBase64) {
      const pcmBytes = base64ToArrayBuffer(msg.audioBase64);
      sendAudioToAvatar(pcmBytes, 'conversation');
    }
    return;
  }

  if (msg.type === 'error') {
    console.error('[Voice] Error:', msg.code, msg.message);
    setStatus(`Error: ${msg.message}`);
  }
}

// ============================================================
// Browser audio fallback — plays raw PCM s16le 16 kHz mono
// via Web Audio API when the SpatialReal avatar can't play it
// ============================================================
async function playPcmFallback(pcmData: ArrayBuffer) {
  try {
    if (!fallbackAudioCtx || fallbackAudioCtx.state === 'closed') {
      fallbackAudioCtx = new AudioContext({ sampleRate: 16000 });
    }
    if (fallbackAudioCtx.state === 'suspended') {
      await fallbackAudioCtx.resume();
    }
    const int16 = new Int16Array(pcmData);
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) {
      float32[i] = int16[i] / 32768;
    }
    const buf = fallbackAudioCtx.createBuffer(1, float32.length, 16000);
    buf.copyToChannel(float32, 0);
    const src = fallbackAudioCtx.createBufferSource();
    src.buffer = buf;
    src.connect(fallbackAudioCtx.destination);
    src.start();
    console.log('[Audio] Browser fallback playing:', pcmData.byteLength, 'bytes');
  } catch (e) {
    console.error('[Audio] Fallback failed:', e);
  }
}

// ============================================================
// Send audio to avatar — chunked streaming
// Falls back to browser Web Audio when avatar is unavailable
// ============================================================
async function sendAudioToAvatar(audioData: ArrayBuffer, label: string) {
  // Avatar not ready — go straight to browser fallback
  if (!avatarView || !isServiceStarted) {
    console.warn('[Audio] Avatar not ready, using browser fallback');
    playPcmFallback(audioData);
    return;
  }

  if (cancelAudioSend) {
    cancelAudioSend();
    cancelAudioSend = null;
  }
  if (isAvatarPlaying) {
    avatarView.controller.interrupt();
  }

  console.log(`[Avatar] Sending ${label}:`, audioData.byteLength, 'bytes');

  const bytes = new Uint8Array(audioData);
  let offset = 0;
  let cancelled = false;
  let avatarAccepted = false;
  let nullRetries = 0;
  const MAX_NULL_RETRIES = 5;  // retry up to 5× (×200 ms = 1 s) before falling back
  const RETRY_DELAY_MS = 200;

  const fallbackRemaining = () => {
    // Play everything from the last successfully sent position onward
    const remaining = audioData.slice(offset);
    if (remaining.byteLength > 0) {
      console.warn('[Avatar] Falling back to browser audio for remaining', remaining.byteLength, 'bytes');
      playPcmFallback(remaining);
    }
  };

  const next = () => {
    if (cancelled) return;
    const end = Math.min(offset + PCM_CHUNK_SIZE, bytes.length);
    const chunk = bytes.slice(offset, end);
    const isLast = end >= bytes.length;
    const convId = avatarView!.controller.send(chunk.buffer as ArrayBuffer, isLast);

    if (!convId) {
      if (!avatarAccepted) {
        // Avatar hasn't accepted yet — retry with back-off before giving up
        nullRetries++;
        if (nullRetries <= MAX_NULL_RETRIES) {
          console.warn(`[Avatar] send() null on attempt ${nullRetries}/${MAX_NULL_RETRIES}, retrying in ${RETRY_DELAY_MS} ms`);
          setTimeout(next, RETRY_DELAY_MS);
          return;
        }
        console.warn('[Avatar] Avatar did not accept after retries — using browser fallback');
        cancelled = true;
        cancelAudioSend = null;
        playPcmFallback(audioData);
        return;
      }
      // Avatar accepted earlier but now returned null (mid-stream disconnect)
      console.warn('[Avatar] Mid-stream null — flushing remaining audio to browser fallback');
      cancelled = true;
      cancelAudioSend = null;
      fallbackRemaining();
      return;
    }

    // Chunk was accepted — advance the cursor and continue
    avatarAccepted = true;
    nullRetries = 0;
    offset = end;

    if (isLast) {
      console.log('[Avatar] Send complete, convId:', convId);
      cancelAudioSend = null;
    } else {
      setTimeout(next, PCM_CHUNK_INTERVAL_MS);
    }
  };

  next();

  cancelAudioSend = () => {
    cancelled = true;
    cancelAudioSend = null;
  };
}

function onInterrupt() {
  if (cancelAudioSend) {
    cancelAudioSend();
    cancelAudioSend = null;
  }
  if (avatarView) {
    avatarView.controller.interrupt();
  }
  if (voiceWs && voiceWs.readyState === WebSocket.OPEN) {
    voiceWs.send(JSON.stringify({ type: 'interrupt' }));
  }
  setStatus('Interrupted');
  console.log('[Avatar] Interrupted');
}

// ============================================================
// Test Voice — calls /api/chat, gets TTS audio, plays it
// Works without avatar (uses browser audio fallback)
// ============================================================
async function onTestVoice() {
  // Unlock fallback AudioContext while we still have the user-gesture token
  if (!fallbackAudioCtx || fallbackAudioCtx.state === 'closed') {
    fallbackAudioCtx = new AudioContext({ sampleRate: 16000 });
  }
  if (fallbackAudioCtx.state === 'suspended') {
    await fallbackAudioCtx.resume().catch(() => {});
  }

  const btn = document.getElementById('test-voice-btn') as HTMLButtonElement;
  btn.disabled = true;
  setStatus('Fetching test audio...');
  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Say hello and introduce yourself in one sentence.', persona: selectedPersona }),
    });
    if (!res.ok) throw new Error(`Server error ${res.status}`);
    const { text, audioBase64 } = await res.json();
    console.log('[TestVoice] Reply text:', text);
    if (!audioBase64) {
      setStatus('No audio — check server TTS logs');
      return;
    }
    setStatus('Playing test voice...');
    const pcmBytes = base64ToArrayBuffer(audioBase64);
    sendAudioToAvatar(pcmBytes, 'test-voice');
  } catch (err: any) {
    console.error('[TestVoice] Error:', err);
    setStatus(`Test failed: ${err.message}`);
  } finally {
    btn.disabled = false;
  }
}

// ============================================================
// Test Tone
// ============================================================
function onTestTone() {
  if (!avatarView || !isServiceStarted) {
    setStatus('Initialize and start service first');
    return;
  }

  const sampleRate = 16000;
  const duration = 1.5;
  const frequency = 440;
  const numSamples = Math.floor(sampleRate * duration);

  const int16Data = new Int16Array(numSamples);
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    const sample = Math.sin(2 * Math.PI * frequency * t) * 0.3;
    int16Data[i] = Math.round(sample * 32767);
  }

  setStatus('Playing test tone...');
  sendAudioToAvatar(int16Data.buffer, 'test-tone');
}

// ============================================================
// Mic Capture
// ============================================================
async function startMicCapture() {
  console.log('[Mic] Requesting permission...');
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        sampleRate: { ideal: 16000 },
        channelCount: { ideal: 1 },
        echoCancellation: true,
        noiseSuppression: true,
      },
    });
  } catch (err: any) {
    console.error('[Mic] getUserMedia failed:', err.name, err.message);
    if (err.name === 'NotAllowedError') {
      throw new Error('Microphone permission denied. Click the mic icon in the browser address bar and allow access.');
    } else if (err.name === 'NotFoundError') {
      throw new Error('No microphone found. Connect a mic and try again.');
    } else {
      throw new Error(`Mic error: ${err.message}`);
    }
  }
  console.log('[Mic] Permission granted');

  audioContext = new AudioContext({ sampleRate: 16000 });
  if (audioContext.state === 'suspended') {
    await audioContext.resume();
    console.log('[Mic] AudioContext resumed');
  }

  sourceNode = audioContext.createMediaStreamSource(mediaStream);
  scriptProcessor = audioContext.createScriptProcessor(4096, 1, 1);
  pcmBuffers = [];
  let chunkCount = 0;

  scriptProcessor.onaudioprocess = (e) => {
    const inputData = e.inputBuffer.getChannelData(0);
    const int16Data = new Int16Array(inputData.length);
    for (let i = 0; i < inputData.length; i++) {
      int16Data[i] = Math.max(-1, Math.min(1, inputData[i])) * 32767;
    }
    pcmBuffers.push(int16Data);
    chunkCount++;
    if (chunkCount === 1) console.log('[Mic] First chunk captured');
  };

  sourceNode.connect(scriptProcessor);
  micGainNode = audioContext.createGain();
  micGainNode.gain.value = 0;
  scriptProcessor.connect(micGainNode);
  micGainNode.connect(audioContext.destination);
  console.log('[Mic] Capture pipeline ready');
}

function stopMicCapture() {
  if (scriptProcessor) { scriptProcessor.disconnect(); scriptProcessor = null; }
  if (sourceNode) { sourceNode.disconnect(); sourceNode = null; }
  if (micGainNode) { micGainNode.disconnect(); micGainNode = null; }
  if (audioContext) { audioContext.close(); audioContext = null; }
  if (mediaStream) { mediaStream.getTracks().forEach(t => t.stop()); mediaStream = null; }
  pcmBuffers = [];
}

function startChunkStreaming() {
  if (streamIntervalId) clearInterval(streamIntervalId);
  streamIntervalId = setInterval(() => {
    if (!isConversationActive) return;
    if (!voiceWs || voiceWs.readyState !== WebSocket.OPEN || pcmBuffers.length === 0) return;

    const totalSamples = pcmBuffers.reduce((sum, b) => sum + b.length, 0);
    const combined = new Int16Array(totalSamples);
    let offset = 0;
    for (const buf of pcmBuffers) {
      combined.set(buf, offset);
      offset += buf.length;
    }
    pcmBuffers = [];

    const base64 = arrayBufferToBase64(combined.buffer);
    voiceWs.send(JSON.stringify({ type: 'audio', data: base64 }));
  }, 200);
}

function stopChunkStreaming() {
  if (streamIntervalId) {
    clearInterval(streamIntervalId);
    streamIntervalId = null;
  }
  if (!voiceWs || voiceWs.readyState !== WebSocket.OPEN || pcmBuffers.length === 0) return;
  const totalSamples = pcmBuffers.reduce((sum, b) => sum + b.length, 0);
  const combined = new Int16Array(totalSamples);
  let offset = 0;
  for (const buf of pcmBuffers) {
    combined.set(buf, offset);
    offset += buf.length;
  }
  pcmBuffers = [];
  const base64 = arrayBufferToBase64(combined.buffer);
  voiceWs.send(JSON.stringify({ type: 'audio', data: base64 }));
}

// ============================================================
// LiveKit Room
// ============================================================
async function onLiveKitToggle() {
  const btn = document.getElementById('lk-btn') as HTMLButtonElement;
  if (isLiveKitConnected) {
    leaveLiveKitRoom();
    btn.textContent = 'Join LiveKit';
  } else {
    await joinLiveKitRoom();
    btn.textContent = 'Leave LiveKit';
  }
}

async function joinLiveKitRoom() {
  try {
    setStatus('Getting LiveKit token...');
    const { token, url, roomName } = await getLiveKitToken('spatialreal-demo');

    livekitRoom = new Room({ adaptiveStream: true, dynacast: true });
    livekitRoom.on(RoomEvent.Connected, () => {
      isLiveKitConnected = true;
      setStatus('LiveKit connected');
    });
    livekitRoom.on(RoomEvent.Disconnected, () => {
      isLiveKitConnected = false;
      livekitRoom = null;
    });
    livekitRoom.on(RoomEvent.TrackSubscribed, (track) => {
      if (track.kind === Track.Kind.Audio) {
        const el = document.createElement('audio');
        el.srcObject = new MediaStream([track.mediaStreamTrack]);
        el.autoplay = true;
        document.body.appendChild(el);
      }
    });
    await livekitRoom.connect(url, token);
  } catch (err: any) {
    console.error('[LiveKit] Failed:', err);
    setStatus(`LiveKit error: ${err.message}`);
  }
}

function leaveLiveKitRoom() {
  if (livekitRoom) { livekitRoom.disconnect(); livekitRoom = null; }
  isLiveKitConnected = false;
  setStatus('Left LiveKit');
}

// ============================================================
// UI Helpers
// ============================================================
function setStatus(text: string) {
  const el = document.getElementById('status')!;
  el.textContent = text;
}

function showTranscript(text: string) {
  const el = document.getElementById('live-transcript')!;
  el.textContent = text;
  if (text) {
    el.classList.add('visible');
  } else {
    el.classList.remove('visible');
  }
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
