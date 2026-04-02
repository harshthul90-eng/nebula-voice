/**
 * voice.js — WebRTC P2P voice engine
 *
 * Flow:
 *  1. getUserMedia → local audio stream
 *  2. Connect WebSocket → get peerId
 *  3. joinRoom → receive existing peers
 *  4. For each existing peer: create RTCPeerConnection → offer
 *  5. For new peers: receive offer → answer
 *  6. ICE candidates exchanged via WS
 *  7. Remote tracks arrive → attach to <audio> elements
 *  8. VAD loop → broadcast speaking state
 */

const WS_URL = 'ws://localhost:3001/ws';

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
];

class VoiceEngine {
  constructor() {
    this.ws = null;
    this.peerId = null;
    this.roomId = null;
    this.peers = new Map();
    this.peerInfo = new Map();

    this.localStream     = null;
    this.processedStream = null;
    this.noiseNode       = null;
    this.effectBus       = null;   // gain node between noise and effect chain
    this.gainNode        = null;
    this.audioContext    = null;
    this.analyser        = null;
    this.vadRaf          = null;
    this.ncReady         = false;

    this.isMuted    = false;
    this.isDeafened = false;
    this.isSpeaking = false;
    this.pttMode    = false;
    this.status     = 'online';
    this._authToken = null;

    // Voice effects
    this.currentEffect        = 'normal';
    this._effectNodes         = [];
    this._effectsWorkletLoaded = false;

    this._handlers = {};
  }

  // ─── Event emitter ─────────────────────────────────────────────────────────
  on(event, cb) {
    if (!this._handlers[event]) this._handlers[event] = [];
    this._handlers[event].push(cb);
  }
  _emit(event, data) {
    this._handlers[event]?.forEach(cb => cb(data));
  }

