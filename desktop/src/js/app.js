/**
 * app.js — SPA Router & Global State Manager
 */

// ─── State ────────────────────────────────────────────────────────────────────
const State = {
  token: null,
  user: null,
  currentRoom: null,
  muted: false,
  deafened: false,
  overlayVisible: false,
  status: 'online',  // 'online' | 'away' | 'in-match'
};

// ─── View Router ─────────────────────────────────────────────────────────────
function showView(id) {
  document.querySelectorAll('.view').forEach(v => {
    v.classList.toggle('active', v.id === id);
    v.classList.toggle('hidden', v.id !== id);
  });
}

// ─── Titlebar IPC ─────────────────────────────────────────────────────────────
function wireTitlebar() {
  const api = window.nebula;
  if (!api) return; // running in browser (dev)

  document.getElementById('btn-minimize')?.addEventListener('click', () => api.minimize());
  document.getElementById('btn-maximize')?.addEventListener('click', () => api.maximize());
  document.getElementById('btn-close')?.addEventListener('click',    () => api.close());

  document.getElementById('btn-minimize2')?.addEventListener('click', () => api.minimize());
  document.getElementById('btn-maximize2')?.addEventListener('click', () => api.maximize());
  document.getElementById('btn-close2')?.addEventListener('click',    () => api.close());

  document.getElementById('btn-minimize3')?.addEventListener('click', () => api.minimize());
  document.getElementById('btn-maximize3')?.addEventListener('click', () => api.maximize());
  document.getElementById('btn-close3')?.addEventListener('click',    () => api.close());

  document.getElementById('btn-minimize-login')?.addEventListener('click', () => api.minimize());
  document.getElementById('btn-close-login')?.addEventListener('click',    () => api.close());
}

// ─── Session Persistence ──────────────────────────────────────────────────────
async function loadSavedSession() {
  const api = window.nebula;
  let saved = null;
  
  if (api) {
    saved = await api.getStore('session');
  } else {
    try { saved = JSON.parse(localStorage.getItem('session')); } catch {}
  }

  if (!saved?.token) return false;

  // Verify token is still valid
  try {
    const res = await fetch('https://nebula-voicechat.onrender.com/api/me', {
      headers: { Authorization: `Bearer ${saved.token}` },
    });
    if (!res.ok) {
      clearSession();
      return false;
    }
    const { user } = await res.json();

    State.token = saved.token;
    State.user = user;
    return true;
  } catch {
    return false;
  }
}

async function saveSession() {
  const api = window.nebula;
  if (State.token) {
    if (api) {
      await api.setStore('session', { token: State.token });
    } else {
      localStorage.setItem('session', JSON.stringify({ token: State.token }));
    }
  }
}

async function clearSession() {
  const api = window.nebula;
  if (api) {
    await api.setStore('session', null);
  } else {
    localStorage.removeItem('session');
  }
  State.token = null;
  State.user = null;
  State.currentRoom = null;
}

// ─── Auth Events ──────────────────────────────────────────────────────────────
function onLoginSuccess(token, user) {
  State.token = token;
  State.user = user;
  saveSession();
  updateUserBar();
  // Connect WS immediately on login so presence + friends work from the dashboard
  window.VoiceEngine?.connect?.(token).catch(() => {});
  showView('view-dashboard');
}

function updateUserBar() {
  const u = State.user;
  if (!u) return;

  const nameEl   = document.getElementById('dash-username');
  const avatarEl = document.getElementById('dash-avatar');
  const dotEl    = document.getElementById('user-status-dot');

  if (nameEl) nameEl.textContent = u.username;

  if (avatarEl) {
    if (u.avatar) {
      avatarEl.innerHTML = `<img src="${u.avatar}" alt="${u.username}" />`;
    } else {
      avatarEl.textContent = (u.username || '?')[0].toUpperCase();
    }
  }

  if (dotEl) {
    dotEl.className = `user-status-dot status-${State.status}`;
    dotEl.title = State.status === 'online' ? 'Online'
                : State.status === 'away'   ? 'Away'
                : 'In-Match';
  }

  const textEl = document.getElementById('dash-status-text');
  if (textEl) {
    const labels = { online: '● Online', away: '● Away', 'in-match': '● In-Match' };
    textEl.textContent = labels[State.status] || '● Online';
    textEl.className = `user-status-text status-text-${State.status}`;
  }
}

