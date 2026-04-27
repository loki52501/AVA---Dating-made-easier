export async function getToken(): Promise<{ token: string; expiresAt: string }> {
  const res = await fetch('/api/token', { method: 'POST' });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Token request failed: ${res.status}`);
  }
  return res.json();
}

export async function sendMessage(message: string): Promise<{ text: string; audioBase64?: string }> {
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Chat request failed: ${res.status}`);
  }
  return res.json();
}

export async function getHealth(): Promise<{
  status: string;
  spatialrealConfigured: boolean;
  cartesiaConfigured: boolean;
  bodhiConfigured: boolean;
  sttProvider: string | null;
  sttConfigured: boolean;
  livekitConfigured: boolean;
  openaiConfigured: boolean;
  message: string;
}> {
  const res = await fetch('/api/health');
  return res.json();
}

export async function getLiveKitToken(roomName?: string, participantName?: string): Promise<{ token: string; url: string; roomName: string; participantName: string }> {
  const res = await fetch('/api/livekit-token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ roomName, participantName }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `LiveKit token failed: ${res.status}`);
  }
  return res.json();
}

export async function createBodhiSession(agentProfile?: string): Promise<Record<string, any>> {
  const res = await fetch('/api/bodhi-session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(agentProfile ? { agentProfile } : {}),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Bodhi session failed: ${res.status}`);
  }
  return res.json();
}
