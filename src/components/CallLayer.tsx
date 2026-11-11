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
//
// A network drop (Wi-Fi <-> mobile data, a short gap) doesn't end the call:
// the screen shows "Reconnecting…", the socket comes back with call:rejoin
// (CallRoutes.ts keeps the call for RECONNECT_MS) and the caller restarts ICE
// so the media finds the new network. Only after RECONNECT_GIVE_UP_MS
// without media does it end as "Call dropped".
//
// Minimize (like WhatsApp): the call shrinks to a small floating window —
// the other person's video (or their picture and the timer for an audio
// call) — that can be dragged to either side while the rest of the app is
// used; tapping it opens the call full again. Leaving the Android app during
// a video call puts it in the phone's own picture-in-picture window
// (MainActivity), where only the video is shown.

import { UserAvatar } from './UserAvatar';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Mic, MicOff, Phone, PhoneOff, Video, VideoOff, Volume2, Ear, SwitchCamera, Minimize2 } from 'lucide-react';
import { callAudioAvailable, setCallSpeaker, startCallAudio, stopCallAudio, takePendingCall, onCallAction, onCallHangup, onPictureInPicture, cancelIncomingCallScreen, phoneRingFirst, onRingHandover } from '../lib/callAudio';
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
  // No TURN relay on the server: phones on mobile data / strict office
  // networks often can't reach each other directly (CallRoutes.ts).
  'failed-no-turn': "Couldn't connect — the phones can't reach each other directly. Ask IT to set up the call relay (TURN) on the server.",
};
// How long "Connecting…" may last before the call is given up.
const CONNECT_TIMEOUT_MS = 25 * 1000;
// An active call whose media dropped: how long to keep trying.
const RECONNECT_GIVE_UP_MS = 40 * 1000;
// ICE "disconnected" often heals by itself; restart only if it lasts.
const ICE_RESTART_AFTER_MS = 2500;

// A soft ring made with WebAudio (no sound file needed) — the caller's
// "ringing" tone, and an incoming call on the website / an older APK. The
// Android app rings an incoming call with the phone's own ringtone instead
// (phoneRingFirst, lib/callAudio.ts).
function makeRinger() {
  const web = makeWebRinger();
  const phone = phoneRingFirst({ start: () => web.start('incoming'), stop: () => web.stop() });
  return {
    start(kind: 'incoming' | 'outgoing') {
      this.stop();
      if (kind === 'incoming') phone.start();
      else web.start('outgoing');
    },
    stop() {
      phone.stop();
      web.stop();
    }
  };
}