// ─── Dashboard Controls ───────────────────────────────────────────────────────
function wireDashboard() {
  // Logout
  document.getElementById('btn-logout')?.addEventListener('click', async () => {
    await clearSession();
    if (window.VoiceEngine?.disconnect) await window.VoiceEngine.disconnect();
    showView('view-login');
  });

  // Overlay toggle
  const toggleOv = () => window.nebula?.toggleOverlay();
  document.getElementById('btn-toggle-overlay')?.addEventListener('click', toggleOv);
  document.getElementById('btn-toggle-overlay2')?.addEventListener('click', toggleOv);

  // Global Chat toggle
  const gcPanel = document.getElementById('global-chat-panel');
  const btnGc = document.getElementById('btn-global-chat');
  const btnCloseGc = document.getElementById('btn-close-global-chat');
  
  const toggleGlobalChat = () => {
    gcPanel?.classList.toggle('open');
    btnGc?.classList.toggle('active');
  };
  
  btnGc?.addEventListener('click', toggleGlobalChat);
  btnCloseGc?.addEventListener('click', toggleGlobalChat);

  // Global Chat sending
  const gcInput = document.getElementById('global-chat-input');
  const sendGlobalMessage = () => {
    const text = gcInput.value.trim();
    if (!text) return;
    window.VoiceEngine?.sendGlobalChat(text);
    gcInput.value = '';
  };
  document.getElementById('btn-send-global-chat')?.addEventListener('click', sendGlobalMessage);
  gcInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendGlobalMessage();
  });

  // Track overlay visibility from main process
  window.nebula?.onOverlayVisibility?.((vis) => {
    State.overlayVisible = vis;
    const btn1 = document.getElementById('btn-toggle-overlay');
    const btn2 = document.getElementById('btn-toggle-overlay2');
    const cls = 'active';
    btn1?.classList.toggle(cls, vis);
    btn2?.classList.toggle(cls, vis);
  });
}

// ─── Quick-join buttons ───────────────────────────────────────────────────────
function wireQuickRooms() {
  document.querySelectorAll('.quick-room-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const roomId = btn.dataset.room;
      document.getElementById('room-id-input').value = roomId;
    });
  });

  document.getElementById('btn-join-room')?.addEventListener('click', () => {
    const input    = document.getElementById('room-id-input');
    const capEl    = document.getElementById('room-capacity');
    const roomId   = (input?.value || '').trim();
    const maxPeers = parseInt(capEl?.value || '8', 10);
    if (roomId) window.joinRoom?.(roomId, maxPeers);
  });

  document.getElementById('room-id-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const capEl    = document.getElementById('room-capacity');
      const maxPeers = parseInt(capEl?.value || '8', 10);
      const roomId   = e.target.value.trim();
      if (roomId) window.joinRoom?.(roomId, maxPeers);
    }
  });
}

// ─── PTT via IPC ─────────────────────────────────────────────────────────────
function wirePTT() {
  // Toggle mode: V flips mute
  window.nebula?.onPttToggle?.(() => {
    window.VoiceEngine?.toggleMute();
  });

  // PTT mode: hold V = mic live, release = mic muted
  window.nebula?.onPttPress?.(() => {
    if (window.VoiceEngine?.isMuted !== false)
      window.VoiceEngine?.setMuted(false);   // force unmute
    // Show PTT live indicator
    document.getElementById('ptt-live-badge')?.classList.add('active');
  });

  window.nebula?.onPttRelease?.(() => {
    window.VoiceEngine?.setMuted(true);      // force mute
    document.getElementById('ptt-live-badge')?.classList.remove('active');
  });
}

// ─── Presence System ─────────────────────────────────────────────────────────
const STATUS_META = {
  online:   { label: 'Online',   emoji: '🟢', color: 'var(--accent)' },
  away:     { label: 'Away',     emoji: '🟡', color: '#D29922' },
  'in-match': { label: 'In-Match', emoji: '🔴', color: '#F85149' },
};

