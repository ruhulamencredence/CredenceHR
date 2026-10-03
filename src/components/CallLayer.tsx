/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Chat audio / video calls — the app-wide call screen (CallRoutes.ts on the
// server). Mounted once while signed in, for accounts with Calls access, so
// a call rings on whatever page is open. It keeps the chat socket connected
// for that (lib/chatSocket.ts).
//
// Starting a call: dispatch `credence:start-call` with { roomId, peer: {id,
// name}, kind: 'audio' | 'video' } (ChatPanel's call buttons do).
//
// Flow: the caller asks for mic/camera, sends call:invite and rings; when
// the callee accepts, the caller makes the WebRTC offer and both sides trade
// ICE candidates through call:signal until the media connects.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Mic, MicOff, Phone, PhoneOff, Video, VideoOff } from 'lucide-react';
import { Capacitor } from '@capacitor/core';
import { apiUrl } from '../lib/api';
import { connectChatSocket, getChatSocket } from '../lib/chatSocket';

type Kind = 'audio' | 'video';
type Phase = 'idle' | 'outgoing' | 'incoming' | 'connecting' | 'active';
interface Peer {
  id: number;
  name: string;
}
export interface StartCallDetail {
  roomId: number;
  peer: Peer;
  kind: Kind;
}

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join('') || '?';
const clock = (s: number) => {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
};
const ENDED_TEXT: Record<string, string> = {
  declined: 'Call declined',
  'no-answer': 'No answer',
  cancelled: 'Call cancelled',
  ended: 'Call ended',
  disconnected: 'Call dropped',
  failed: "Couldn't connect — check the internet on both phones",
};

// A soft ring made with WebAudio (no sound file needed).
function makeRinger() {
  let ctx: AudioContext | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  const beep = (freq: number, len: number) => {
    if (!ctx) return;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.value = freq;
    g.gain.value = 0.0001;
    o.connect(g).connect(ctx.destination);
    const t = ctx.currentTime;
    g.gain.exponentialRampToValueAtTime(0.18, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + len);
    o.start(t);
    o.stop(t + len + 0.05);
  };
  return {
    start(kind: 'incoming' | 'outgoing') {
      this.stop();
      try {
        ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
      } catch {
        return;
      }
      const play = () => {
        if (kind === 'incoming') {
          beep(880, 0.25);
          setTimeout(() => beep(660, 0.35), 300);
        } else beep(440, 0.9);
      };
      play();
      timer = setInterval(play, kind === 'incoming' ? 1600 : 3000);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      if (ctx) ctx.close().catch(() => undefined);
      ctx = null;
    },
  };
}

export const CallLayer: React.FC<{ token: string }> = ({ token }) => {
  const [phase, setPhase] = useState<Phase>('idle');
  const [peer, setPeer] = useState<Peer | null>(null);
  const [kind, setKind] = useState<Kind>('audio');
  const [muted, setMuted] = useState(false);
  const [cameraOff, setCameraOff] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [notice, setNotice] = useState('');
  const [remoteHasVideo, setRemoteHasVideo] = useState(false);

  const callIdRef = useRef<string | null>(null);
  const roleRef = useRef<'caller' | 'callee' | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localRef = useRef<MediaStream | null>(null);
  const remoteRef = useRef<MediaStream | null>(null);
  const pendingIce = useRef<RTCIceCandidateInit[]>([]);
  const iceServersRef = useRef<RTCIceServer[] | null>(null);
  const ringer = useRef(makeRinger());
  const startedAt = useRef<number | null>(null);
  const localVideo = useRef<HTMLVideoElement>(null);
  const remoteVideo = useRef<HTMLVideoElement>(null);
  const remoteAudio = useRef<HTMLAudioElement>(null);
  const phaseRef = useRef<Phase>('idle');
  phaseRef.current = phase;

  const iceServers = useCallback(async () => {
    if (iceServersRef.current) return iceServersRef.current;
    try {
      const r = await fetch(apiUrl('/api/calls/ice-servers'), { headers: { Authorization: `Bearer ${token}` } });
      const d = await r.json();
      if (r.ok && Array.isArray(d.iceServers)) iceServersRef.current = d.iceServers;
    } catch {
      // fall back to public STUN below
    }
    return iceServersRef.current || [{ urls: 'stun:stun.l.google.com:19302' }];
  }, [token]);

  const cleanup = useCallback((text?: string) => {
    ringer.current.stop();
    pcRef.current?.close();
    pcRef.current = null;
    localRef.current?.getTracks().forEach((t) => t.stop());
    localRef.current = null;
    remoteRef.current = null;
    pendingIce.current = [];
    callIdRef.current = null;
    roleRef.current = null;
    startedAt.current = null;
    setMuted(false);
    setCameraOff(false);
    setSeconds(0);
    setRemoteHasVideo(false);
    if (text) {
      setNotice(text);
      setPhase('idle');
      setTimeout(() => setNotice((n) => (n === text ? '' : n)), 3500);
    } else setPhase('idle');
  }, []);

  const getMedia = async (k: Kind) => {
    // Browsers only offer the microphone on https:// pages (or localhost).
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error(
        window.isSecureContext
          ? "This device or browser doesn't support calls."
          : `Calls need the secure (https://) address — this page is open on ${window.location.host}.`
      );
    }
    const audio = { echoCancellation: true, noiseSuppression: true };
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio,
        video: k === 'video' ? { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } } : false,
      });
    } catch (e: any) {
      // A video call still goes ahead on the microphone alone when the camera
      // is refused, missing or busy.
      if (k === 'video') {
        try {
          return await navigator.mediaDevices.getUserMedia({ audio, video: false });
        } catch {
          /* fall through to the message below */
        }
      }
      const name = String(e?.name || '');
      if (name === 'NotFoundError' || name === 'OverconstrainedError') throw new Error('No microphone found on this device.');
      if (name === 'NotReadableError' || name === 'AbortError') throw new Error('The microphone is in use by another app — close it and try again.');
      throw new Error(
        Capacitor.isNativePlatform()
          ? 'Microphone permission is off for CredenceHR. Turn it on in phone Settings → Apps → CredenceHR → Permissions (Microphone, Camera), then try again.'
          : 'Allow the microphone (and camera for video) for this site in the browser, then try again.'
      );
    }
  };

  const makePc = async (callId: string) => {
    const pc = new RTCPeerConnection({ iceServers: await iceServers() });
    pcRef.current = pc;
    remoteRef.current = new MediaStream();
    localRef.current?.getTracks().forEach((t) => pc.addTrack(t, localRef.current!));
    pc.onicecandidate = (e) => {
      if (e.candidate) getChatSocket()?.emit('call:signal', { callId, data: { candidate: e.candidate.toJSON() } });
    };
    pc.ontrack = (e) => {
      const stream = remoteRef.current!;
      if (!stream.getTracks().includes(e.track)) stream.addTrack(e.track);
      if (e.track.kind === 'video') setRemoteHasVideo(true);
      if (remoteVideo.current && remoteVideo.current.srcObject !== stream) remoteVideo.current.srcObject = stream;
      if (remoteAudio.current && remoteAudio.current.srcObject !== stream) remoteAudio.current.srcObject = stream;
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected' && phaseRef.current !== 'active') {
        startedAt.current = Date.now();
        setPhase('active');
      }
      if (pc.connectionState === 'failed' && callIdRef.current) {
        getChatSocket()?.emit('call:end', { callId: callIdRef.current });
        cleanup(ENDED_TEXT.failed);
      }
    };
    return pc;
  };

  const flushIce = async () => {
    const pc = pcRef.current;
    if (!pc || !pc.remoteDescription) return;
    for (const c of pendingIce.current.splice(0)) await pc.addIceCandidate(c).catch(() => undefined);
  };

  // ---- starting a call -------------------------------------------------
  const startCall = useCallback(
    async (d: StartCallDetail) => {
      if (phaseRef.current !== 'idle') return;
      const socket = connectChatSocket(token);
      setPeer(d.peer);
      setKind(d.kind);
      setNotice('');
      setPhase('outgoing');
      try {
        localRef.current = await getMedia(d.kind);
        if (d.kind === 'video' && !localRef.current.getVideoTracks().length) setCameraOff(true);
        if (localVideo.current) localVideo.current.srcObject = localRef.current;
      } catch (e: any) {
        return cleanup(e.message);
      }
      socket.emit('call:invite', { roomId: d.roomId, kind: d.kind }, (r: any) => {
        if (!r?.ok) return cleanup(r?.error || "Couldn't start the call.");
        callIdRef.current = r.callId;
        roleRef.current = 'caller';
        ringer.current.start('outgoing');
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [token]
  );

  useEffect(() => {
    const on = (e: Event) => startCall((e as CustomEvent<StartCallDetail>).detail);
    window.addEventListener('credence:start-call', on);
    return () => window.removeEventListener('credence:start-call', on);
  }, [startCall]);

  // ---- socket events ---------------------------------------------------
  useEffect(() => {
    const socket = connectChatSocket(token);
    const onIncoming = (d: { callId: string; kind: Kind; from: Peer }) => {
      if (phaseRef.current !== 'idle') return; // already in a call — server marks us busy anyway
      callIdRef.current = d.callId;
      roleRef.current = 'callee';
      setPeer(d.from);
      setKind(d.kind);
      setNotice('');
      setPhase('incoming');
      ringer.current.start('incoming');
    };
    const onAccepted = async (d: { callId: string }) => {
      if (d.callId !== callIdRef.current || roleRef.current !== 'caller') return;
      ringer.current.stop();
      setPhase('connecting');
      const pc = await makePc(d.callId);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit('call:signal', { callId: d.callId, data: { sdp: pc.localDescription } });
    };
    const onSignal = async (d: { callId: string; data: any }) => {
      if (d.callId !== callIdRef.current) return;
      const pc = pcRef.current;
      if (!pc) return;
      if (d.data?.sdp) {
        await pc.setRemoteDescription(d.data.sdp);
        if (d.data.sdp.type === 'offer') {
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          socket.emit('call:signal', { callId: d.callId, data: { sdp: pc.localDescription } });
        }
        await flushIce();
      } else if (d.data?.candidate) {
        if (pc.remoteDescription) await pc.addIceCandidate(d.data.candidate).catch(() => undefined);
        else pendingIce.current.push(d.data.candidate);
      }
    };
    const onEnded = (d: { callId: string; reason: string }) => {
      if (d.callId !== callIdRef.current) return;
      cleanup(ENDED_TEXT[d.reason] || 'Call ended');
    };
    const onTaken = (d: { callId: string }) => {
      if (d.callId !== callIdRef.current) return;
      cleanup('Answered on another device');
    };
    socket.on('call:incoming', onIncoming);
    socket.on('call:accepted', onAccepted);
    socket.on('call:signal', onSignal);
    socket.on('call:ended', onEnded);
    socket.on('call:taken', onTaken);
    return () => {
      socket.off('call:incoming', onIncoming);
      socket.off('call:accepted', onAccepted);
      socket.off('call:signal', onSignal);
      socket.off('call:ended', onEnded);
      socket.off('call:taken', onTaken);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  // Call timer.
  useEffect(() => {
    if (phase !== 'active') return;
    const t = setInterval(() => startedAt.current && setSeconds(Math.floor((Date.now() - startedAt.current) / 1000)), 1000);
    return () => clearInterval(t);
  }, [phase]);

  // Keep the local preview attached as the screen changes.
  useEffect(() => {
    if (localVideo.current && localRef.current && localVideo.current.srcObject !== localRef.current) localVideo.current.srcObject = localRef.current;
    if (remoteVideo.current && remoteRef.current && remoteVideo.current.srcObject !== remoteRef.current) remoteVideo.current.srcObject = remoteRef.current;
    if (remoteAudio.current && remoteRef.current && remoteAudio.current.srcObject !== remoteRef.current) remoteAudio.current.srcObject = remoteRef.current;
  });

  // ---- actions ---------------------------------------------------------
  const accept = async () => {
    const callId = callIdRef.current;
    if (!callId) return;
    ringer.current.stop();
    setPhase('connecting');
    try {
      localRef.current = await getMedia(kind);
      if (kind === 'video' && !localRef.current.getVideoTracks().length) setCameraOff(true);
    } catch (e: any) {
      getChatSocket()?.emit('call:decline', { callId });
      return cleanup(e.message);
    }
    await makePc(callId);
    getChatSocket()?.emit('call:accept', { callId }, (r: any) => {
      if (!r?.ok) cleanup(r?.error || 'This call has ended.');
    });
  };
  const decline = () => {
    if (callIdRef.current) getChatSocket()?.emit('call:decline', { callId: callIdRef.current });
    cleanup();
  };
  const hangUp = () => {
    if (callIdRef.current) getChatSocket()?.emit('call:end', { callId: callIdRef.current });
    cleanup(phase === 'outgoing' ? 'Call cancelled' : 'Call ended');
  };
  const toggleMute = () => {
    const next = !muted;
    localRef.current?.getAudioTracks().forEach((t) => (t.enabled = !next));
    setMuted(next);
  };
  const toggleCamera = () => {
    const next = !cameraOff;
    localRef.current?.getVideoTracks().forEach((t) => (t.enabled = !next));
    setCameraOff(next);
  };

  // Leaving the page mid-call ends it cleanly.
  useEffect(() => {
    const bye = () => {
      if (callIdRef.current) getChatSocket()?.emit('call:end', { callId: callIdRef.current });
    };
    window.addEventListener('beforeunload', bye);
    return () => window.removeEventListener('beforeunload', bye);
  }, []);

  if (phase === 'idle') {
    return notice ? (
      <div className="fixed left-1/2 -translate-x-1/2 bottom-24 z-[9999] px-4 py-2.5 rounded-full bg-slate-900/90 text-white text-sm shadow-lg max-w-[90vw] text-center">
        {notice}
      </div>
    ) : null;
  }

  const showVideo = kind === 'video';
  const status =
    phase === 'outgoing'
      ? 'Ringing…'
      : phase === 'incoming'
      ? `Incoming ${kind === 'video' ? 'video' : 'audio'} call`
      : phase === 'connecting'
      ? 'Connecting…'
      : clock(seconds);

  const roundBtn = 'w-14 h-14 rounded-full flex items-center justify-center shadow-lg transition-transform active:scale-95';

  return (
    <div className="fixed inset-0 z-[9999] bg-gradient-to-b from-violet-950 via-slate-900 to-slate-950 text-white flex flex-col" role="dialog" aria-label="Call">
      <audio ref={remoteAudio} autoPlay playsInline />
      {showVideo && (
        <>
          <video
            ref={remoteVideo}
            autoPlay
            playsInline
            className={`absolute inset-0 w-full h-full object-cover ${phase === 'active' && remoteHasVideo ? 'opacity-100' : 'opacity-0'}`}
          />
          <video
            ref={localVideo}
            autoPlay
            playsInline
            muted
            className={`absolute right-4 top-4 w-28 sm:w-40 aspect-[3/4] object-cover rounded-2xl border border-white/30 shadow-xl bg-black ${cameraOff ? 'opacity-30' : ''}`}
            style={{ transform: 'scaleX(-1)' }}
          />
        </>
      )}

      <div className={`relative flex-1 flex flex-col items-center justify-center gap-3 px-6 ${showVideo && phase === 'active' && remoteHasVideo ? 'justify-start pt-10' : ''}`}>
        {!(showVideo && phase === 'active' && remoteHasVideo) && (
          <div className={`w-28 h-28 rounded-full bg-white/10 border border-white/20 flex items-center justify-center text-4xl font-semibold ${phase === 'incoming' || phase === 'outgoing' ? 'animate-pulse' : ''}`}>
            {initials(peer?.name || '')}
          </div>
        )}
        <div className="text-2xl font-semibold text-center drop-shadow">{peer?.name}</div>
        <div className="text-sm text-white/70 drop-shadow">{status}</div>
      </div>

      <div className="relative pb-12 pt-4 flex items-center justify-center gap-6">
        {phase === 'incoming' ? (
          <>
            <button type="button" onClick={decline} className={`${roundBtn} bg-rose-600 hover:bg-rose-500`} aria-label="Decline">
              <PhoneOff className="w-6 h-6" />
            </button>
            <button type="button" onClick={accept} className={`${roundBtn} bg-emerald-500 hover:bg-emerald-400`} aria-label="Accept">
              {kind === 'video' ? <Video className="w-6 h-6" /> : <Phone className="w-6 h-6" />}
            </button>
          </>
        ) : (
          <>
            <button type="button" onClick={toggleMute} className={`${roundBtn} ${muted ? 'bg-white text-slate-900' : 'bg-white/15 hover:bg-white/25'}`} aria-label={muted ? 'Unmute' : 'Mute'}>
              {muted ? <MicOff className="w-6 h-6" /> : <Mic className="w-6 h-6" />}
            </button>
            {kind === 'video' && (
              <button
                type="button"
                onClick={toggleCamera}
                className={`${roundBtn} ${cameraOff ? 'bg-white text-slate-900' : 'bg-white/15 hover:bg-white/25'}`}
                aria-label={cameraOff ? 'Turn camera on' : 'Turn camera off'}
              >
                {cameraOff ? <VideoOff className="w-6 h-6" /> : <Video className="w-6 h-6" />}
              </button>
            )}
            <button type="button" onClick={hangUp} className={`${roundBtn} bg-rose-600 hover:bg-rose-500`} aria-label="End call">
              <PhoneOff className="w-6 h-6" />
            </button>
          </>
        )}
      </div>
    </div>
  );
};