function makeWebRinger() {
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
  // Android app: sound on the loudspeaker (true) or the ear speaker (false).
  const [speaker, setSpeaker] = useState(false);
  const speakerChoice = callAudioAvailable();
  const [cameraOff, setCameraOff] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [notice, setNotice] = useState('');
  const [remoteHasVideo, setRemoteHasVideo] = useState(false);
  // Video call: front ('user') or back ('environment') camera.
  const [facing, setFacing] = useState<'user' | 'environment'>('user');
  const [switching, setSwitching] = useState(false);
  // Network dropped mid-call and it is coming back.
  const [reconnecting, setReconnecting] = useState(false);
  // Minimized to the floating window; where it sits (null: top right).
  const [mini, setMini] = useState(false);
  const [miniPos, setMiniPos] = useState<{ x: number; y: number } | null>(null);
  const miniDrag = useRef<{ sx: number; sy: number; ox: number; oy: number; moved: boolean } | null>(null);
  // Android picture-in-picture (app left during a video call).
  const [pip, setPip] = useState(false);

  const callIdRef = useRef<string | null>(null);
  const roleRef = useRef<'caller' | 'callee' | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localRef = useRef<MediaStream | null>(null);
  const remoteRef = useRef<MediaStream | null>(null);
  const pendingIce = useRef<RTCIceCandidateInit[]>([]);
  const iceServersRef = useRef<RTCIceServer[] | null>(null);
  // Whether the server gave a TURN relay (for the message when it fails).
  const hasTurnRef = useRef(false);
  const connectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ringer = useRef(makeRinger());
  const startedAt = useRef<number | null>(null);
  const localVideo = useRef<HTMLVideoElement>(null);
  const remoteVideo = useRef<HTMLVideoElement>(null);
  const remoteAudio = useRef<HTMLAudioElement>(null);
  const phaseRef = useRef<Phase>('idle');
  phaseRef.current = phase;
  const facingRef = useRef<'user' | 'environment'>('user');
  facingRef.current = facing;
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const iceRestartTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const makingOffer = useRef(false);
  // Accept tapped on the phone's call screen (app closed / in background):
  // answer that call as soon as it rings here.
  const pendingAnswer = useRef<{ callId: string; at: number } | null>(null);
  const acceptRef = useRef<(k?: Kind) => void>(() => undefined);

  const iceServers = useCallback(async () => {
    if (iceServersRef.current) return iceServersRef.current;
    try {
      const r = await fetch(apiUrl('/api/calls/ice-servers'), { headers: { Authorization: `Bearer ${token}` } });
      const d = await r.json();
      if (r.ok && Array.isArray(d.iceServers)) {
        iceServersRef.current = d.iceServers;
        hasTurnRef.current = !!d.turn;
      }
    } catch {
      // fall back to public STUN below
    }
    return iceServersRef.current || [{ urls: 'stun:stun.l.google.com:19302' }];
  }, [token]);

  const cleanup = useCallback((text?: string) => {
    ringer.current.stop();
    cancelIncomingCallScreen(callIdRef.current);
    if (connectTimer.current) clearTimeout(connectTimer.current);
    connectTimer.current = null;
    if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
    reconnectTimer.current = null;
    if (iceRestartTimer.current) clearTimeout(iceRestartTimer.current);
    iceRestartTimer.current = null;
    makingOffer.current = false;
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
    setSpeaker(false);
    void stopCallAudio();
    setCameraOff(false);
    setSeconds(0);
    setRemoteHasVideo(false);
    setFacing('user');
    setSwitching(false);
    setReconnecting(false);
    setMini(false);
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
    const giveUp = () => {
      if (pc !== pcRef.current || !callIdRef.current || phaseRef.current === 'active') return;
      getChatSocket()?.emit('call:end', { callId: callIdRef.current });
      cleanup(hasTurnRef.current ? ENDED_TEXT.failed : ENDED_TEXT['failed-no-turn']);
    };
    const connected = () => {
      if (pc !== pcRef.current) return;
      // Back after a drop.
      if (iceRestartTimer.current) clearTimeout(iceRestartTimer.current);
      iceRestartTimer.current = null;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      reconnectTimer.current = null;
      setReconnecting(false);
      if (phaseRef.current === 'active') return;
      if (connectTimer.current) clearTimeout(connectTimer.current);
      connectTimer.current = null;
      startedAt.current = Date.now();
      setPhase('active');
    };
    // The media dropped during the call: keep the call, try to get it back.
    const lost = (hard: boolean) => {
      if (pc !== pcRef.current) return;
      if (phaseRef.current !== 'active') {
        if (hard) giveUp();
        return;
      }
      setReconnecting(true);
      if (!reconnectTimer.current) {
        reconnectTimer.current = setTimeout(() => {
          reconnectTimer.current = null;
          if (pc !== pcRef.current || !callIdRef.current) return;
          getChatSocket()?.emit('call:end', { callId: callIdRef.current });
          cleanup(ENDED_TEXT.disconnected);
        }, RECONNECT_GIVE_UP_MS);
      }
      if (iceRestartTimer.current) clearTimeout(iceRestartTimer.current);
      // Keep trying every few seconds (the network may take a while to come
      // back) until the media reconnects or RECONNECT_GIVE_UP_MS runs out.
      const tryAgain = (ms: number) => {
        iceRestartTimer.current = setTimeout(() => {
          iceRestartTimer.current = null;
          if (pc !== pcRef.current || pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') return;
          void restartIce();
          tryAgain(5000);
        }, ms);
      };
      tryAgain(hard ? 0 : ICE_RESTART_AFTER_MS);
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') connected();
      if (pc.connectionState === 'disconnected') lost(false);
      if (pc.connectionState === 'failed') lost(true);
    };
    // Some WebViews only report the ICE state.
    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') connected();
      if (pc.iceConnectionState === 'disconnected') lost(false);
      if (pc.iceConnectionState === 'failed') lost(true);
    };
    // Never stuck on "Connecting…": give up after a while.
    if (connectTimer.current) clearTimeout(connectTimer.current);
    connectTimer.current = setTimeout(giveUp, CONNECT_TIMEOUT_MS);
    return pc;
  };

  // New network paths for the media. Only the caller makes offers (no
  // collisions); the callee asks the caller to.
  const restartIce = async () => {
    const pc = pcRef.current;
    const callId = callIdRef.current;
    const socket = getChatSocket();
    if (!pc || !callId || !socket?.connected) return; // the socket's reconnect retries
    if (roleRef.current !== 'caller') {
      socket.emit('call:signal', { callId, data: { restart: true } });
      return;
    }
    if (makingOffer.current || pc.signalingState !== 'stable') return;
    makingOffer.current = true;
    try {
      const offer = await pc.createOffer({ iceRestart: true });
      await pc.setLocalDescription(offer);
      socket.emit('call:signal', { callId, data: { sdp: pc.localDescription } });
    } catch {
      // tried again on the next state change / reconnect
    } finally {
      makingOffer.current = false;
    }
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
        // Like a phone call: ear speaker for audio, loudspeaker for video.
        if (await startCallAudio(d.kind === 'video')) setSpeaker(d.kind === 'video');
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
      // Rings here now: the phone's own call screen isn't needed — unless
      // the app is in the background (then that screen keeps ringing).
      cancelIncomingCallScreen(d.callId, true);
      const p = pendingAnswer.current;
      if (p && p.callId === d.callId && Date.now() - p.at < 60_000) {
        pendingAnswer.current = null;
        setTimeout(() => acceptRef.current(d.kind), 0);
        return;
      }
      ringer.current.start('incoming');
    };
    const onAccepted = async (d: { callId: string }) => {
      if (d.callId !== callIdRef.current || roleRef.current !== 'caller' || pcRef.current) return;
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
      if (d.data?.restart) {
        if (roleRef.current === 'caller') void restartIce();
        return;
      }
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
    // The other side's connection dropped / is back (CallRoutes.ts).
    const onPeerAway = (d: { callId: string }) => {
      if (d.callId === callIdRef.current && phaseRef.current === 'active') setReconnecting(true);
    };
    // Media still flowing (only the signalling dropped): nothing to redo.
    const mediaUp = () => {
      const pc = pcRef.current;
      return !!pc && (pc.connectionState === 'connected' || pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed');
    };
    const onPeerBack = (d: { callId: string }) => {
      if (d.callId !== callIdRef.current) return;
      if (mediaUp()) return setReconnecting(false);
      if (roleRef.current === 'caller' && pcRef.current) void restartIce();
    };
    // Our own socket came back after a drop: tell the server we're still in
    // the call, then get the media going again.
    const onReconnect = () => {
      const callId = callIdRef.current;
      if (!callId || phaseRef.current === 'idle' || phaseRef.current === 'incoming') return;
      socket.emit('call:rejoin', { callId }, (r: any) => {
        if (callId !== callIdRef.current) return;
        if (!r?.ok) return cleanup(ENDED_TEXT.disconnected);
        // Accepted while we were offline: start the media now.
        if (roleRef.current === 'caller' && r.state === 'active' && !pcRef.current) return void onAccepted({ callId });
        if (mediaUp()) setReconnecting(false);
        else if (pcRef.current) void restartIce();
      });
    };
    socket.on('connect', onReconnect);
    socket.on('call:peer-away', onPeerAway);
    socket.on('call:peer-back', onPeerBack);
    socket.on('call:incoming', onIncoming);
    socket.on('call:accepted', onAccepted);
    socket.on('call:signal', onSignal);
    socket.on('call:ended', onEnded);
    socket.on('call:taken', onTaken);
    return () => {
      socket.off('connect', onReconnect);
      socket.off('call:peer-away', onPeerAway);
      socket.off('call:peer-back', onPeerBack);
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

  // Opened from the phone's call screen: Accept answers that call when it
  // rings here (the server announces it again once the socket is up).
  useEffect(() => {
    const take = (d: { callId: string; action: 'accept' | 'open' } | null) => {
      if (!d) return;
      if (d.action === 'accept') {
        // Already ringing here (app was in the background): answer now.
        if (phaseRef.current === 'incoming' && callIdRef.current === d.callId) return void acceptRef.current();
        pendingAnswer.current = { callId: d.callId, at: Date.now() };
      }
      getChatSocket()?.emit('call:announce');
    };
    void takePendingCall().then(take);
    return onCallAction(take);
  }, []);

  // ---- actions ---------------------------------------------------------
  const accept = async (k: Kind = kind) => {
    const callId = callIdRef.current;
    if (!callId) return;
    ringer.current.stop();
    setPhase('connecting');
    try {
      localRef.current = await getMedia(k);
      if (k === 'video' && !localRef.current.getVideoTracks().length) setCameraOff(true);
      if (await startCallAudio(k === 'video')) setSpeaker(k === 'video');
    } catch (e: any) {
      getChatSocket()?.emit('call:decline', { callId });
      return cleanup(e.message);
    }
    await makePc(callId);
    getChatSocket()?.emit('call:accept', { callId }, (r: any) => {
      if (!r?.ok) cleanup(r?.error || 'This call has ended.');
    });
  };
  acceptRef.current = (k?: Kind) => void accept(k);
  const decline = () => {
    if (callIdRef.current) getChatSocket()?.emit('call:decline', { callId: callIdRef.current });
    cleanup();
  };
  const hangUp = () => {
    if (callIdRef.current) getChatSocket()?.emit('call:end', { callId: callIdRef.current });
    cleanup(phase === 'outgoing' ? 'Call cancelled' : 'Call ended');
  };
  const hangUpRef = useRef(hangUp);
  hangUpRef.current = hangUp;
  // Hang up on the "Call in progress" notification (app left mid-call).
  useEffect(
    () =>
      onCallHangup(() => {
        if (callIdRef.current) hangUpRef.current();
      }),
    []
  );
  // Back on screen (e.g. an iPhone Home Screen app opened from its call
  // notification — iOS keeps the old connection looking alive while the app
  // sleeps): ask whether a call is ringing for us, so it rings here.
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === 'visible' && phaseRef.current === 'idle') getChatSocket()?.emit('call:announce');
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  // The app came on screen while the phone's call screen rang: ring here.
  useEffect(
    () =>
      onRingHandover(() => {
        if (phaseRef.current === 'incoming') ringer.current.start('incoming');
      }),
    []
  );
  const toggleMute = () => {
    const next = !muted;
    localRef.current?.getAudioTracks().forEach((t) => (t.enabled = !next));
    setMuted(next);
  };
  const toggleSpeaker = async () => {
    const next = !speaker;
    if (await setCallSpeaker(next)) setSpeaker(next);
  };
  const toggleCamera = () => {
    const next = !cameraOff;
    localRef.current?.getVideoTracks().forEach((t) => (t.enabled = !next));
    setCameraOff(next);
  };

  // Front <-> back camera. Many phones can't open both at once, so the old
  // camera is let go first; the new picture replaces the old one in the call
  // without renegotiating (RTCRtpSender.replaceTrack).
  const switchCamera = async () => {
    const stream = localRef.current;
    if (!stream || switching) return;
    const old = stream.getVideoTracks()[0];
    const next = facingRef.current === 'user' ? 'environment' : 'user';
    const sender = pcRef.current?.getSenders().find((x) => x.track === old || x.track?.kind === 'video');
    const open = (f: 'user' | 'environment', exact: boolean) =>
      navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: exact ? { exact: f } : f, width: { ideal: 640 }, height: { ideal: 480 } },
      });
    setSwitching(true);
    try {
      old?.stop();
      let fresh: MediaStream;
      let got: 'user' | 'environment' = next;
      try {
        fresh = await open(next, true);
      } catch {
        try {
          fresh = await open(next, false);
        } catch {
          // No other camera: put the one we had back.
          fresh = await open(facingRef.current, false);
          got = facingRef.current;
          setNotice('This phone has only one camera.');
          setTimeout(() => setNotice(''), 2500);
        }
      }
      const track = fresh.getVideoTracks()[0];
      if (!track) return;
      track.enabled = !cameraOff;
      if (old) stream.removeTrack(old);
      stream.addTrack(track);
      if (sender) await sender.replaceTrack(track);
      else pcRef.current?.addTrack(track, stream);
      if (localVideo.current) {
        localVideo.current.srcObject = null;
        localVideo.current.srcObject = stream;
      }
      setFacing(got);
    } catch {
      setNotice("Couldn't switch the camera.");
      setTimeout(() => setNotice(''), 2500);
    } finally {
      setSwitching(false);
    }
  };

  // Android picture-in-picture on / off (MainActivity via CallAudioPlugin).
  useEffect(() => onPictureInPicture(setPip), []);
  // A call that starts ringing here is always shown full.
  useEffect(() => {
    if (phase === 'incoming') setMini(false);
  }, [phase]);

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
      : reconnecting
      ? 'Reconnecting…'
      : clock(seconds);

  const roundBtn = 'w-14 h-14 rounded-full flex items-center justify-center shadow-lg transition-transform active:scale-95';

  // A labelled round button (Mute / Speaker / Camera / End).
  const control = (label: string, on: boolean, onClick: () => void, icon: React.ReactNode, cls?: string) => (
    <div className="flex flex-col items-center gap-1.5 w-[64px] sm:w-[72px]">
      <button
        type="button"
        onClick={onClick}
        aria-pressed={on}
        aria-label={label}
        className={`${roundBtn} ${cls || (on ? 'bg-white text-slate-900' : 'bg-white/15 hover:bg-white/25')}`}
      >
        {icon}
      </button>
      <span className="text-[11.5px] text-white/80">{label}</span>
    </div>
  );

  // ---- minimized: the floating window ------------------------------------
  const videoShown = showVideo && phase === 'active' && remoteHasVideo;
  const miniW = showVideo ? 120 : 216;
  const miniH = showVideo ? 172 : 64;
  const clampMini = (x: number, y: number) => {
    const m = 12;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    return { x: Math.min(Math.max(m, x), vw - miniW - m), y: Math.min(Math.max(m + 48, y), vh - miniH - 88) };
  };
  const pos = clampMini(miniPos?.x ?? window.innerWidth, miniPos?.y ?? 72);
  const miniHandlers = mini
    ? {
        onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => {
          if ((e.target as Element).closest('button')) return;
          miniDrag.current = { sx: e.clientX, sy: e.clientY, ox: pos.x, oy: pos.y, moved: false };
          e.currentTarget.setPointerCapture(e.pointerId);
        },
        onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => {
          const d = miniDrag.current;
          if (!d) return;
          const dx = e.clientX - d.sx;
          const dy = e.clientY - d.sy;
          if (!d.moved && Math.abs(dx) + Math.abs(dy) < 8) return;
          d.moved = true;
          setMiniPos(clampMini(d.ox + dx, d.oy + dy));
        },
        onPointerUp: () => {
          const d = miniDrag.current;
          miniDrag.current = null;
          if (!d) return;
          // A tap opens the call again; a drag settles on the nearer side.
          if (!d.moved) return setMini(false);
          setMiniPos((p) => {
            const cur = p || pos;
            return clampMini(cur.x + miniW / 2 < window.innerWidth / 2 ? 0 : window.innerWidth, cur.y);
          });
        },
        onPointerCancel: () => {
          miniDrag.current = null;
        }
      }
    : {};

  const rootClass = pip
    ? 'fixed inset-0 z-[9999] bg-black text-white overflow-hidden'
    : mini
    ? 'fixed z-[9999] rounded-2xl overflow-hidden shadow-2xl ring-1 ring-white/25 bg-gradient-to-b from-violet-950 to-slate-900 text-white touch-none select-none cursor-pointer'
    : 'fixed inset-0 z-[9999] bg-gradient-to-b from-violet-950 via-slate-900 to-slate-950 text-white flex flex-col';
  const rootStyle: React.CSSProperties | undefined = mini && !pip ? { left: pos.x, top: pos.y, width: miniW, height: miniH } : undefined;
  const compact = pip || mini;

  return createPortal(
    <div className={rootClass} style={rootStyle} role="dialog" aria-label={mini ? 'Call (minimized) — tap to open' : 'Call'} {...miniHandlers}>
      <audio ref={remoteAudio} autoPlay playsInline />
      {showVideo && (
        <>
          <video
            ref={remoteVideo}
            autoPlay
            playsInline
            className={`absolute inset-0 w-full h-full object-cover pointer-events-none ${videoShown ? 'opacity-100' : 'opacity-0'}`}
          />
          <video
            ref={localVideo}
            autoPlay
            playsInline
            muted
            className={`absolute right-4 top-4 w-28 sm:w-40 aspect-[3/4] object-cover rounded-2xl border border-white/30 shadow-xl bg-black ${cameraOff ? 'opacity-30' : ''} ${compact ? 'hidden' : ''}`}
            // Mirror only the front camera, like the phone's own camera app.
            style={facing === 'user' ? { transform: 'scaleX(-1)' } : undefined}
          />
        </>
      )}

      {compact ? (
        showVideo ? (
          <>
            {!videoShown && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 px-2 pointer-events-none">
                <UserAvatar
                  userId={(peer as any)?.id ?? (peer as any)?.user_id}
                  name={peer?.name || ''}
                  fallback={initials(peer?.name || '')}
                  className={`${pip ? 'w-16 h-16 text-xl' : 'w-12 h-12 text-base'} border border-white/20`}
                  color="rgba(255,255,255,0.1)"
                />
                <div className="text-[11px] font-semibold text-center leading-tight line-clamp-2">{peer?.name}</div>
              </div>
            )}
            <div className="absolute top-0 inset-x-0 pt-1.5 pb-3 text-center text-[10.5px] font-semibold bg-gradient-to-b from-black/60 to-transparent pointer-events-none">
              <span className={reconnecting ? 'text-amber-300' : ''}>{status}</span>
            </div>
            {mini && !pip && (
              <button
                type="button"
                onClick={hangUp}
                aria-label="End call"
                className="absolute bottom-2 left-1/2 -translate-x-1/2 w-9 h-9 rounded-full bg-rose-600 hover:bg-rose-500 flex items-center justify-center shadow-lg"
              >
                <PhoneOff className="w-4 h-4" />
              </button>
            )}
          </>
        ) : (
          <div className="h-full flex items-center gap-2.5 pl-2.5 pr-2">
            <UserAvatar
              userId={(peer as any)?.id ?? (peer as any)?.user_id}
              name={peer?.name || ''}
              fallback={initials(peer?.name || '')}
              className="w-10 h-10 text-sm border border-white/20 shrink-0"
              color="rgba(255,255,255,0.1)"
            />
            <div className="flex-1 min-w-0 pointer-events-none">
              <div className="text-[13px] font-semibold truncate">{peer?.name}</div>
              <div className={`text-[11px] ${reconnecting ? 'text-amber-300' : 'text-white/70'}`}>{status}</div>
            </div>
            {!pip && (
              <button
                type="button"
                onClick={hangUp}
                aria-label="End call"
                className="w-9 h-9 rounded-full bg-rose-600 hover:bg-rose-500 flex items-center justify-center shrink-0"
              >
                <PhoneOff className="w-4 h-4" />
              </button>
            )}
          </div>
        )
      ) : (
        <>
          {phase !== 'incoming' && (
            <button
              type="button"
              onClick={() => setMini(true)}
              aria-label="Minimize call"
              title="Minimize"
              className="absolute left-4 z-10 w-11 h-11 rounded-full bg-white/15 hover:bg-white/25 backdrop-blur flex items-center justify-center"
              style={{ top: 'max(1rem, calc(env(safe-area-inset-top) + 0.5rem))' }}
            >
              <Minimize2 className="w-5 h-5" />
            </button>
          )}
      <div className={`relative flex-1 flex flex-col items-center justify-center gap-3 px-6 ${videoShown ? 'justify-start pt-10' : ''}`}>
        {!videoShown && (
          <UserAvatar
            userId={(peer as any)?.id ?? (peer as any)?.user_id}
            name={peer?.name || ''}
            fallback={initials(peer?.name || '')}
            className={`w-28 h-28 text-4xl border border-white/20 ${phase === 'incoming' || phase === 'outgoing' ? 'animate-pulse' : ''}`}
            color="rgba(255,255,255,0.1)"
          />
        )}
        <div className="text-2xl font-semibold text-center drop-shadow">{peer?.name}</div>
        <div className={`text-sm drop-shadow ${reconnecting ? 'text-amber-300 animate-pulse' : 'text-white/70'}`}>{status}</div>
        {notice && <div className="text-xs text-white/80 bg-black/40 rounded-full px-3 py-1">{notice}</div>}
      </div>
      <div className="relative pt-4 px-2 flex flex-wrap items-start justify-center gap-x-1 gap-y-3 sm:gap-6" style={{ paddingBottom: 'max(3rem, calc(var(--native-safe-area-inset-bottom, env(safe-area-inset-bottom, 0px)) + 2rem))' }}>
        {phase === 'incoming' ? (
          <>
            <button type="button" onClick={decline} className={`${roundBtn} bg-rose-600 hover:bg-rose-500`} aria-label="Decline">
              <PhoneOff className="w-6 h-6" />
            </button>
            <button type="button" onClick={() => void accept()} className={`${roundBtn} bg-emerald-500 hover:bg-emerald-400`} aria-label="Accept">
              {kind === 'video' ? <Video className="w-6 h-6" /> : <Phone className="w-6 h-6" />}
            </button>
          </>
        ) : (
          <>
            {control(muted ? 'Unmute' : 'Mute', muted, toggleMute, muted ? <MicOff className="w-6 h-6" /> : <Mic className="w-6 h-6" />)}
            {speakerChoice &&
              control(speaker ? 'Speaker' : 'Earpiece', speaker, toggleSpeaker, speaker ? <Volume2 className="w-6 h-6" /> : <Ear className="w-6 h-6" />)}
            {kind === 'video' &&
              control(cameraOff ? 'Camera on' : 'Camera off', cameraOff, toggleCamera, cameraOff ? <VideoOff className="w-6 h-6" /> : <Video className="w-6 h-6" />)}
            {kind === 'video' && !cameraOff && control('Flip', false, switchCamera, <SwitchCamera className={`w-6 h-6 ${switching ? 'animate-spin' : ''}`} />)}
            {control('End', false, hangUp, <PhoneOff className="w-6 h-6" />, 'bg-rose-600 hover:bg-rose-500')}
          </>
        )}
      </div>
        </>
      )}
    </div>,
    document.body
  );
};
