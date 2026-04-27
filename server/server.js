import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { OpenAI } from 'openai';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from 'ffmpeg-static';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import os from 'os';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import { AccessToken } from 'livekit-server-sdk';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '../.env') });

ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 3001;

// ============================================================
// Available LLM Models
// ============================================================
const MODELS = [
  { id: 'deepseek-chat',  label: 'DeepSeek Chat', desc: 'Fast · Cost-efficient', icon: '◈' },
  { id: 'deepseek-reasoner', label: 'DeepSeek R1', desc: 'Advanced reasoning',   icon: '◆' },
  { id: 'gpt-4o-mini',   label: 'GPT-4o mini',   desc: 'OpenAI fast',           icon: '⚡' },
  { id: 'gpt-4o',        label: 'GPT-4o',         desc: 'OpenAI advanced',       icon: '🔥' },
];

app.get('/api/models', (req, res) => {
  res.json({ models: MODELS, current: llmModel });
});

// ============================================================
// Personas
// ============================================================
const PERSONAS = {
  ava: {
    id: 'ava',
    name: 'Ava',
    tagline: 'AI Guide',
    prompt: `You are Ava, a friendly and confident AI dating guide.
You help people navigate dating, relationships, and self-confidence.
Answer in a warm, concise, conversational way. Keep replies under 3 sentences.
Never say you are an AI unless directly asked.`,
    voiceId: process.env.CARTESIA_VOICE_AVA || process.env.CARTESIA_VOICE_ID || '694f9389-aac1-45b6-b726-9d9369183238',
  },
  sienna: {
    id: 'sienna',
    name: 'Sienna',
    tagline: 'Your Dating Spark',
    prompt: `You are Sienna, a warm, playful, and encouraging dating companion.
You help people feel confident and excited about love and dating.
Be upbeat, flirty-friendly, and supportive. Keep replies short and fun — under 3 sentences.
Never say you are an AI unless directly asked.`,
    voiceId: process.env.CARTESIA_VOICE_SIENNA || '694f9389-aac1-45b6-b726-9d9369183238',
  },
  meena: {
    id: 'meena',
    name: 'Meena',
    tagline: 'Your Heart Advisor',
    prompt: `You are Meena, a thoughtful, empathetic, and wise dating advisor.
You help people reflect on what they truly want in relationships.
Be calm, insightful, and emotionally intelligent. Keep replies under 3 sentences.
Never say you are an AI unless directly asked.`,
    voiceId: process.env.CARTESIA_VOICE_MEENA || '694f9389-aac1-45b6-b726-9d9369183238',
  },
  dex: {
    id: 'dex',
    name: 'Dex',
    tagline: 'Your Wingman',
    prompt: `You are Dex, a cool, charming, and straightforward male dating advisor.
You give practical, confident dating advice from a grounded perspective.
Be direct, witty, and encouraging. Keep replies under 3 sentences.
Never say you are an AI unless directly asked.`,
    voiceId: process.env.CARTESIA_VOICE_DEX || '2b568345-1d48-4047-b25f-7baccf842eb0',
  },
};

app.get('/api/personas', (req, res) => {
  res.json(Object.values(PERSONAS).map(({ id, name, tagline }) => ({ id, name, tagline })));
});

