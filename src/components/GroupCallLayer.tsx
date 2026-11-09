/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Chat group calls (GroupCallRoutes.ts) — the call screen, mounted once next
// to CallLayer for accounts with Calls access.
//
//   start: dispatch `credence:start-group-call` { roomId, title, kind }
//   join:  dispatch `credence:join-group-call`  { callId, roomId, title, kind }
//          (ChatPanel's group header buttons and its "Join" bar do)
//
// Mesh WebRTC: one RTCPeerConnection per other participant. The one who joins
// sends the offers to everyone already in; the others answer. ICE candidates
// that arrive before the answer/offer is in place wait in a queue.

import { UserAvatar } from './UserAvatar';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Mic, MicOff, Phone, PhoneOff, Video, VideoOff, Volume2, Ear, SwitchCamera, Users } from 'lucide-react';
import { Capacitor } from '@capacitor/core';
import { callAudioAvailable, onCallHangup, setCallSpeaker, startCallAudio, stopCallAudio } from '../lib/callAudio';
import { apiUrl } from '../lib/api';
import { connectChatSocket, getChatSocket } from '../lib/chatSocket';

type Kind = 'audio' | 'video';
export interface GroupCallDetail {
  roomId: number;
  title: string;
  kind: Kind;
  callId?: string;
}
interface Remote {
  socketId: string;
  userId: number;
  name: string;
  stream: MediaStream;
  hasVideo: boolean;
  state: 'connecting' | 'connected' | 'lost';
}
interface Incoming {
  callId: string;
  roomId: number;
  title: string;
  kind: Kind;
  from: { id: number; name: string };
}

const RING_FOR_MS = 45 * 1000;
const clock = (s: number) => {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
};

// Two soft beeps every 1.6 s while a group call rings here.
function makeRinger() {
  let ctx: AudioContext | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  const beep = (f: number, len: number) => {
    if (!ctx) return;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.value = f;
    g.gain.value = 0.0001;
    o.connect(g).connect(ctx.destination);
    const t = ctx.currentTime;
    g.gain.exponentialRampToValueAtTime(0.16, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + len);
    o.start(t);
    o.stop(t + len + 0.05);
  };
  return {
    start() {
      this.stop();
      try {
        ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
      } catch {
        return;
      }
      const play = () => {
        beep(784, 0.22);
        setTimeout(() => beep(988, 0.3), 280);
      };
      play();
      timer = setInterval(play, 1600);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      if (ctx) ctx.close().catch(() => undefined);
      ctx = null;
    }
  };
}

// A participant's tile: their video, or their photo / initials.
const Tile: React.FC<{ token: string; name: string; userId: number; stream: MediaStream | null; video: boolean; mirror?: boolean; muted?: boolean; note?: string; you?: boolean }> = ({
  token,
  name,
  userId,
  stream,
  video,
  mirror,
  muted,
  note,
  you
}) => {
  const ref = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    if (ref.current && stream && ref.current.srcObject !== stream) ref.current.srcObject = stream;
  }, [stream, video]);
  return (
    <div className="relative rounded-2xl overflow-hidden bg-white/5 border border-white/10 flex items-center justify-center min-h-0">
      {video && stream ? (
        <video ref={ref} autoPlay playsInline muted={you} className="absolute inset-0 w-full h-full object-cover" style={mirror ? { transform: 'scaleX(-1)' } : undefined} />
      ) : (
        <UserAvatar userId={userId} name={name} token={token} className="w-16 h-16 sm:w-20 sm:h-20 text-xl border border-white/20" color="rgba(255,255,255,0.1)" />
      )}
      <div className="absolute left-2 bottom-2 right-2 flex items-center gap-1.5 text-[11px]">
        <span className="truncate bg-black/45 rounded-full px-2 py-0.5">
          {you ? 'You' : name}
          {note ? ` · ${note}` : ''}
        </span>
        {muted && (
          <span className="shrink-0 bg-black/45 rounded-full p-1" aria-label="Muted">
            <MicOff className="w-3 h-3" />
          </span>
        )}
      </div>
    </div>
  );
};

