// AI Assistant voice (users.can_use_assistant_voice): record a spoken question
// and read an answer aloud.
//
// Recording: the website uses the browser's MediaRecorder, the Android / iOS
// app the capacitor-voice-recorder plugin (same as Chat voice messages). The
// result is turned into a small 16 kHz mono WAV here, so the server (Gemini)
// always gets one format it reads, whatever the browser recorded in.
//
// Reading aloud: the device's own voice when it has one for the language
// (free, instant); otherwise the server's Gemini voice
// (POST /api/assistant/speak).
import { Capacitor } from '@capacitor/core';
import { VoiceRecorder } from 'capacitor-voice-recorder';
import { apiUrl } from './api';

export const MAX_RECORD_SECONDS = 60;

let mediaRecorder: MediaRecorder | null = null;
let mediaStream: MediaStream | null = null;
let chunks: Blob[] = [];

export async function startRecording(): Promise<void> {
  if (Capacitor.isNativePlatform()) {
    const { value: can } = await VoiceRecorder.canDeviceVoiceRecord();
    if (!can) throw new Error('This device cannot record audio.');
    let { value: ok } = await VoiceRecorder.hasAudioRecordingPermission();
    if (!ok) ({ value: ok } = await VoiceRecorder.requestAudioRecordingPermission());
    if (!ok) throw new Error('Microphone permission is off — allow it for this app.');
    await VoiceRecorder.startRecording();
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser cannot record audio.');
  mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  chunks = [];
  const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'].find((t) => MediaRecorder.isTypeSupported?.(t));
  mediaRecorder = new MediaRecorder(mediaStream, mimeType ? { mimeType } : undefined);
  mediaRecorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };
  mediaRecorder.start();
}

function releaseMic() {
  mediaStream?.getTracks().forEach((t) => t.stop());
  mediaStream = null;
  mediaRecorder = null;
}

// Stops and returns the recording (null when cancelled or empty).
export async function stopRecording(keep: boolean): Promise<Blob | null> {
  if (Capacitor.isNativePlatform()) {
    try {
      const r = await VoiceRecorder.stopRecording();
      if (!keep || !r.value?.recordDataBase64) return null;
      const bin = atob(r.value.recordDataBase64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new Blob([bytes], { type: r.value.mimeType || 'audio/aac' });
    } catch {
      return null;
    }
  }
  const rec = mediaRecorder;
  if (!rec) return null;
  const done = new Promise<void>((resolve) => {
    rec.onstop = () => resolve();
  });
  if (rec.state !== 'inactive') rec.stop();
  await done;
  const type = rec.mimeType || 'audio/webm';
  releaseMic();
  if (!keep || !chunks.length) return null;
  return new Blob(chunks, { type });
}

// Any recording -> 16 kHz mono 16-bit WAV, base64 (no data: prefix). Falls
// back to the original bytes when the browser can't decode them.
export async function toWavBase64(blob: Blob): Promise<{ base64: string; mime: string }> {
  const raw = await blob.arrayBuffer();
  try {
    const Ctx: typeof AudioContext = (window as any).AudioContext || (window as any).webkitAudioContext;
    const ctx = new Ctx();
    const decoded = await ctx.decodeAudioData(raw.slice(0));
    void ctx.close();
    const rate = 16000;
    const length = Math.max(1, Math.ceil(decoded.duration * rate));
    const off = new OfflineAudioContext(1, length, rate);
    const src = off.createBufferSource();
    src.buffer = decoded;
    src.connect(off.destination);
    src.start();
    const out = await off.startRendering();
    const pcm = out.getChannelData(0);
    const buf = new ArrayBuffer(44 + pcm.length * 2);
    const v = new DataView(buf);
    const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
    str(0, 'RIFF');
    v.setUint32(4, 36 + pcm.length * 2, true);
    str(8, 'WAVE');
    str(12, 'fmt ');
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true);
    v.setUint16(22, 1, true);
    v.setUint32(24, rate, true);
    v.setUint32(28, rate * 2, true);
    v.setUint16(32, 2, true);
    v.setUint16(34, 16, true);
    str(36, 'data');
    v.setUint32(40, pcm.length * 2, true);
    for (let i = 0; i < pcm.length; i++) {
      const x = Math.max(-1, Math.min(1, pcm[i]));
      v.setInt16(44 + i * 2, x < 0 ? x * 0x8000 : x * 0x7fff, true);
    }
    return { base64: bytesToBase64(new Uint8Array(buf)), mime: 'audio/wav' };
  } catch {
    return { base64: bytesToBase64(new Uint8Array(raw)), mime: (blob.type || 'audio/webm').split(';')[0] };
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

// ---- reading aloud --------------------------------------------------------

// Plain words only: no markdown marks, links or emoji.
export function speakableText(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_#`>|~]/g, ' ')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const isBangla = (t: string) => /[ঀ-৿]/.test(t);

async function deviceVoice(lang: 'bn' | 'en'): Promise<SpeechSynthesisVoice | null> {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return null;
  let voices = window.speechSynthesis.getVoices();
  if (!voices.length) {
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 700);
      window.speechSynthesis.onvoiceschanged = () => {
        clearTimeout(t);
        resolve();
      };
    });
    voices = window.speechSynthesis.getVoices();
  }
  return voices.find((v) => v.lang?.toLowerCase().startsWith(lang)) || null;
}

let currentAudio: HTMLAudioElement | null = null;

export function stopSpeaking() {
  try {
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
  } catch {
    /* nothing to stop */
  }
  if (currentAudio) {
    currentAudio.pause();
    currentAudio = null;
  }
}

// Reads `text` aloud; resolves when it has finished (or was stopped).
export async function speak(text: string, token: string): Promise<void> {
  stopSpeaking();
  const words = speakableText(text);
  if (!words) return;
  const lang = isBangla(words) ? 'bn' : 'en';
  const voice = await deviceVoice(lang);
  if (voice) {
    await new Promise<void>((resolve) => {
      const u = new SpeechSynthesisUtterance(words);
      u.voice = voice;
      u.lang = voice.lang;
      u.rate = 1;
      u.onend = () => resolve();
      u.onerror = () => resolve();
      window.speechSynthesis.speak(u);
    });
    return;
  }
  const r = await fetch(apiUrl('/api/assistant/speak'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ text: words })
  });
  if (!r.ok) throw new Error('Could not read the answer aloud.');
  const url = URL.createObjectURL(await r.blob());
  const audio = new Audio(url);
  currentAudio = audio;
  await new Promise<void>((resolve) => {
    audio.onended = () => resolve();
    audio.onerror = () => resolve();
    audio.onpause = () => resolve();
    void audio.play().catch(() => resolve());
  });
  URL.revokeObjectURL(url);
  if (currentAudio === audio) currentAudio = null;
}