// ============================================================
// Clients
// ============================================================
// Priority: DeepSeek → TokenRouter → OpenAI
let llmModel = 'deepseek-chat';
const llmClient = (() => {
  if (process.env.DEEPSEEK_API_KEY) {
    llmModel = process.env.LLM_MODEL || 'deepseek-chat';
    return new OpenAI({
      apiKey: process.env.DEEPSEEK_API_KEY,
      baseURL: 'https://api.deepseek.com',
    });
  }
  if (process.env.TOKENROUTER_API_KEY) {
    llmModel = process.env.LLM_MODEL || 'gpt-4o-mini';
    return new OpenAI({
      apiKey: process.env.TOKENROUTER_API_KEY,
      baseURL: process.env.TOKENROUTER_BASE_URL || 'https://api.tokenrouter.io/v1',
    });
  }
  if (process.env.OPENAI_API_KEY) {
    llmModel = process.env.LLM_MODEL || 'gpt-4o-mini';
    return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return null;
})();

// OpenAI TTS client (separate from LLM; TokenRouter doesn't do TTS)
const openaiTts = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

// ============================================================
// STT Provider Selection
// ============================================================
const STT_PROVIDER = process.env.STT_PROVIDER || (process.env.BODHI_API_KEY ? 'bodhi' : (process.env.CARTESIA_API_KEY ? 'cartesia' : null));

// ============================================================
// Test STT Connectivity
// ============================================================
app.get('/api/test-stt', async (req, res) => {
  if (!process.env.CARTESIA_API_KEY) {
    return res.status(503).json({ ok: false, error: 'CARTESIA_API_KEY not set' });
  }
  // Cartesia STT auth is via query param (not header) for WebSocket connections
  const params = new URLSearchParams({
    model: process.env.CARTESIA_STT_MODEL || 'ink-whisper',
    language: 'en',
    encoding: 'pcm_s16le',
    sample_rate: '16000',
    cartesia_version: process.env.CARTESIA_VERSION || '2025-04-16',
    api_key: process.env.CARTESIA_API_KEY,
  });
  const wsUrl = `wss://api.cartesia.ai/stt/websocket?${params.toString()}`;

  return new Promise((resolve) => {
    let resolved = false;
    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        resolve(res.json({ ok: false, error: 'Connection timeout after 8s', wsUrl: wsUrl.replace(process.env.CARTESIA_API_KEY, '***') }));
      }
    }, 8000);

    const testWs = new WebSocket(wsUrl, {
      headers: {
        'Cartesia-Version': process.env.CARTESIA_VERSION || '2025-04-16',
      },
    });

    testWs.on('open', () => {
      clearTimeout(timeout);
      if (!resolved) {
        resolved = true;
        testWs.close();
        resolve(res.json({ ok: true, message: 'Cartesia STT WebSocket connected successfully', wsUrl }));
      }
    });

    testWs.on('error', (err) => {
      clearTimeout(timeout);
      if (!resolved) {
        resolved = true;
        resolve(res.json({ ok: false, error: err.message, code: err.code || null, wsUrl: wsUrl.replace(process.env.CARTESIA_API_KEY, '***') }));
      }
    });

    testWs.on('unexpected-response', (req, res) => {
      clearTimeout(timeout);
      if (!resolved) {
        resolved = true;
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          resolve(res.json({ ok: false, error: `HTTP ${res.statusCode}: ${res.statusMessage}`, body: body.slice(0, 500), wsUrl: wsUrl.replace(process.env.CARTESIA_API_KEY, '***') }));
        });
      }
    });

    testWs.on('close', (code, reason) => {
      clearTimeout(timeout);
      if (!resolved) {
        resolved = true;
        resolve(res.json({ ok: false, error: `Connection closed immediately (code ${code})`, reason: reason?.toString() || null, wsUrl: wsUrl.replace(process.env.CARTESIA_API_KEY, '***') }));
      }
    });
  });
});

// ============================================================
// Health Check
// ============================================================
app.get('/api/health', (req, res) => {
  const spatialrealConfigured = !!(
    process.env.SPATIALREAL_API_KEY &&
    process.env.SPATIALREAL_APP_ID &&
    process.env.SPATIALREAL_AVATAR_ID
  );
  const cartesiaConfigured = !!process.env.CARTESIA_API_KEY;
  const bodhiConfigured = !!(process.env.BODHI_API_KEY && process.env.BODHI_CUSTOMER_ID);
  const tokenrouterConfigured = !!process.env.TOKENROUTER_API_KEY;
  const sttConfigured = STT_PROVIDER === 'cartesia' ? cartesiaConfigured : (STT_PROVIDER === 'bodhi' ? bodhiConfigured : false);
  const livekitConfigured = !!(process.env.LIVEKIT_URL && process.env.LIVEKIT_API_KEY && process.env.LIVEKIT_API_SECRET);
  res.json({
    status: 'ok',
    spatialrealConfigured,
    cartesiaConfigured,
    bodhiConfigured,
    sttProvider: STT_PROVIDER,
    sttConfigured,
    livekitConfigured,
    openaiConfigured: !!llmClient,
    deepseekConfigured: !!process.env.DEEPSEEK_API_KEY,
    llmProvider: process.env.DEEPSEEK_API_KEY ? 'deepseek' : (process.env.TOKENROUTER_API_KEY ? 'tokenrouter' : (process.env.OPENAI_API_KEY ? 'openai' : null)),
    llmModel,
    tokenrouterConfigured,
    message: spatialrealConfigured
      ? 'Ready'
      : 'Add SpatialReal credentials to .env for avatar support',
  });
});