export const GroupCallLayer: React.FC<{ token: string; userId: number; userName: string }> = ({ token, userId, userName }) => {
  const [incoming, setIncoming] = useState<Incoming | null>(null);
  const [call, setCall] = useState<{ callId: string; roomId: number; title: string; kind: Kind; startedAt: number } | null>(null);
  const [joining, setJoining] = useState(false);
  const [remotes, setRemotes] = useState<Remote[]>([]);
  const [notice, setNotice] = useState('');
  const [muted, setMuted] = useState(false);
  const [cameraOff, setCameraOff] = useState(false);
  const [speaker, setSpeaker] = useState(true);
  const [facing, setFacing] = useState<'user' | 'environment'>('user');
  const [seconds, setSeconds] = useState(0);

  const localRef = useRef<MediaStream | null>(null);
  const pcs = useRef(new Map<string, RTCPeerConnection>());
  const pending = useRef(new Map<string, RTCIceCandidateInit[]>());
  const callRef = useRef<typeof call>(null);
  callRef.current = call;
  const ringer = useRef(makeRinger());
  const ringTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const iceRef = useRef<RTCIceServer[] | null>(null);
  // socket id -> name, from gcall:joined (their offer comes right after).
  const names = useRef(new Map<string, string>());

  const iceServers = useCallback(async () => {
    if (iceRef.current) return iceRef.current;
    try {
      const r = await fetch(apiUrl('/api/calls/ice-servers'), { headers: { Authorization: `Bearer ${token}` } });
      const d = await r.json();
      if (r.ok && Array.isArray(d.iceServers)) iceRef.current = d.iceServers;
    } catch {
      /* STUN below */
    }
    return iceRef.current || [{ urls: 'stun:stun.l.google.com:19302' }];
  }, [token]);

  const flash = (text: string) => {
    setNotice(text);
    setTimeout(() => setNotice((n) => (n === text ? '' : n)), 4000);
  };

  const stopRinging = useCallback(() => {
    ringer.current.stop();
    if (ringTimer.current) clearTimeout(ringTimer.current);
    ringTimer.current = null;
    setIncoming(null);
  }, []);

  const patchRemote = (socketId: string, patch: Partial<Remote>) => setRemotes((prev) => prev.map((r) => (r.socketId === socketId ? { ...r, ...patch } : r)));
  const dropPeer = (socketId: string) => {
    pcs.current.get(socketId)?.close();
    pcs.current.delete(socketId);
    pending.current.delete(socketId);
    setRemotes((prev) => prev.filter((r) => r.socketId !== socketId));
  };

  const cleanup = useCallback((text?: string) => {
    for (const pc of pcs.current.values()) pc.close();
    pcs.current.clear();
    pending.current.clear();
    localRef.current?.getTracks().forEach((t) => t.stop());
    localRef.current = null;
    void stopCallAudio();
    setRemotes([]);
    setCall(null);
    setJoining(false);
    setMuted(false);
    setCameraOff(false);
    setFacing('user');
    if (text) flash(text);
  }, []);

  // A connection to one participant. `offer`: we are the newcomer, we call them.
  const makePeer = useCallback(
    async (callId: string, other: { socketId: string; userId: number; name: string }, offer: boolean) => {
      const existing = pcs.current.get(other.socketId);
      if (existing) return existing;
      const pc = new RTCPeerConnection({ iceServers: await iceServers() });
      pcs.current.set(other.socketId, pc);
      const stream = new MediaStream();
      setRemotes((prev) => [...prev.filter((r) => r.socketId !== other.socketId), { ...other, stream, hasVideo: false, state: 'connecting' }]);
      localRef.current?.getTracks().forEach((t) => pc.addTrack(t, localRef.current!));
      pc.onicecandidate = (e) => {
        if (e.candidate) getChatSocket()?.emit('gcall:signal', { callId, to: other.socketId, data: { candidate: e.candidate.toJSON() } });
      };
      pc.ontrack = (e) => {
        if (!stream.getTracks().includes(e.track)) stream.addTrack(e.track);
        if (e.track.kind === 'video') patchRemote(other.socketId, { hasVideo: true });
      };
      pc.onconnectionstatechange = () => {
        const s = pc.connectionState;
        if (s === 'connected') patchRemote(other.socketId, { state: 'connected' });
        else if (s === 'failed' || s === 'disconnected') patchRemote(other.socketId, { state: 'lost' });
      };
      if (offer) {
        const o = await pc.createOffer();
        await pc.setLocalDescription(o);
        getChatSocket()?.emit('gcall:signal', { callId, to: other.socketId, data: { sdp: pc.localDescription } });
      }
      return pc;
    },
    [iceServers]
  );

  const getMedia = async (k: Kind) => {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error(window.isSecureContext ? "This device or browser doesn't support calls." : 'Calls need the secure (https://) address.');
    const audio = { echoCancellation: true, noiseSuppression: true };
    // Smaller video than a one-to-one call: everyone sends to everyone.
    const video = k === 'video' ? { facingMode: 'user', width: { ideal: 480 }, height: { ideal: 360 }, frameRate: { ideal: 15 } } : false;
    try {
      return await navigator.mediaDevices.getUserMedia({ audio, video });
    } catch (e: any) {
      if (k === 'video') {
        try {
          return await navigator.mediaDevices.getUserMedia({ audio, video: false });
        } catch {
          /* message below */
        }
      }
      const name = String(e?.name || '');
      if (name === 'NotFoundError') throw new Error('No microphone found on this device.');
      if (name === 'NotReadableError' || name === 'AbortError') throw new Error('The microphone is in use by another app — close it and try again.');
      throw new Error(
        Capacitor.isNativePlatform()
          ? 'Microphone permission is off for CredenceHR. Turn it on in phone Settings → Apps → CredenceHR → Permissions, then try again.'
          : 'Allow the microphone (and camera for video) for this site in the browser, then try again.'
      );
    }
  };

  const join = useCallback(
    async (d: { callId: string; roomId: number; title: string; kind: Kind }) => {
      if (callRef.current || joining) return;
      stopRinging();
      setJoining(true);
      try {
        localRef.current = await getMedia(d.kind);
        if (d.kind === 'video' && !localRef.current.getVideoTracks().length) setCameraOff(true);
        if (await startCallAudio(true)) setSpeaker(true);
      } catch (e: any) {
        setJoining(false);
        return flash(e.message);
      }
      const socket = getChatSocket() || connectChatSocket(token);
      socket.emit('gcall:join', { callId: d.callId }, async (r: any) => {
        if (!r?.ok) return cleanup(r?.error || 'This call has ended.');
        setCall({ callId: d.callId, roomId: r.roomId ?? d.roomId, title: r.title || d.title, kind: r.kind || d.kind, startedAt: r.startedAt || Date.now() });
        setJoining(false);
        for (const p of r.participants || []) await makePeer(d.callId, p, true);
      });
    },
    [joining, token, cleanup, makePeer, stopRinging]
  );
  const joinRef = useRef(join);
  joinRef.current = join;

  const leave = useCallback(() => {
    const c = callRef.current;
    if (c) getChatSocket()?.emit('gcall:leave', { callId: c.callId });
    cleanup('You left the call');
  }, [cleanup]);

  // ---- socket events --------------------------------------------------------
  useEffect(() => {
    const socket = getChatSocket() || connectChatSocket(token);
    const onIncoming = (d: Incoming) => {
      if (callRef.current || d.from?.id === userId) return;
      setIncoming(d);
      ringer.current.start();
      if (ringTimer.current) clearTimeout(ringTimer.current);
      ringTimer.current = setTimeout(stopRinging, RING_FOR_MS);
    };
    const onStopRing = ({ callId }: { callId: string }) => setIncoming((cur) => (cur && cur.callId === callId ? (ringer.current.stop(), null) : cur));
    const onEnded = ({ callId }: { callId: string }) => {
      onStopRing({ callId });
      if (callRef.current?.callId === callId) cleanup('The call ended');
    };
    const onJoined = (d: { callId: string; socketId: string; userId: number; name: string }) => {
      if (callRef.current?.callId !== d.callId) return;
      names.current.set(d.socketId, d.name);
      // They will send us an offer; show their tile already.
      setRemotes((prev) => (prev.some((r) => r.socketId === d.socketId) ? prev : [...prev, { socketId: d.socketId, userId: d.userId, name: d.name, stream: new MediaStream(), hasVideo: false, state: 'connecting' }]));
      flash(`${d.name} joined`);
    };
    const onLeft = (d: { callId: string; socketId: string; userId: number }) => {
      if (callRef.current?.callId !== d.callId) return;
      dropPeer(d.socketId);
    };
    const onSignal = async (d: { callId: string; from: string; fromUser: number; data: any }) => {
      const c = callRef.current;
      if (!c || c.callId !== d.callId) return;
      try {
        if (d.data?.sdp) {
          const desc = d.data.sdp as RTCSessionDescriptionInit;
          let pc = pcs.current.get(d.from);
          if (!pc) {
            // A newcomer's offer: answer it. Their name comes with gcall:joined.
            pc = await makePeer(c.callId, { socketId: d.from, userId: d.fromUser, name: names.current.get(d.from) || 'Participant' }, false);
          }
          await pc.setRemoteDescription(desc);
          for (const cand of pending.current.get(d.from) || []) await pc.addIceCandidate(cand).catch(() => undefined);
          pending.current.delete(d.from);
          if (desc.type === 'offer') {
            const a = await pc.createAnswer();
            await pc.setLocalDescription(a);
            getChatSocket()?.emit('gcall:signal', { callId: c.callId, to: d.from, data: { sdp: pc.localDescription } });
          }
        } else if (d.data?.candidate) {
          const pc = pcs.current.get(d.from);
          if (pc?.remoteDescription) await pc.addIceCandidate(d.data.candidate).catch(() => undefined);
          else pending.current.set(d.from, [...(pending.current.get(d.from) || []), d.data.candidate]);
        }
      } catch {
        // one participant's hiccup doesn't end the call for the rest
      }
    };
    socket.on('gcall:incoming', onIncoming);
    socket.on('gcall:stop-ring', onStopRing);
    socket.on('gcall:ended', onEnded);
    socket.on('gcall:joined', onJoined);
    socket.on('gcall:left', onLeft);
    socket.on('gcall:signal', onSignal);
    return () => {
      socket.off('gcall:incoming', onIncoming);
      socket.off('gcall:stop-ring', onStopRing);
      socket.off('gcall:ended', onEnded);
      socket.off('gcall:joined', onJoined);
      socket.off('gcall:left', onLeft);
      socket.off('gcall:signal', onSignal);
    };
  }, [token, userId, cleanup, makePeer, stopRinging]);

  // Start / join from Chat.
  useEffect(() => {
    const onStart = (e: Event) => {
      const d = (e as CustomEvent<GroupCallDetail>).detail;
      if (!d || callRef.current) return;
      (getChatSocket() || connectChatSocket(token)).emit('gcall:start', { roomId: d.roomId, kind: d.kind }, (r: any) => {
        if (!r?.ok) return flash(r?.error || "Couldn't start the call.");
        void joinRef.current({ callId: r.callId, roomId: d.roomId, title: d.title, kind: r.kind || d.kind });
      });
    };
    const onJoin = (e: Event) => {
      const d = (e as CustomEvent<GroupCallDetail>).detail;
      if (d?.callId) void joinRef.current({ callId: d.callId, roomId: d.roomId, title: d.title, kind: d.kind });
    };
    window.addEventListener('credence:start-group-call', onStart);
    window.addEventListener('credence:join-group-call', onJoin);
    return () => {
      window.removeEventListener('credence:start-group-call', onStart);
      window.removeEventListener('credence:join-group-call', onJoin);
    };
  }, [token]);

  // Call timer.
  useEffect(() => {
    if (!call) return;
    const tick = () => setSeconds(Math.max(0, Math.round((Date.now() - call.startedAt) / 1000)));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [call]);

  // Hang up on the "Call in progress" notification (app left mid-call).
  const leaveRef = useRef(leave);
  leaveRef.current = leave;
  useEffect(
    () =>
      onCallHangup(() => {
        if (callRef.current) leaveRef.current();
      }),
    []
  );

  // Leaving the page mid-call: tell the others.
  useEffect(() => {
    const bye = () => {
      const c = callRef.current;
      if (c) getChatSocket()?.emit('gcall:leave', { callId: c.callId });
    };
    window.addEventListener('pagehide', bye);
    return () => window.removeEventListener('pagehide', bye);
  }, []);

  // ---- controls -------------------------------------------------------------------
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
  const toggleSpeaker = async () => {
    if (await setCallSpeaker(!speaker)) setSpeaker(!speaker);
  };
  const switchCamera = async () => {
    const stream = localRef.current;
    const old = stream?.getVideoTracks()[0];
    if (!stream || !old) return;
    const next = facing === 'user' ? 'environment' : 'user';
    try {
      old.stop();
      const fresh = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: next, width: { ideal: 480 }, height: { ideal: 360 }, frameRate: { ideal: 15 } } });
      const track = fresh.getVideoTracks()[0];
      stream.removeTrack(old);
      stream.addTrack(track);
      for (const pc of pcs.current.values()) await pc.getSenders().find((s) => s.track?.kind === 'video' || s.track === old)?.replaceTrack(track);
      setFacing(next);
    } catch {
      flash("Couldn't switch the camera.");
    }
  };

  // ---- UI ---------------------------------------------------------------------------
  if (!call && !incoming && !joining) {
    return notice
      ? createPortal(
          <div className="fixed left-1/2 -translate-x-1/2 bottom-24 z-[9999] max-w-[90vw] text-sm text-white bg-slate-900/90 rounded-full px-4 py-2 shadow-lg" role="status">
            {notice}
          </div>,
          document.body
        )
      : null;
  }

  if (incoming && !call && !joining) {
    // Ringing: the liquid-glass card (house style), with Join / Decline.
    return createPortal(
      <div className="liquid-glass-backdrop fixed inset-0 z-[9999] flex items-end sm:items-center justify-center p-4" role="dialog" aria-label="Incoming group call">
        <div className="w-full max-w-sm">
          <div className="liquid-glass liquid-glass-in rounded-[32px] p-6 text-center">
            <div className="liquid-glass-inset w-16 h-16 rounded-full mx-auto mb-3 flex items-center justify-center animate-pulse">
              <Users className="w-7 h-7 text-violet-600" />
            </div>
            <div className="text-lg font-semibold text-slate-900">{incoming.title}</div>
            <div className="text-sm text-slate-600 mt-0.5">
              {incoming.from.name} started a group {incoming.kind === 'video' ? 'video' : 'audio'} call
            </div>
            <div className="mt-5 flex justify-center gap-6">
              <button
                type="button"
                onClick={() => {
                  getChatSocket()?.emit('gcall:decline', { callId: incoming.callId });
                  stopRinging();
                }}
                className="w-14 h-14 rounded-full bg-rose-600 text-white flex items-center justify-center shadow-lg active:scale-95"
                aria-label="Decline"
              >
                <PhoneOff className="w-6 h-6" />
              </button>
              <button
                type="button"
                onClick={() => void join(incoming)}
                className="w-14 h-14 rounded-full bg-emerald-500 text-white flex items-center justify-center shadow-lg active:scale-95"
                aria-label="Join"
              >
                {incoming.kind === 'video' ? <Video className="w-6 h-6" /> : <Phone className="w-6 h-6" />}
              </button>
            </div>
          </div>
        </div>
      </div>,
      document.body
    );
  }

  const video = call?.kind === 'video';
  const people = remotes.length + 1;
  const cols = people <= 1 ? 'grid-cols-1' : people <= 4 ? 'grid-cols-2' : 'grid-cols-2 sm:grid-cols-3';
  const control = (label: string, on: boolean, onClick: () => void, icon: React.ReactNode, cls?: string) => (
    <div className="flex flex-col items-center gap-1.5 w-[64px]">
      <button
        type="button"
        onClick={onClick}
        aria-pressed={on}
        aria-label={label}
        className={`w-14 h-14 rounded-full flex items-center justify-center shadow-lg active:scale-95 ${cls || (on ? 'bg-white text-slate-900' : 'bg-white/15 hover:bg-white/25')}`}
      >
        {icon}
      </button>
      <span className="text-[11.5px] text-white/80">{label}</span>
    </div>
  );

  return createPortal(
    <div className="fixed inset-0 z-[9999] bg-gradient-to-b from-violet-950 via-slate-900 to-slate-950 text-white flex flex-col" role="dialog" aria-label="Group call">
      <div className="px-4 pb-2 flex items-center justify-between gap-3" style={{ paddingTop: 'max(1rem, calc(var(--native-safe-area-inset-top, env(safe-area-inset-top, 0px)) + 0.5rem))' }}>
        <div className="min-w-0">
          <div className="font-semibold truncate">{call?.title || 'Group call'}</div>
          <div className="text-xs text-white/70">{joining ? 'Joining…' : `${clock(seconds)} · ${people} in the call`}</div>
        </div>
        <Users className="w-5 h-5 text-white/60 shrink-0" />
      </div>

      <div className={`flex-1 min-h-0 grid ${cols} auto-rows-fr gap-2 px-3`}>
        <Tile token={token} name={userName} userId={userId} stream={localRef.current} video={!!video && !cameraOff} mirror={facing === 'user'} muted={muted} you />
        {remotes.map((r) => (
          <React.Fragment key={r.socketId}>
            <Tile token={token} name={r.name} userId={r.userId} stream={r.stream} video={!!video && r.hasVideo} note={r.state === 'connecting' ? 'connecting…' : r.state === 'lost' ? 'reconnecting…' : undefined} />
            {/* Audio of everyone (a video element carries it in a video call). */}
            {!(video && r.hasVideo) && <RemoteAudio stream={r.stream} />}
          </React.Fragment>
        ))}
      </div>
      {remotes.length === 0 && !joining && <div className="text-center text-sm text-white/70 py-2">Waiting for others to join…</div>}
      {notice && <div className="mx-auto mt-2 text-xs text-white/85 bg-black/40 rounded-full px-3 py-1">{notice}</div>}

      <div className="pt-4 px-2 flex flex-wrap items-start justify-center gap-x-1 gap-y-3 sm:gap-6" style={{ paddingBottom: 'max(2.5rem, calc(env(safe-area-inset-bottom) + 1.5rem))' }}>
        {control(muted ? 'Unmute' : 'Mute', muted, toggleMute, muted ? <MicOff className="w-6 h-6" /> : <Mic className="w-6 h-6" />)}
        {callAudioAvailable() && control(speaker ? 'Speaker' : 'Earpiece', speaker, () => void toggleSpeaker(), speaker ? <Volume2 className="w-6 h-6" /> : <Ear className="w-6 h-6" />)}
        {video && control(cameraOff ? 'Camera on' : 'Camera off', cameraOff, toggleCamera, cameraOff ? <VideoOff className="w-6 h-6" /> : <Video className="w-6 h-6" />)}
        {video && !cameraOff && control('Flip', false, () => void switchCamera(), <SwitchCamera className="w-6 h-6" />)}
        {control('Leave', false, leave, <PhoneOff className="w-6 h-6" />, 'bg-rose-600 hover:bg-rose-500')}
      </div>
    </div>,
    document.body
  );
};

const RemoteAudio: React.FC<{ stream: MediaStream }> = ({ stream }) => {
  const ref = useRef<HTMLAudioElement | null>(null);
  useEffect(() => {
    if (ref.current && ref.current.srcObject !== stream) ref.current.srcObject = stream;
  }, [stream]);
  return <audio ref={ref} autoPlay playsInline />;
};
