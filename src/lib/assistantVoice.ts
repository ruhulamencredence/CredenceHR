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
  mediaRecorder = null; // a second stop (e.g. the 1-minute limit) finds nothing
  // Never wait forever: an already-stopped recorder fires no "stop" event.
  const done = new Promise<void>((resolve) => {
    rec.onstop = () => resolve();
    setTimeout(resolve, 2500);
  });
  if (rec.state !== 'inactive') {
    try {
      rec.requestData?.();
    } catch {
      /* not recording */
    }
    rec.stop();
  }
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
  const original = () => ({ base64: bytesToBase64(new Uint8Array(raw)), mime: (blob.type || 'audio/webm').split(';')[0] });
  // Some phones' web views never finish decoding: give it 6 seconds, then
  // send the recording as it is.
  return Promise.race([toWav(raw).catch(() => original()), new Promise<{ base64: string; mime: string }>((r) => setTimeout(() => r(original()), 6000))]);
}

async function toWav(raw: ArrayBuffer): Promise<{ base64: string; mime: string }> {
  {
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

const isBangla = (t: string) => /[\u0980-\u09FF]/.test(t);

// The device's voices, looked up once (the list loads late on some browsers).
let voicesReady: Promise<SpeechSynthesisVoice[]> | null = null;
function loadVoices(): Promise<SpeechSynthesisVoice[]> {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return Promise.resolve([]);
  if (!voicesReady) {
    voicesReady = new Promise((resolve) => {
      const now = window.speechSynthesis.getVoices();
      if (now.length) return resolve(now);
      const t = setTimeout(() => resolve(window.speechSynthesis.getVoices()), 600);
      window.speechSynthesis.onvoiceschanged = () => {
        clearTimeout(t);
        resolve(window.speechSynthesis.getVoices());
      };
    });
  }
  return voicesReady;
}
async function deviceVoice(lang: 'bn' | 'en'): Promise<SpeechSynthesisVoice | null> {
  return (await loadVoices()).find((v) => v.lang?.toLowerCase().startsWith(lang)) || null;
}

// ---- which voice ------------------------------------------------------------
// Each person picks a voice in the Assistant (the 🔊 button); it is kept on
// this device. "auto" = the phone's own voice when it has one for the
// language, else Gemini's default. "device:<id>" = one of the phone's Bangla
// voices. "gemini:<Name>" = that Gemini voice (the server accepts only the
// names below — AiAssistantRoutes.ts TTS_VOICES).
export type VoicePref = string;
export const GEMINI_VOICES: { name: string; label: string; desc: string }[] = [
  { name: 'Aoede', label: 'মিষ্টি ও প্রাণবন্ত', desc: 'নারী কণ্ঠ' },
  { name: 'Leda', label: 'তরুণ ও হাসিখুশি', desc: 'নারী কণ্ঠ' },
  { name: 'Despina', label: 'নরম ও মসৃণ', desc: 'নারী কণ্ঠ' },
  { name: 'Sulafat', label: 'উষ্ণ ও আন্তরিক', desc: 'নারী কণ্ঠ' },
  { name: 'Achernar', label: 'কোমল', desc: 'নারী কণ্ঠ' },
  { name: 'Vindemiatrix', label: 'শান্ত ও ভদ্র', desc: 'নারী কণ্ঠ' },
  { name: 'Callirrhoe', label: 'সহজ ও স্বাভাবিক', desc: 'নারী কণ্ঠ' },
  { name: 'Zephyr', label: 'উজ্জ্বল', desc: 'নারী কণ্ঠ' },
  { name: 'Kore', label: 'দৃঢ় ও স্পষ্ট (আগের)', desc: 'নারী কণ্ঠ' },
  { name: 'Achird', label: 'বন্ধুসুলভ', desc: 'পুরুষ কণ্ঠ' },
  { name: 'Puck', label: 'উচ্ছ্বসিত', desc: 'পুরুষ কণ্ঠ' },
  { name: 'Algieba', label: 'মসৃণ', desc: 'পুরুষ কণ্ঠ' },
  { name: 'Umbriel', label: 'সহজ ও শান্ত', desc: 'পুরুষ কণ্ঠ' },
  { name: 'Sadachbia', label: 'প্রাণবন্ত', desc: 'পুরুষ কণ্ঠ' },
  { name: 'Charon', label: 'তথ্যবহুল, গম্ভীর', desc: 'পুরুষ কণ্ঠ' }
];
const PREF_KEY = 'credence_assistant_voice';
export function getVoicePref(): VoicePref {
  try {
    return localStorage.getItem(PREF_KEY) || 'auto';
  } catch {
    return 'auto';
  }
}
export function setVoicePref(v: VoicePref) {
  try {
    localStorage.setItem(PREF_KEY, v);
  } catch {
    /* kept for this visit only */
  }
}
// The phone's / computer's own Bangla voices (Android's Google voice has a
// few; iPhone has none).
export async function deviceBanglaVoices(): Promise<{ id: string; label: string }[]> {
  return (await loadVoices())
    .filter((v) => v.lang?.toLowerCase().startsWith('bn'))
    .map((v) => ({ id: v.voiceURI || v.name, label: v.name }));
}
// A short sentence in the picked voice, so people can hear it before choosing.
export const SAMPLE_TEXT = 'আসসালামু আলাইকুম! আমি CredenceHR AI Assistant। আপনার ছুটি, হাজিরা বা যেকোনো প্রশ্নে আমি সাহায্য করতে পারি।';
export function previewVoice(pref: VoicePref, token: string, onPlaying?: () => void): Promise<void> {
  return speak(SAMPLE_TEXT, token, onPlaying, pref);
}
// Warm the voice list up early (the Assistant calls this when it opens).
export function prepareVoices() {
  void loadVoices();
}

// Gemini's voice is made in pieces: a short first sentence (so sound starts
// in a second or two), then bigger pieces made while the earlier ones play.
// Pieces already made are kept for this session, so playing an answer again
// starts at once.
function splitForSpeech(text: string): string[] {
  const sentences = text.match(/[^।!?.\n]+[।!?.]*\s*/g)?.map((x) => x.trim()).filter(Boolean) || [text];
  const out: string[] = [];
  let cur = '';
  for (const sn of sentences) {
    const limit = out.length === 0 ? 90 : 320;
    if (cur && (cur + ' ' + sn).length > limit) {
      out.push(cur);
      cur = sn;
    } else cur = cur ? `${cur} ${sn}` : sn;
  }
  if (cur) out.push(cur);
  return out;
}
const clipCache = new Map<string, Promise<Blob>>();
function fetchClip(text: string, token: string, voice: string): Promise<Blob> {
  const key = `${voice}|${text}`;
  const hit = clipCache.get(key);
  if (hit) return hit;
  // Never wait more than 50 s for a piece (the server stops trying at ~40).
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 50000);
  const p = fetch(apiUrl('/api/assistant/speak'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ text, ...(voice ? { voice } : {}) }),
    signal: ctl.signal
  })
    .then(async (r) => {
      if (!r.ok) throw new Error('Could not read the answer aloud.');
      return r.blob();
    })
    .finally(() => clearTimeout(timer));
  p.catch(() => clipCache.delete(key));
  clipCache.set(key, p);
  if (clipCache.size > 60) clipCache.delete(clipCache.keys().next().value as string);
  return p;
}