function setUserStatus(status, auto = false) {
  // Don't override manual status with auto away if user is in-match
  if (auto && status === 'away' && State.status === 'in-match') return;
  // Don't override in-match with online when returning from idle
  if (auto && status === 'online' && State.status === 'in-match') return;

  State.status = status;
  window.VoiceEngine?.setStatus?.(status);
  updateUserBar();
  updateStatusPicker();
}

function setupPresence() {
  // ── Auto-away: 3 minutes of idle ──────────────────────────────────────────
  const AWAY_TIMEOUT = 3 * 60 * 1000;
  let idleTimer = null;

  function resetIdleTimer() {
    clearTimeout(idleTimer);
    if (State.status === 'away') setUserStatus('online', true);
    idleTimer = setTimeout(() => setUserStatus('away', true), AWAY_TIMEOUT);
  }

  ['mousemove', 'keydown', 'mousedown', 'touchstart'].forEach(evt =>
    document.addEventListener(evt, resetIdleTimer, { passive: true })
  );
  resetIdleTimer();

  // ── Status picker in user bar ─────────────────────────────────────────────
  const picker = document.getElementById('status-picker');
  const trigger = document.getElementById('user-status-dot');

  trigger?.addEventListener('click', (e) => {
    e.stopPropagation();
    picker?.classList.toggle('visible');
  });

  document.addEventListener('click', () => picker?.classList.remove('visible'));

  document.querySelectorAll('[data-status]').forEach(btn => {
    btn.addEventListener('click', () => {
      setUserStatus(btn.dataset.status);
      picker?.classList.remove('visible');
    });
  });

  // ── Auto-set In-Match when joining / leaving rooms ────────────────────────
  window.VoiceEngine?.on?.('room-joined', () => setUserStatus('in-match', true));
  window.VoiceEngine?.on?.('room-left',   () => setUserStatus('online')); // manual=false so guard doesn't block it
}

function updateStatusPicker() {
  document.querySelectorAll('[data-status]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.status === State.status);
  });
  const dot = document.getElementById('user-status-dot');
  if (dot) dot.className = `user-status-dot status-${State.status}`;
}

// ─── Global Chat Events ──────────────────────────────────────────────────────
function setupGlobalChat() {
  window.VoiceEngine?.on('global-chat-message', (data) => {
    const messages = document.getElementById('global-chat-messages');
    if (!messages) return;
    
    document.querySelector('#global-chat-messages .chat-empty')?.remove();
    
    const isSelf = data.userId === State.user?.id;
    
    const wrapper = document.createElement('div');
    wrapper.className = `chat-msg ${isSelf ? 'chat-msg-self' : 'chat-msg-other'}`;

    let avatarHtml = `<div class="chat-avatar">${data.username[0].toUpperCase()}</div>`;
    if (data.avatar) {
      avatarHtml = `<div class="chat-avatar"><img src="${data.avatar}" alt="avatar" /></div>`;
    }

    const time = new Date(data.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    wrapper.innerHTML = `
      ${avatarHtml}
      <div class="chat-body">
        <div class="chat-name">${data.username}</div>
        <div class="chat-bubble">${escapeHtml(data.text)}</div>
        <div class="chat-time">${time}</div>
      </div>
    `;

    messages.appendChild(wrapper);
    messages.scrollTop = messages.scrollHeight;
  });
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Init ─────────────────────────────────────────────────────────────────────
async function init() {
  wireTitlebar();
  wireDashboard();
  wireQuickRooms();
  wirePTT();
  setupPresence();
  setupGlobalChat();

  // Load session in background while splash plays
  const sessionPromise = loadSavedSession();

  // Show splash initially (already active in HTML)
  showView('view-splash');

  // Total splash sequence duration is ~6.5 seconds.
  // Wait before transitioning to the app
  setTimeout(async () => {
    const hasSession = await sessionPromise;
    const splash = document.getElementById('view-splash');
    
    // Fade out splash
    splash.style.transition = 'opacity 0.5s ease';
    splash.style.opacity = '0';
    
    setTimeout(() => {
      // Transition to actual view
      if (hasSession) {
        updateUserBar();
        showView('view-dashboard');
      } else {
        showView('view-login');
      }
    }, 500); // Wait for fade out
  }, 6500);
}

document.addEventListener('DOMContentLoaded', init);