  // ─── Init ──────────────────────────────────────────────────────────────────
  async init() {
    try {
      // 1. Capture raw mic (browser built-in NC as first layer ~5-10 dB)
      this.localStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          sampleRate: 48000,
          channelCount: 1,
        },
        video: false,
      });

      this.audioContext = new AudioContext({ sampleRate: 48000 });

      // 2. Load noise-cancellation AudioWorklet
      // Resolve worklet path — works under Electron file:// and http:// dev server
      const base = location.href.replace(/\/[^/]*$/, '/');
      await this.audioContext.audioWorklet.addModule(base + 'js/noise-worklet.js');

      // 3. Build processing chain:
      //    mic → noiseWorklet → effectBus → [effect chain] → gainNode → MediaStreamDestination → WebRTC
      const source = this.audioContext.createMediaStreamSource(this.localStream);

      this.noiseNode = new AudioWorkletNode(this.audioContext, 'noise-suppressor', {
        numberOfInputs: 1, numberOfOutputs: 1,
        outputChannelCount: [1],
      });
      this.noiseNode.port.onmessage = ({ data }) => {
        if (data?.type === 'calibrated') {
          this.ncReady = true;
          console.log('[NC] Calibration done — 25 dB suppression active');
          this._emit('nc-ready', {});
        }
      };

      // effectBus: injectable point for voice effects (normal = pass-through gain=1)
      this.effectBus = this.audioContext.createGain();
      this.effectBus.gain.value = 1;

      // GainNode acts as a mute gate (set to 0 when muted)
      this.gainNode = this.audioContext.createGain();
      this.gainNode.gain.value = 1.0;

      const dest = this.audioContext.createMediaStreamDestination();
      source.connect(this.noiseNode);
      this.noiseNode.connect(this.effectBus);
      this.effectBus.connect(this.gainNode);
      this.gainNode.connect(dest);

      // Load the ring-mod AudioWorklet (effects system)
      const base2 = location.href.replace(/\/[^/]*$/, '/');
      try {
        await this.audioContext.audioWorklet.addModule(base2 + 'js/voice-effects-worklet.js');
        this._effectsWorkletLoaded = true;
      } catch (ewErr) {
        console.warn('[Effects] Worklet load failed:', ewErr.message);
      }

      // This is the clean, noise-cancelled stream sent over WebRTC
      this.processedStream = dest.stream;

      // 4. VAD still reads from raw mic (pre-noise-cancel) for accurate detection
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = 512;
      source.connect(this.analyser);

      return true;
    } catch (err) {
      console.error('Init error:', err);
      // Fallback: if worklet fails (e.g. file:// protocol), use raw stream
      if (this.localStream) {
        this.processedStream = this.localStream;
        console.warn('[NC] AudioWorklet failed — falling back to raw stream:', err.message);
        return true;
      }
      this._emit('error', { type: 'mic_denied', message: err.message });
      return false;
    }
  }

  // ─── Connect WebSocket ─────────────────────────────────────────────────────
  connect(token) {
    if (token) this._authToken = token;
    return new Promise((resolve, reject) => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) return resolve();
      this.ws = new WebSocket(WS_URL);

      this.ws.onopen = () => {
        if (this._authToken) this._send({ type: 'authenticate', token: this._authToken });
        resolve();
      };
      this.ws.onerror = () => reject(new Error('Cannot connect to signaling server'));
      this.ws.onclose = () => this._emit('disconnected', {});
      this.ws.onmessage = (e) => {
        try { this._handleSignaling(JSON.parse(e.data)); }
        catch { /* ignore */ }
      };
    });
  }

  // ─── Join Room ─────────────────────────────────────────────────────────────
  joinRoom(roomId, token, maxPeers = 8) {
    this.roomId = roomId;
    this._send({ type: 'join-room', roomId, token, maxPeers, status: this.status });
  }

  leaveRoom() {
    this._send({ type: 'leave-room' });
    this._cleanupAllPeers();
    this.roomId = null;
    this._stopVAD();
    this._emit('room-left', {});
  }

  // ─── Signaling Handler ────────────────────────────────────────────────────
  async _handleSignaling(msg) {
    switch (msg.type) {

      case 'connected':
        this.peerId = msg.peerId;
        break;

      case 'room-joined': {
        // Create offers to all existing peers (we are the newcomer)
        for (const peer of (msg.peers || [])) {
          this.peerInfo.set(peer.peerId, { username: peer.username, avatar: peer.avatar, muted: peer.muted });
          await this._createPeerConnection(peer.peerId, true);
        }
        this._emit('room-joined', {
          roomId:   msg.roomId,
          peerId:   msg.peerId,
          peers:    msg.peers,
          maxPeers: msg.maxPeers,
          roomCode: msg.roomCode,   // ← was being dropped here
        });
        this._startVAD();
        break;
      }

      case 'peer-joined': {
        this.peerInfo.set(msg.peerId, { username: msg.username, avatar: msg.avatar, muted: false });
        this._emit('peer-joined', {
          peerId:   msg.peerId,
          username: msg.username,
          avatar:   msg.avatar,
          status:   msg.status,   // presence status
          max:      msg.max,      // updated room capacity
          current:  msg.current,
        });
        break;
      }

      case 'peer-left':
        this._removePeer(msg.peerId);
        this._emit('peer-left', { peerId: msg.peerId });
        break;

      case 'offer':
        await this._handleOffer(msg.fromPeerId, msg.offer);
        break;

      case 'answer':
        await this._handleAnswer(msg.fromPeerId, msg.answer);
        break;

      case 'ice-candidate':
        await this._handleIceCandidate(msg.fromPeerId, msg.candidate);
        break;

      case 'speaking':
        this._emit('peer-speaking', { peerId: msg.peerId, speaking: msg.speaking });
        break;

      case 'mute-state': {
        const info = this.peerInfo.get(msg.peerId);
        if (info) info.muted = msg.muted;
        this._emit('peer-mute', { peerId: msg.peerId, muted: msg.muted });
        break;
      }

      case 'status-update':
        this._emit('peer-status', { peerId: msg.peerId, status: msg.status });
        break;

      case 'chat-message':
        this._emit('chat-message', {
          peerId:    msg.peerId,
          username:  msg.username,
          avatar:    msg.avatar,
          text:      msg.text,
          timestamp: msg.timestamp,
        });
        break;

      // ── Friend / presence events ────────────────────────────────────────────────────
      case 'authenticated':       this._emit('authenticated',      { userId: msg.userId }); break;
      case 'friends-list':        this._emit('friends-list',       { friends: msg.friends }); break;
      case 'friend-status':       this._emit('friend-status',      msg); break;
      case 'friend-request':      this._emit('friend-request',     msg); break;
      case 'friend-request-sent': this._emit('friend-request-sent',msg); break;
      case 'friend-added':        this._emit('friend-added',       { friend: msg.friend }); break;
      case 'friend-removed':      this._emit('friend-removed',     { friendId: msg.friendId }); break;
      case 'friend-error':        this._emit('friend-error',       { message: msg.message }); break;
      case 'pending-requests':    this._emit('pending-requests',   { requests: msg.requests }); break;
      case 'room-invite':         this._emit('room-invite',        msg); break;

      case 'room-full':
        this._emit('room-full', { message: msg.message, current: msg.current, max: msg.max });
        break;

      case 'error':
        console.error('Server error:', msg.message);
        this._emit('error', { type: 'server', message: msg.message });
        break;
    }
  }

  // ─── RTCPeerConnection ─────────────────────────────────────────────────────
  async _createPeerConnection(remotePeerId, isOfferer) {
    if (this.peers.has(remotePeerId)) return this.peers.get(remotePeerId);

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    this.peers.set(remotePeerId, pc);

    // Add noise-cancelled tracks (processedStream) — NOT the raw mic
    const streamToSend = this.processedStream || this.localStream;
    streamToSend.getTracks().forEach(track => pc.addTrack(track, streamToSend));

    // Remote audio
    pc.ontrack = (event) => {
      const stream = event.streams[0] || new MediaStream([event.track]);
      this._attachRemoteAudio(remotePeerId, stream);
    };

    // ICE candidates
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this._send({ type: 'ice-candidate', targetPeerId: remotePeerId, candidate: event.candidate });
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        this._removePeer(remotePeerId);
        this._emit('peer-left', { peerId: remotePeerId });
      }
    };

    if (isOfferer) {
      const offer = await pc.createOffer({ offerToReceiveAudio: true });
      await pc.setLocalDescription(offer);
      this._send({ type: 'offer', targetPeerId: remotePeerId, offer });
    }

    return pc;
  }

  async _handleOffer(fromPeerId, offer) {
    const pc = await this._createPeerConnection(fromPeerId, false);
    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    this._send({ type: 'answer', targetPeerId: fromPeerId, answer });
  }

  async _handleAnswer(fromPeerId, answer) {
    const pc = this.peers.get(fromPeerId);
    if (pc) await pc.setRemoteDescription(new RTCSessionDescription(answer));
  }

  async _handleIceCandidate(fromPeerId, candidate) {
    const pc = this.peers.get(fromPeerId);
    if (pc && candidate) {
      try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); }
      catch { /* ignore late candidates */ }
    }
  }

  // ─── Remote Audio Attachment ───────────────────────────────────────────────
  _attachRemoteAudio(peerId, stream) {
    let el = document.getElementById(`vk-audio-${peerId}`);
    if (!el) {
      el = document.createElement('audio');
      el.id = `vk-audio-${peerId}`;
      el.autoplay = true;
      el.style.display = 'none';
      document.body.appendChild(el);
    }
    el.srcObject = stream;
    el.muted = this.isDeafened;
    this._emit('peer-audio-ready', { peerId });
  }

  // ─── Mute / Deafen ────────────────────────────────────────────────────────
  setMuted(muted) {
    this.isMuted = muted;
    // Gate via gainNode (smooth) — also disable raw track as backup
    if (this.gainNode) {
      this.gainNode.gain.setTargetAtTime(muted ? 0 : 1, this.audioContext.currentTime, 0.01);
    }
    this.localStream?.getTracks().forEach(t => { if (t.kind === 'audio') t.enabled = !muted; });
    this._send({ type: 'mute-state', muted });
    this._emit('local-mute', { muted });
    if (!muted && this.isDeafened) this.setDeafened(false);
  }

  setDeafened(deafened) {
    this.isDeafened = deafened;
    // Mute all remote audio elements
    document.querySelectorAll('audio[id^="vk-audio-"]').forEach(a => { a.muted = deafened; });
    if (deafened) this.setMuted(true);
    this._emit('local-deafen', { deafened });
  }

  toggleMute() {
    this.setMuted(!this.isMuted);
  }

  toggleDeafen() {
    this.setDeafened(!this.isDeafened);
  }

  // ─── Status ────────────────────────────────────────────────────────────────
  setStatus(status) {
    const valid = ['online', 'away', 'in-match'];
    if (!valid.includes(status)) return;
    this.status = status;
    this._send({ type: 'set-status', status });
    this._emit('local-status', { status });
  }

  // ─── Friend API ────────────────────────────────────────────────────────────────
  sendFriendRequest(username)      { this._send({ type: 'send-friend-request',    username }); }
  acceptFriendRequest(fromId)      { this._send({ type: 'accept-friend-request',  fromId }); }
  declineFriendRequest(fromId)     { this._send({ type: 'decline-friend-request', fromId }); }
  removeFriend(friendId)           { this._send({ type: 'remove-friend',          friendId }); }
  getFriends()                     { this._send({ type: 'get-friends' }); }
  inviteToRoom(friendId, roomId, roomCode) { this._send({ type: 'invite-to-room', friendId, roomId, roomCode }); }

  // ─── Chat ────────────────────────────────────────────────────────────────
  sendChat(text) {
    const trimmed = String(text || '').trim().slice(0, 500);
    if (trimmed) this._send({ type: 'chat-message', text: trimmed });
  }

  // ─── Per-peer volume ───────────────────────────────────────────────────────
  setPeerVolume(peerId, volume) { // 0.0–1.0
    const el = document.getElementById(`vk-audio-${peerId}`);
    if (el) el.volume = Math.max(0, Math.min(1, volume));
  }

  // ─── VAD (Voice Activity Detection) ───────────────────────────────────────
  _startVAD() {
    if (this.vadRaf) return;
    const data = new Uint8Array(this.analyser.frequencyBinCount);
    let speakingFrames = 0;
    const THRESHOLD = 18;    // RMS threshold for speaking
    const ONSET  = 3;        // Frames above threshold before "speaking"
    const OFFSET = 20;       // Frames below threshold before "silent"

    const tick = () => {
      this.analyser.getByteFrequencyData(data);
      // Average the voice-band (roughly 300Hz–3kHz on 48kHz/512 FFT)
      const lo = Math.floor(data.length * 0.02);
      const hi = Math.floor(data.length * 0.25);
      let sum = 0;
      for (let i = lo; i < hi; i++) sum += data[i];
      const avg = sum / (hi - lo);

      if (avg > THRESHOLD && !this.isMuted) {
        speakingFrames = Math.min(speakingFrames + 1, ONSET);
      } else {
        speakingFrames = Math.max(speakingFrames - 1, -OFFSET);
      }

      const nowSpeaking = speakingFrames >= ONSET;
      if (nowSpeaking !== this.isSpeaking) {
        this.isSpeaking = nowSpeaking;
        this._send({ type: 'speaking', speaking: nowSpeaking });
        this._emit('local-speaking', { speaking: nowSpeaking });
      }

      this.vadRaf = requestAnimationFrame(tick);
    };

    this.vadRaf = requestAnimationFrame(tick);
  }

  _stopVAD() {
    if (this.vadRaf) { cancelAnimationFrame(this.vadRaf); this.vadRaf = null; }
  }

  // ─── Cleanup ───────────────────────────────────────────────────────────────
  _removePeer(peerId) {
    const pc = this.peers.get(peerId);
    if (pc) { try { pc.close(); } catch { } this.peers.delete(peerId); }
    this.peerInfo.delete(peerId);
    const el = document.getElementById(`vk-audio-${peerId}`);
    if (el) el.remove();
  }

  _cleanupAllPeers() {
    for (const [peerId] of this.peers) this._removePeer(peerId);
  }

  async disconnect() {
    this._stopVAD();
    if (this.roomId) this._send({ type: 'leave-room' });
    this._cleanupAllPeers();
    this._disposeEffectNodes();
    this.noiseNode?.disconnect();
    this.gainNode?.disconnect();
    this.localStream?.getTracks().forEach(t => t.stop());
    this.processedStream?.getTracks().forEach(t => t.stop());
    this.ws?.close();
    if (this.audioContext?.state !== 'closed') this.audioContext?.close();
  }

  // ─── WS Send helper ───────────────────────────────────────────────────────
  _send(msg) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  // ─── Voice Effects ────────────────────────────────────────────────────────
  async setVoiceEffect(name) {
    this.currentEffect = name;
    await this._rebuildEffectChain(name);
    this._emit('effect-changed', { effect: name });
  }

  async _rebuildEffectChain(name) {
    const ctx = this.audioContext;
    const bus = this.effectBus;
    const out = this.gainNode;
    if (!ctx || !bus || !out) return;

    this._disposeEffectNodes();

    if (name === 'normal') { bus.connect(out); return; }

    if (!this._effectsWorkletLoaded) {
      const base = location.href.replace(/\/[^/]*$/, '/');
      try {
        await ctx.audioWorklet.addModule(base + 'js/voice-effects-worklet.js');
        this._effectsWorkletLoaded = true;
      } catch { bus.connect(out); return; }
    }

    switch (name) {
      case 'robot': {
        const rm = new AudioWorkletNode(ctx, 'voice-ring-mod');
        rm.port.postMessage({ freq: 50, mix: 1.0 });
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass'; bp.frequency.value = 1800; bp.Q.value = 0.7;
        const g = ctx.createGain(); g.gain.value = 2.5;
        bus.connect(rm); rm.connect(bp); bp.connect(g); g.connect(out);
        this._effectNodes = [rm, bp, g];
        break;
      }
      case 'monster': {
        const rm = new AudioWorkletNode(ctx, 'voice-ring-mod');
        rm.port.postMessage({ freq: 25, mix: 0.75 });
        const bass = ctx.createBiquadFilter();
        bass.type = 'lowshelf'; bass.frequency.value = 280; bass.gain.value = 14;
        const dist = ctx.createWaveShaper();
        dist.curve = this._makeDistortionCurve(55); dist.oversample = '4x';
        const g = ctx.createGain(); g.gain.value = 1.4;
        bus.connect(rm); rm.connect(bass); bass.connect(dist); dist.connect(g); g.connect(out);
        this._effectNodes = [rm, bass, dist, g];
        break;
      }
      case 'alien': {
        const rm = new AudioWorkletNode(ctx, 'voice-ring-mod');
        rm.port.postMessage({ freq: 130, mix: 1.0 });
        const delay = ctx.createDelay(0.05); delay.delayTime.value = 0.007;
        const dryG = ctx.createGain(); dryG.gain.value = 0.75;
        const wetG = ctx.createGain(); wetG.gain.value = 0.45;
        const mix  = ctx.createGain(); mix.gain.value  = 1.8;
        bus.connect(rm);
        rm.connect(dryG); dryG.connect(mix);
        rm.connect(delay); delay.connect(wetG); wetG.connect(mix);
        mix.connect(out);
        this._effectNodes = [rm, delay, dryG, wetG, mix];
        break;
      }
      case 'radio': {
        const hp = ctx.createBiquadFilter();
        hp.type = 'highpass'; hp.frequency.value = 350; hp.Q.value = 0.9;
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass'; lp.frequency.value = 3200; lp.Q.value = 0.9;
        const dist = ctx.createWaveShaper();
        dist.curve = this._makeDistortionCurve(25);
        const g = ctx.createGain(); g.gain.value = 1.6;
        bus.connect(hp); hp.connect(lp); lp.connect(dist); dist.connect(g); g.connect(out);
        this._effectNodes = [hp, lp, dist, g];
        break;
      }
      case 'echo': {
        const dryG = ctx.createGain(); dryG.gain.value = 0.7;
        const d1 = ctx.createDelay(1.0); d1.delayTime.value = 0.22;
        const d2 = ctx.createDelay(1.0); d2.delayTime.value = 0.44;
        const fb = ctx.createGain(); fb.gain.value = 0.32;
        const wetG = ctx.createGain(); wetG.gain.value = 0.55;
        const g = ctx.createGain(); g.gain.value = 1.0;
        bus.connect(dryG); dryG.connect(g);
        bus.connect(d1);
        d1.connect(fb); fb.connect(d1); // feedback loop
        d1.connect(d2); d1.connect(wetG); d2.connect(wetG);
        wetG.connect(g); g.connect(out);
        this._effectNodes = [dryG, d1, d2, fb, wetG, g];
        break;
      }
      default:
        bus.connect(out);
    }
  }

  _disposeEffectNodes() {
    try { this.effectBus?.disconnect(); } catch {}
    for (const n of this._effectNodes) { try { n.disconnect(); } catch {} }
    this._effectNodes = [];
  }

  _makeDistortionCurve(amount) {
    const n = 256; const curve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i * 2) / n - 1;
      curve[i] = ((Math.PI + amount) * x) / (Math.PI + amount * Math.abs(x));
    }
    return curve;
  }
}

// ─── Singleton export ─────────────────────────────────────────────────────────
window.VoiceEngine = new VoiceEngine();

// Wire mute toggle for PTT relay (called from app.js)
window.toggleMute = () => window.VoiceEngine.toggleMute();