let currentAudio: HTMLAudioElement | null = null;
let playId = 0;

// iPhone (Safari, the Home Screen app and the iOS app) only lets a page make
// sound from a tap: a clip that arrives from the server seconds later is
// refused, and the first spoken sentence too. So the mic and "শুনুন" taps
// call unlockAudio() straight away — it plays a silent sound on one shared
// <audio> element (every later clip plays on that same, now allowed,
// element) and an empty sentence on the device's voice. Harmless elsewhere.
let player: HTMLAudioElement | null = null;

// Gemini pieces are played on ONE running Web Audio context, one after the
// other, instead of swapping the <audio> element's src for every piece:
// each swap made the phone close and reopen its sound output, heard as a
// short radio-like crackle between lines. Here the output stays open, every
// piece gets a few ms fade in / out (no click where it was cut), and the
// gap between pieces is plain silence.
let ctx: AudioContext | null = null;
let sources: AudioBufferSourceNode[] = [];
const FADE_S = 0.012;
const GAP_S = 0.12;
function audioCtx(): AudioContext | null {
  if (ctx) return ctx;
  try {
    const Ctx: typeof AudioContext | undefined = (window as any).AudioContext || (window as any).webkitAudioContext;
    ctx = Ctx ? new Ctx() : null;
  } catch {
    ctx = null;
  }
  return ctx;
}
async function decodeClip(c: AudioContext, blob: Blob): Promise<AudioBuffer> {
  const raw = await blob.arrayBuffer();
  const buf = await new Promise<AudioBuffer>((resolve, reject) => {
    // Old Safari: callback form only.
    const p = c.decodeAudioData(raw, resolve, reject) as unknown as Promise<AudioBuffer> | undefined;
    p?.then?.(resolve, reject);
  });
  const n = Math.min(Math.floor(buf.sampleRate * FADE_S), Math.floor(buf.length / 2));
  for (let ch = 0; ch < buf.numberOfChannels; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < n; i++) {
      const g = i / n;
      d[i] *= g;
      d[d.length - 1 - i] *= g;
    }
  }
  return buf;
}
const SILENT_WAV = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';
export function unlockAudio() {
  try {
    const c = audioCtx();
    if (c) {
      void c.resume().catch(() => undefined);
      // iPhone: a silent sound started from the tap unlocks the context.
      const b = c.createBuffer(1, 1, 22050);
      const src = c.createBufferSource();
      src.buffer = b;
      src.connect(c.destination);
      src.start(0);
    }
  } catch {
    /* no Web Audio here */
  }
  try {
    if (!player) {
      player = new Audio();
      player.setAttribute('playsinline', '');
    }
    if (!currentAudio) {
      player.src = SILENT_WAV;
      void player.play().catch(() => undefined);
    }
  } catch {
    /* no audio here */
  }
  try {
    if ('speechSynthesis' in window && !window.speechSynthesis.speaking) {
      const u = new SpeechSynthesisUtterance(' ');
      u.volume = 0;
      window.speechSynthesis.speak(u);
    }
  } catch {
    /* no device voice */
  }
}