// ============================================================
// Generate SpatialReal Session Token
// Docs: POST /v1/console/session-tokens
//   Header: X-Api-Key: <key>
//   Body:   { expireAt: <unix_seconds>, modelVersion: "" }
//   Resp:   { sessionToken: "..." }
// ============================================================
app.post('/api/token', async (req, res) => {
  try {
    const apiKey = process.env.SPATIALREAL_API_KEY;
    const appId = process.env.SPATIALREAL_APP_ID;
    const avatarId = process.env.SPATIALREAL_AVATAR_ID;
    const consoleEndpoint = process.env.SPATIALREAL_CONSOLE_ENDPOINT || 'https://console.us-west.spatialwalk.cloud/v1/console';

    if (!apiKey || !appId || !avatarId) {
      return res.status(503).json({
        error: 'SpatialReal credentials not configured',
        hint: 'Copy .env.example to .env and fill in your SpatialReal keys',
      });
    }

    const tokenUrl = consoleEndpoint.endsWith('/')
      ? `${consoleEndpoint}session-tokens`
      : `${consoleEndpoint}/session-tokens`;
    const expireAtSec = Math.floor(Date.now() / 1000) + (60 * 60); // 1 hour from now in seconds

    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': apiKey,
      },
      body: JSON.stringify({
        expireAt: expireAtSec,
        modelVersion: '',
      }),
    });

    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }

    if (!response.ok) {
      console.error('Token generation failed:', response.status, text);
      return res.status(502).json({
        error: 'Failed to generate token',
        status: response.status,
        detail: data,
        url: tokenUrl,
      });
    }

    const token = data.sessionToken;
    if (!token) {
      console.error('Unexpected token response shape:', JSON.stringify(data, null, 2));
      return res.status(502).json({
        error: 'Token not found in response',
        response: data,
        url: tokenUrl,
      });
    }

    res.json({ token, expiresAt: new Date(expireAtSec * 1000).toISOString() });
  } catch (err) {
    console.error('Token error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// LiveKit Token Generation
// ============================================================
app.post('/api/livekit-token', async (req, res) => {
  try {
    const apiKey = process.env.LIVEKIT_API_KEY;
    const apiSecret = process.env.LIVEKIT_API_SECRET;
    const livekitUrl = process.env.LIVEKIT_URL;
    const roomName = req.body.roomName || 'spatialreal-demo';
    const participantName = req.body.participantName || 'user-' + Math.floor(Math.random() * 10000);

    if (!apiKey || !apiSecret || !livekitUrl) {
      return res.status(503).json({
        error: 'LiveKit credentials not configured',
        hint: 'Set LIVEKIT_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET in .env',
      });
    }

    const at = new AccessToken(apiKey, apiSecret, {
      identity: participantName,
      name: participantName,
    });
    at.addGrant({ roomJoin: true, room: roomName, canPublish: true, canSubscribe: true });

    const token = await at.toJwt();
    res.json({ token, url: livekitUrl, roomName, participantName });
  } catch (err) {
    console.error('LiveKit token error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// Bodhi Session Proxy (creates a voice session via Bodhi REST API)
// ============================================================
app.post('/api/bodhi-session', async (req, res) => {
  const baseUrl = process.env.BODHI_BASE_URL || 'https://navana.ai';
  const apiKey = process.env.BODHI_API_KEY;
  const agentProfile = req.body.agentProfile || process.env.BODHI_CUSTOMER_ID;

  if (!apiKey || !agentProfile) {
    return res.status(503).json({
      error: 'Bodhi credentials not configured',
      hint: 'Set BODHI_API_KEY and BODHI_CUSTOMER_ID in .env',
    });
  }

  try {
    const response = await fetch(`${baseUrl}/api/mobile/sessions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ agentProfile }),
    });

    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text, status: response.status };
    }

    if (!response.ok) {
      console.error('[BodhiSession] Error:', response.status, data);
      return res.status(502).json({
        error: 'Bodhi session creation failed',
        status: response.status,
        detail: data,
      });
    }

    console.log('[BodhiSession] Created session:', data);
    res.json(data);
  } catch (err) {
    console.error('[BodhiSession] Exception:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// Chat + TTS (text-based, kept for typed messages)
// ============================================================
app.post('/api/chat', async (req, res) => {
  try {
    const { message, persona: personaId = 'ava' } = req.body;
    if (!message) return res.status(400).json({ error: 'Message required' });

    const persona = PERSONAS[personaId] || PERSONAS.ava;
    let replyText;
    let audioBase64 = null;

    if (llmClient) {
      const completion = await llmClient.chat.completions.create({
        model: llmModel,
        messages: [
          { role: 'system', content: persona.prompt },
          { role: 'user', content: message },
        ],
        max_tokens: 150,
        temperature: 0.7,
      });
      replyText = completion.choices[0].message.content;

      audioBase64 = await generateTts(replyText, persona.voiceId);
    } else {
      replyText = getFallbackReply(message, persona.name);
    }

    res.json({ text: replyText, audioBase64 });
  } catch (err) {
    console.error('Chat error:', err);
    res.status(500).json({ error: err.message });
  }
});

function getFallbackReply(message, personaName = 'Ava') {
  const lower = message.toLowerCase();
  if (lower.includes('hello') || lower.includes('hi') || lower.includes('hey')) {
    return `Hi! I'm ${personaName}. So nice to meet you — I'm here to help you with dating and relationships!`;
  }
  if (lower.includes('help')) {
    return `I can help you with dating advice, relationship questions, and building confidence. What's on your mind?`;
  }
  if (lower.includes('your') && lower.includes('name')) {
    return `I'm ${personaName}, your dating companion. What would you like to talk about?`;
  }
  return "That's interesting. Tell me more — I'd love to hear what you're thinking!";
}

// ============================================================
// TTS Generation (Cartesia → OpenAI fallback)
// ============================================================
async function generateTts(text, voiceId) {
  const resolvedVoiceId = voiceId || process.env.CARTESIA_VOICE_ID || '694f9389-aac1-45b6-b726-9d9369183238';
  // 1. Try Cartesia (outputs raw PCM16 directly)
  if (process.env.CARTESIA_API_KEY) {
    try {
      const response = await fetch('https://api.cartesia.ai/tts/bytes', {
        method: 'POST',
        signal: AbortSignal.timeout(10000),
        headers: {
          'X-API-Key': process.env.CARTESIA_API_KEY,
          'Cartesia-Version': '2025-04-16',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          transcript: text,
          model_id: 'sonic-2',
          language: 'en',
          voice: {
            mode: 'id',
            id: resolvedVoiceId,
          },
          output_format: {
            container: 'raw',
            encoding: 'pcm_s16le',
            sample_rate: 16000,
          },
        }),
      });

      if (response.ok) {
        const buffer = Buffer.from(await response.arrayBuffer());
        console.log('[TTS] Cartesia OK:', buffer.byteLength, 'bytes');
        return buffer.toString('base64');
      }
      const errText = await response.text();
      console.error('[TTS] Cartesia error:', response.status, errText);
    } catch (err) {
      console.error('[TTS] Cartesia exception:', err.message);
    }
  }

  // 2. ElevenLabs TTS — outputs raw PCM directly, no ffmpeg needed
  if (process.env.ELEVENLABS_API_KEY) {
    console.log('[TTS] Trying ElevenLabs');
    try {
      const voiceId = process.env.ELEVENLABS_VOICE_ID || 'EXAVITQu4vr4xnSDxMaL';
      const model   = process.env.ELEVENLABS_MODEL   || 'eleven_turbo_v2_5';
      const response = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=pcm_16000`,
        {
          method: 'POST',
          signal: AbortSignal.timeout(10000),
          headers: {
            'xi-api-key': process.env.ELEVENLABS_API_KEY,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ text, model_id: model }),
        }
      );
      if (response.ok) {
        const buffer = Buffer.from(await response.arrayBuffer());
        console.log('[TTS] ElevenLabs OK:', buffer.byteLength, 'bytes');
        return buffer.toString('base64');
      }
      const errText = await response.text();
      console.error('[TTS] ElevenLabs error:', response.status, errText);
    } catch (err) {
      console.error('[TTS] ElevenLabs exception:', err.message);
    }
  }

  // 3. Fallback: OpenAI TTS + ffmpeg → PCM
  if (openaiTts) {
    console.log('[TTS] Falling back to OpenAI TTS');
    try {
      const ttsResponse = await openaiTts.audio.speech.create({
        model: 'tts-1',
        voice: 'alloy',
        input: text,
        response_format: 'mp3',
      });
      const mp3Buffer = Buffer.from(await ttsResponse.arrayBuffer());
      const pcmBase64 = await convertMp3ToPcmBase64(mp3Buffer);
      console.log('[TTS] OpenAI TTS OK (via ffmpeg)');
      return pcmBase64;
    } catch (err) {
      console.error('[TTS] OpenAI TTS exception:', err.message);
    }
  }

  console.error('[TTS] All providers failed — no audio will be sent');
  return null;
}

function convertMp3ToPcmBase64(mp3Buffer) {
  return new Promise((resolve, reject) => {
    const tmpDir = os.tmpdir();
    const id = Date.now();
    const inputPath = path.join(tmpDir, `input-${id}.mp3`);
    const outputPath = path.join(tmpDir, `output-${id}.pcm`);

    fs.writeFileSync(inputPath, mp3Buffer);

    ffmpeg(inputPath)
      .toFormat('s16le')
      .audioChannels(1)
      .audioFrequency(16000)
      .audioCodec('pcm_s16le')
      .on('end', () => {
        const pcmBuffer = fs.readFileSync(outputPath);
        fs.unlinkSync(inputPath);
        fs.unlinkSync(outputPath);
        resolve(pcmBuffer.toString('base64'));
      })
      .on('error', (err) => {
        try { fs.unlinkSync(inputPath); } catch {}
        try { fs.existsSync(outputPath) && fs.unlinkSync(outputPath); } catch {}
        reject(err);
      })
      .save(outputPath);
  });
}

// ============================================================
// Static files (production)
// ============================================================
const distPath = path.join(__dirname, '../client/dist');
if (fs.existsSync(distPath)) {
  app.use(express.static(distPath));
  app.get('*', (req, res) => {
    res.sendFile(path.join(distPath, 'index.html'));
  });
}

// ============================================================
// HTTP Server + WebSocket Server
// ============================================================
const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws/voice-session' });

wss.on('connection', (clientWs) => {
  let sttWs = null;           // STT WebSocket (Bodhi or Cartesia)
  let sessionState = 'idle';  // 'idle' | 'connecting' | 'streaming' | 'processing'
  let transcriptParts = [];
  let pendingTranscripts = []; // Queue for transcripts arriving while processing
  let isProcessing = false;
  let currentAbortController = null;
  let sessionPersona = PERSONAS.ava; // active persona for this session
  let lastInterimText = '';   // Last non-empty INTERIM text — used as fallback on abnormal STT close

  console.log('[VoiceSession] Browser connected');

  clientWs.on('message', async (rawData) => {
    let msg;
    try {
      msg = JSON.parse(rawData.toString());
    } catch {
      console.error('[VoiceSession] Invalid JSON from browser');
      return;
    }

    if (msg.type === 'start') {
      transcriptParts = [];
      pendingTranscripts = [];
      isProcessing = false;
      sessionState = 'connecting';
      sessionPersona = PERSONAS[msg.persona] || PERSONAS.ava;
      console.log('[VoiceSession] Persona:', sessionPersona.name);
      sendClient({ type: 'status', state: 'connecting' });

      if (STT_PROVIDER === 'cartesia') {
        connectCartesiaStt(msg.sampleRate || 16000);
      } else if (STT_PROVIDER === 'bodhi') {
        connectBodhiStt(msg.sampleRate || 16000, msg.bodhiSession);
      } else {
        sendClient({ type: 'error', code: 'stt_not_configured', message: 'No STT provider configured.' });
        sessionState = 'idle';
      }
    }

    else if (msg.type === 'audio') {
      if (sessionState === 'connecting') {
        // Buffer audio while STT is connecting
        return;
      }
      if (!sttWs || sttWs.readyState !== WebSocket.OPEN) {
        return;
      }
      try {
        const buffer = Buffer.from(msg.data, 'base64');
        // Cartesia STT has a ~32 KB WebSocket message limit (WS 1009).
        // Use 8 KB chunks to stay well under the limit.
        const MAX_CHUNK = 8000;
        for (let i = 0; i < buffer.length; i += MAX_CHUNK) {
          sttWs.send(buffer.slice(i, Math.min(i + MAX_CHUNK, buffer.length)));
        }
      } catch (err) {
        console.error('[VoiceSession] Forward audio error:', err.message);
      }
    }

    else if (msg.type === 'end') {
      console.log('[VoiceSession] Client ended conversation');
      sendClient({ type: 'status', state: 'idle' });
      cleanup();
    }

    else if (msg.type === 'interrupt') {
      console.log('[VoiceSession] Client interrupted');
      if (currentAbortController) {
        currentAbortController.abort();
        currentAbortController = null;
      }
      isProcessing = false;
      // Don't clear transcriptParts — let the current STT session continue
      sendClient({ type: 'status', state: 'listening' });
    }
  });

  clientWs.on('close', () => {
    console.log('[VoiceSession] Browser disconnected');
    cleanup();
  });

  clientWs.on('error', (err) => {
    console.error('[VoiceSession] Client error:', err.message);
    cleanup();
  });

  // ── Process transcript queue ──
  async function processNextTranscript() {
    if (isProcessing || pendingTranscripts.length === 0) return;

    const transcript = pendingTranscripts.shift();
    if (!transcript) return;

    isProcessing = true;
    sessionState = 'processing';
    sendClient({ type: 'status', state: 'thinking' });
    console.log('[VoiceSession] Processing transcript:', transcript);

    currentAbortController = new AbortController();
    const signal = currentAbortController.signal;
    // Combine user interrupt with a 15 s hard timeout so a slow LLM never hangs forever
    const llmTimeout = setTimeout(() => currentAbortController.abort(), 15000);

    try {
      // 1. LLM
      let replyText;
      if (llmClient) {
        const completion = await llmClient.chat.completions.create({
          model: llmModel,
          messages: [
            { role: 'system', content: sessionPersona.prompt },
            { role: 'user', content: transcript },
          ],
          max_tokens: 150,
          temperature: 0.7,
        }, { signal });
        clearTimeout(llmTimeout);
        replyText = completion.choices[0].message.content;
      } else {
        replyText = getFallbackReply(transcript, sessionPersona.name);
      }

      if (signal.aborted) return;

      // 2. TTS
      sendClient({ type: 'status', state: 'speaking' });
      const audioBase64 = await generateTts(replyText, sessionPersona.voiceId);

      if (signal.aborted) return;

      sendClient({
        type: 'response',
        text: replyText,
        audioBase64,
        transcript: transcript,
      });
    } catch (err) {
      clearTimeout(llmTimeout);
      if (err.name === 'AbortError') {
        console.log('[VoiceSession] Processing aborted');
        return;
      }
      console.error('[VoiceSession] Processing error:', err.message);
      sendClient({ type: 'error', code: 'processing_failed', message: err.message });
    } finally {
      clearTimeout(llmTimeout);
      isProcessing = false;
      currentAbortController = null;
      if (sessionState !== 'idle') {
        sendClient({ type: 'status', state: 'listening' });
        sessionState = 'streaming';
      }
      // Process next queued transcript if any
      processNextTranscript();
    }
  }

  // ============================================================
  // Bodhi STT Connection
  // ============================================================
  function connectBodhiStt(sampleRate, bodhiSession) {
    if (!process.env.BODHI_API_KEY || !process.env.BODHI_CUSTOMER_ID) {
      sendClient({ type: 'error', code: 'bodhi_not_configured', message: 'Bodhi credentials missing in .env' });
      sessionState = 'idle';
      return;
    }

    // If a session was created via /api/bodhi-session, try to use its connection details
    let wsUrl = 'wss://bodhi.navana.ai';
    const wsHeaders = {
      'x-api-key': process.env.BODHI_API_KEY,
      'x-customer-id': process.env.BODHI_CUSTOMER_ID,
    };

    if (bodhiSession && typeof bodhiSession === 'object') {
      console.log('[VoiceSession] Using Bodhi session:', JSON.stringify(bodhiSession, null, 2));
      // Common field names Bodhi might return for WebSocket connection
      const sessionUrl = bodhiSession.wsUrl || bodhiSession.websocketUrl || bodhiSession.url || bodhiSession.socketUrl;
      if (sessionUrl) {
        wsUrl = sessionUrl;
        console.log('[VoiceSession] Bodhi WS URL from session:', wsUrl);
      }
      // If session provides its own auth token, use it
      if (bodhiSession.token || bodhiSession.sessionToken || bodhiSession.authToken) {
        wsHeaders['Authorization'] = `Bearer ${bodhiSession.token || bodhiSession.sessionToken || bodhiSession.authToken}`;
        delete wsHeaders['x-api-key'];
        delete wsHeaders['x-customer-id'];
      }
    }

    try {
      sttWs = new WebSocket(wsUrl, { headers: wsHeaders });
    } catch (err) {
      console.error('[VoiceSession] Bodhi WS creation failed:', err.message);
      sendClient({ type: 'error', code: 'bodhi_connect_failed', message: err.message });
      sessionState = 'idle';
      return;
    }

    sttWs.on('open', () => {
      console.log('[VoiceSession] Bodhi connected');
      sessionState = 'streaming';
      sttWs.send(JSON.stringify({
        config: {
          sample_rate: sampleRate,
          transaction_id: uuidv4(),
          model: process.env.BODHI_MODEL || 'en-general-v2-8khz',
        },
      }));
      sendClient({ type: 'ready', provider: 'bodhi' });
    });

    sttWs.on('message', (data) => {
      let resp;
      try {
        resp = JSON.parse(data.toString());
      } catch {
        console.error('[VoiceSession] Non-JSON from Bodhi:', data.toString().slice(0, 200));
        return;
      }

      if (resp.type === 'partial') {
        sendClient({ type: 'partial', text: resp.text, final: false });
      } else if (resp.type === 'complete') {
        if (resp.text && resp.text.trim()) {
          transcriptParts.push(resp.text.trim());
          sendClient({ type: 'partial', text: resp.text, final: true });
          // Auto-trigger processing on final transcript (continuous mode)
          pendingTranscripts.push(resp.text.trim());
          processNextTranscript();
        }
      }
      if (resp.eos) {
        console.log('[VoiceSession] Bodhi EOS received');
      }
    });

    sttWs.on('error', (err) => {
      console.error('[VoiceSession] Bodhi error:', err.message);
      sendClient({ type: 'error', code: 'bodhi_error', message: err.message });
    });

    sttWs.on('close', () => {
      console.log('[VoiceSession] Bodhi closed');
      if (sessionState === 'streaming') sessionState = 'idle';
    });
  }

  // ============================================================
  // Cartesia Ink STT Connection
  // ============================================================
  function connectCartesiaStt(sampleRate) {
    if (!process.env.CARTESIA_API_KEY) {
      sendClient({ type: 'error', code: 'cartesia_not_configured', message: 'CARTESIA_API_KEY missing in .env' });
      sessionState = 'idle';
      return;
    }

    // Cartesia Ink STT WebSocket endpoint
    // Auth is via query param (api_key) — headers don't work for WS handshake
    const params = new URLSearchParams({
      model: process.env.CARTESIA_STT_MODEL || 'ink-whisper',
      language: process.env.CARTESIA_STT_LANGUAGE || 'en',
      encoding: 'pcm_s16le',
      sample_rate: String(sampleRate),
      cartesia_version: process.env.CARTESIA_VERSION || '2025-04-16',
      api_key: process.env.CARTESIA_API_KEY,
    });
    if (process.env.CARTESIA_STT_MIN_VOLUME) {
      params.set('min_volume', process.env.CARTESIA_STT_MIN_VOLUME);
    }
    if (process.env.CARTESIA_STT_MAX_SILENCE) {
      params.set('max_silence_duration_secs', process.env.CARTESIA_STT_MAX_SILENCE);
    }

    const wsUrl = `wss://api.cartesia.ai/stt/websocket?${params.toString()}`;
    console.log('[VoiceSession] Connecting to Cartesia STT:', wsUrl.replace(process.env.CARTESIA_API_KEY, '***'));

    try {
      sttWs = new WebSocket(wsUrl, {
        headers: {
          'Cartesia-Version': process.env.CARTESIA_VERSION || '2025-04-16',
        },
      });
    } catch (err) {
      console.error('[VoiceSession] Cartesia STT WS creation failed:', err.message);
      sendClient({ type: 'error', code: 'cartesia_connect_failed', message: err.message });
      sessionState = 'idle';
      return;
    }

    sttWs.on('open', () => {
      console.log('[VoiceSession] Cartesia Ink STT connected');
      sessionState = 'streaming';
      sendClient({ type: 'ready', provider: 'cartesia' });
    });

    sttWs.on('message', (data) => {
      let resp;
      try {
        resp = JSON.parse(data.toString());
      } catch {
        console.error('[VoiceSession] Non-JSON from Cartesia:', data.toString().slice(0, 200));
        return;
      }

      if (resp.type === 'transcript') {
        const status = resp.isFinal ? 'FINAL' : 'INTERIM';
        console.log(`[VoiceSession] Cartesia [${status}]: "${resp.text}"`);
        if (resp.isFinal && resp.text && resp.text.trim()) {
          lastInterimText = '';
          transcriptParts.push(resp.text.trim());
          sendClient({ type: 'partial', text: resp.text, final: true });
          // Auto-trigger processing on final transcript (continuous mode)
          pendingTranscripts.push(resp.text.trim());
          processNextTranscript();
        } else {
          if (resp.text && resp.text.trim()) lastInterimText = resp.text.trim();
          sendClient({ type: 'partial', text: resp.text || '', final: false });
        }
      } else if (resp.type === 'flush_done') {
        console.log('[VoiceSession] Cartesia flush_done');
      } else if (resp.type === 'done') {
        console.log('[VoiceSession] Cartesia session done');
      } else if (resp.type === 'error') {
        console.error('[VoiceSession] Cartesia error:', resp.message);
        sendClient({ type: 'error', code: 'cartesia_error', message: resp.message });
      }
    });

    sttWs.on('error', (err) => {
      console.error('[VoiceSession] Cartesia STT error:', err.message, err.code || '');
      sendClient({ type: 'error', code: 'cartesia_error', message: err.message || 'STT connection error' });
    });

    sttWs.on('unexpected-response', (req, res) => {
      console.error('[VoiceSession] Cartesia STT unexpected response:', res.statusCode, res.statusMessage);
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        console.error('[VoiceSession] Response body:', body);
        sendClient({ type: 'error', code: 'cartesia_http_error', message: `HTTP ${res.statusCode}: ${body.slice(0, 200)}` });
      });
    });

    sttWs.on('close', (code, reason) => {
      console.log('[VoiceSession] Cartesia STT closed:', code, reason?.toString() || '');
      // On abnormal close (e.g. 1009 message-too-large), recover by processing
      // the last interim transcript so the model still speaks back.
      if (code !== 1000 && code !== 1001 && lastInterimText && !isProcessing) {
        console.log('[VoiceSession] Recovering speech after abnormal STT close:', lastInterimText);
        pendingTranscripts.push(lastInterimText);
        processNextTranscript();
      }
      lastInterimText = '';
      if (sessionState === 'streaming') sessionState = 'idle';
    });
  }

  function sendClient(payload) {
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(JSON.stringify(payload));
    }
  }

  function cleanup() {
    sessionState = 'idle';
    isProcessing = false;
    pendingTranscripts = [];
    lastInterimText = '';
    if (currentAbortController) {
      currentAbortController.abort();
      currentAbortController = null;
    }
    if (sttWs) {
      try { sttWs.close(); } catch {}
      sttWs = null;
    }
  }
});

server.listen(PORT, () => {
  console.log(`\n🚀 Server running on http://localhost:${PORT}`);
  console.log(`   WebSocket: ws://localhost:${PORT}/ws/voice-session`);
  console.log(`   Health:  http://localhost:${PORT}/api/health`);
  console.log(`   STT Provider: ${STT_PROVIDER || 'none'}`);
  const livekitConfigured = !!(process.env.LIVEKIT_URL && process.env.LIVEKIT_API_KEY && process.env.LIVEKIT_API_SECRET);
  console.log(`   LiveKit: ${livekitConfigured ? 'Configured' : 'Not configured'}`);
  if (llmClient) console.log(`   LLM: ${process.env.DEEPSEEK_API_KEY ? 'DeepSeek' : (process.env.TOKENROUTER_API_KEY ? 'TokenRouter' : 'OpenAI')} → ${llmModel}`);
  else console.log(`   ⚠️  No LLM provider configured (DEEPSEEK_API_KEY, OPENAI_API_KEY, or TOKENROUTER_API_KEY). Using fallback replies.`);
  if (!process.env.CARTESIA_API_KEY) console.log(`   ⚠️  CARTESIA_API_KEY not set. TTS will use OpenAI fallback.`);
  if (!STT_PROVIDER) console.log(`   ⚠️  No STT provider configured. Set CARTESIA_API_KEY, BODHI_API_KEY, or STT_PROVIDER in .env.`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n❌ Port ${PORT} is already in use.`);
    console.error(`   Run:  npx kill-port ${PORT}`);
    console.error(`   Or:   Set PORT=3002 in your .env file\n`);
    process.exit(1);
  } else {
    console.error('Server error:', err);
  }
});