export function stopSpeaking() {
  playId++;
  try {
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
  } catch {
    /* nothing to stop */
  }
  if (currentAudio) {
    currentAudio.pause();
    currentAudio = null;
  }
  const playing = sources;
  sources = [];
  for (const src of playing) {
    try {
      src.stop(); // its onended still fires, so speak() returns
    } catch {
      /* already over */
    }
  }
}

function playBlob(blob: Blob, id: number): Promise<void> {
  if (id !== playId) return Promise.resolve();
  const url = URL.createObjectURL(blob);
  const audio = player || new Audio();
  currentAudio = audio;
  return new Promise<void>((resolve) => {
    let started = false;
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      audio.onended = audio.onerror = audio.onpause = audio.onplaying = null;
      URL.revokeObjectURL(url);
      if (currentAudio === audio) currentAudio = null;
      resolve();
    };
    // Changing src on the shared element can still deliver the previous
    // sound's "pause": only a pause after this clip started ends it.
    audio.onplaying = () => {
      started = true;
    };
    audio.onended = done;
    audio.onerror = done;
    audio.onpause = () => {
      if (started || id !== playId) done();
    };
    audio.src = url;
    void audio.play().catch(done);
  });
}

// Reads `text` aloud; resolves when it has finished (or was stopped).
// onPlaying fires when sound actually starts (the button shows "loading"
// until then).
export async function speak(text: string, token: string, onPlaying?: () => void, pref: VoicePref = getVoicePref()): Promise<void> {
  stopSpeaking();
  const id = playId;
  const words = speakableText(text);
  if (!words) return;
  const lang = isBangla(words) ? 'bn' : 'en';
  const gemini = pref.startsWith('gemini:') ? pref.slice(7) : '';
  let voice: SpeechSynthesisVoice | null = null;
  if (!gemini) {
    const all = await loadVoices();
    const picked = pref.startsWith('device:') ? all.find((v) => (v.voiceURI || v.name) === pref.slice(7)) : undefined;
    // A picked phone voice reads only its own language; anything else uses
    // the phone's voice for that language.
    voice = picked && picked.lang?.toLowerCase().startsWith(lang) ? picked : await deviceVoice(lang);
  }
  if (id !== playId) return;
  if (voice) {
    await new Promise<void>((resolve) => {
      const u = new SpeechSynthesisUtterance(words);
      u.voice = voice;
      u.lang = voice.lang;
      u.rate = 1;
      u.onstart = () => onPlaying?.();
      u.onend = () => resolve();
      u.onerror = () => resolve();
      window.speechSynthesis.speak(u);
    });
    return;
  }
  const parts = splitForSpeech(words);
  // Ask for the first two pieces at once; each later one while the one
  // before it plays.
  const clips = parts.map((_, i) => (i < 2 ? fetchClip(parts[i], token, gemini) : null));
  const c = audioCtx();
  if (c && c.state !== 'running') await c.resume().catch(() => undefined);
  if (c && c.state === 'running') {
    let at = 0;
    let begun = false;
    let last: Promise<void> = Promise.resolve();
    for (let i = 0; i < parts.length; i++) {
      if (id !== playId) return;
      let buf: AudioBuffer;
      try {
        buf = await decodeClip(c, await (clips[i] || fetchClip(parts[i], token, gemini)));
      } catch {
        continue; // a piece that failed: go on with the rest
      }
      if (id !== playId) return;
      if (i + 2 < parts.length && !clips[i + 2]) clips[i + 2] = fetchClip(parts[i + 2], token, gemini);
      const src = c.createBufferSource();
      src.buffer = buf;
      src.connect(c.destination);
      at = Math.max(at, c.currentTime + 0.05);
      src.start(at);
      at += buf.duration + GAP_S;
      sources.push(src);
      last = new Promise<void>((resolve) => {
        src.onended = () => {
          sources = sources.filter((x) => x !== src);
          resolve();
        };
      });
      if (!begun) {
        begun = true;
        onPlaying?.();
      }
    }
    await last;
    return;
  }
  // No Web Audio (or it stays locked): one <audio> piece after another.
  for (let i = 0; i < parts.length; i++) {
    if (id !== playId) return;
    const blob = await (clips[i] || fetchClip(parts[i], token, gemini));
    if (id !== playId) return;
    if (i + 2 < parts.length && !clips[i + 2]) clips[i + 2] = fetchClip(parts[i + 2], token, gemini);
    if (i === 0) onPlaying?.();
    await playBlob(blob, id);
  }
}
