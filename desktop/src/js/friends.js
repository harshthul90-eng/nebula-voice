/**
 * friends.js — Friend list UI for Nebula dashboard.
 * Communicates via VoiceEngine WS events.
 */

// Lazy getter — resolves after voice.js has set window.VoiceEngine
const getEngine = () => window.VoiceEngine;

// ─── State ────────────────────────────────────────────────────────────────────
const friendsState = {
  friends:  new Map(), // friendId → { id, username, avatar, status, roomId }
  requests: [],        // pending incoming requests
  panelOpen: false,
};

// ─── Bootstrap ────────────────────────────────────────────────────────────────
function initFriends() {
  const engine = getEngine();
  if (!engine) return;
  wireFriendsPanel();
  bindEngineEvents();
  // Request fresh list whenever authenticated event fires
  engine.on('authenticated', () => getEngine().getFriends());
  engine.on('friends-list',  ({ friends }) => {
    friendsState.friends.clear();
    friends.forEach(f => friendsState.friends.set(f.id, f));
    renderFriendList();
  });
}

// ─── Engine event handlers ────────────────────────────────────────────────────
function bindEngineEvents() {
  const engine = getEngine();
  engine.on('friend-status', (data) => {
    let f = friendsState.friends.get(data.userId);
    if (!f) {
      f = { id: data.userId, username: data.username || 'Unknown', avatar: data.avatar || null };
      friendsState.friends.set(data.userId, f);
    }
    f.status = data.status;
    f.roomId = data.roomId || null;
    if (data.username) f.username = data.username;
    if (data.avatar !== undefined) f.avatar = data.avatar;
    renderFriendList();
  });

  engine.on('friend-request', ({ fromId, username, avatar }) => {
    friendsState.requests.push({ fromId, user: { id: fromId, username, avatar } });
    renderPendingRequests();
    showFriendToast(`📨 ${username} sent you a friend request`, null, 'info');
    updateFriendsBadge();
  });

  engine.on('pending-requests', ({ requests }) => {
    friendsState.requests = requests;
    renderPendingRequests();
    updateFriendsBadge();
  });

  engine.on('friend-added', ({ friend }) => {
    friendsState.friends.set(friend.id, friend);
    // Remove from pending requests if it was there
    friendsState.requests = friendsState.requests.filter(r => r.fromId !== friend.id);
    renderFriendList();
    renderPendingRequests();
    updateFriendsBadge();
    showFriendToast(`✅ ${friend.username} is now your friend!`, null, 'success');
  });

  engine.on('friend-removed', ({ friendId }) => {
    friendsState.friends.delete(friendId);
    renderFriendList();
  });

  engine.on('friend-error', ({ message }) => {
    showFriendToast(`❌ ${message}`, null, 'error');
  });

  engine.on('friend-request-sent', ({ targetUsername }) => {
    showFriendToast(`📤 Friend request sent to ${targetUsername}`, null, 'success');
    // Clear input
    const inp = document.getElementById('add-friend-input');
    if (inp) inp.value = '';
  });

  engine.on('room-invite', ({ fromUsername, fromAvatar, roomId, roomCode }) => {
    showRoomInvite({ fromUsername, fromAvatar, roomId, roomCode });
  });
}

// ─── Friends Panel ────────────────────────────────────────────────────────────
function wireFriendsPanel() {
  document.getElementById('btn-friends')?.addEventListener('click', toggleFriendsPanel);
  document.getElementById('btn-close-friends')?.addEventListener('click', closeFriendsPanel);

  // Add friend form
  document.getElementById('btn-add-friend')?.addEventListener('click', sendFriendRequest);
  document.getElementById('add-friend-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendFriendRequest();
  });
}

function toggleFriendsPanel() {
  friendsState.panelOpen ? closeFriendsPanel() : openFriendsPanel();
}

function openFriendsPanel() {
  friendsState.panelOpen = true;
  document.getElementById('friends-panel')?.classList.add('open');
  document.getElementById('btn-friends')?.classList.add('active');
  updateFriendsBadge();
  getEngine()?.getFriends(); // refresh list
}

function closeFriendsPanel() {
  friendsState.panelOpen = false;
  document.getElementById('friends-panel')?.classList.remove('open');
  document.getElementById('btn-friends')?.classList.remove('active');
}

function updateFriendsBadge() {
  const badge = document.getElementById('friends-badge');
  const count = friendsState.requests.length;
  if (badge) {
    badge.textContent = count > 9 ? '9+' : count;
    badge.classList.toggle('hidden', count === 0 || friendsState.panelOpen);
  }
}

// ─── Add Friend ───────────────────────────────────────────────────────────────
function sendFriendRequest() {
  const inp  = document.getElementById('add-friend-input');
  const name = (inp?.value || '').trim();
  if (!name) return;
  getEngine().sendFriendRequest(name);
}

// ─── Render Friend List ───────────────────────────────────────────────────────
function renderFriendList() {
  const list = document.getElementById('friends-list-body');
  if (!list) return;

  const friends = [...friendsState.friends.values()];
  if (friends.length === 0) {
    list.innerHTML = '<div class="friends-empty">No friends yet.<br>Add someone to get started! 👋</div>';
    return;
  }

  const onlineFriends  = friends.filter(f => f.status !== 'offline');
  const offlineFriends = friends.filter(f => f.status === 'offline');

  const currentRoom = window.State?.currentRoom;
  const currentCode = document.getElementById('room-code-value')?.textContent || null;

  const renderCard = (f) => {
    const initials = (f.username || '?')[0].toUpperCase();
    const avatarHtml = f.avatar
      ? `<img src="${escHtml(f.avatar)}" alt="${escHtml(f.username)}" />`
      : initials;
    const statusLabel = f.status === 'in-match' ? 'In-Match' : f.status === 'away' ? 'Away' : f.status === 'online' ? 'Online' : 'Offline';
    const roomInfo = f.roomId ? `<span class="friend-room">🎮 ${escHtml(f.roomId)}</span>` : '';
    const canInvite = currentRoom && f.status !== 'offline';
    const inviteBtn = canInvite
      ? `<button class="friend-invite-btn" onclick="inviteFriend('${escHtml(f.id)}')">Invite</button>`
      : '';
    const removeBtn = `<button class="friend-remove-btn" title="Remove friend" onclick="removeFriendById('${escHtml(f.id)}')">✕</button>`;

    return `
      <div class="friend-card" id="fc-${f.id}">
        <div class="friend-avatar-wrap">
          <div class="friend-avatar">${avatarHtml}</div>
          <span class="friend-status-dot status-${f.status || 'offline'}"></span>
        </div>
        <div class="friend-info">
          <div class="friend-name">${escHtml(f.username)}</div>
          <div class="friend-status-text">${statusLabel}${roomInfo}</div>
        </div>
        <div class="friend-actions">
          ${inviteBtn}
          ${removeBtn}
        </div>
      </div>`;
  };

  let html = '';
  if (onlineFriends.length) {
    html += `<div class="friends-section-label">● Online — ${onlineFriends.length}</div>`;
    html += onlineFriends.map(renderCard).join('');
  }
  if (offlineFriends.length) {
    html += `<div class="friends-section-label offline-label">○ Offline — ${offlineFriends.length}</div>`;
    html += offlineFriends.map(renderCard).join('');
  }
  list.innerHTML = html;
}

// ─── Render Pending Requests ──────────────────────────────────────────────────
function renderPendingRequests() {
  const section = document.getElementById('pending-requests-section');
  const list    = document.getElementById('pending-requests-list');
  if (!section || !list) return;

  const reqs = friendsState.requests;
  section.classList.toggle('hidden', reqs.length === 0);
  if (reqs.length === 0) { list.innerHTML = ''; return; }

  list.innerHTML = reqs.map(r => {
    const initials = (r.user.username || '?')[0].toUpperCase();
    const avatarHtml = r.user.avatar
      ? `<img src="${escHtml(r.user.avatar)}" alt="${escHtml(r.user.username)}" />`
      : initials;
    return `
      <div class="request-card">
        <div class="friend-avatar small">${avatarHtml}</div>
        <div class="friend-info">
          <div class="friend-name">${escHtml(r.user.username)}</div>
          <div class="friend-status-text">Wants to be friends</div>
        </div>
        <div class="friend-actions">
          <button class="friend-accept-btn" onclick="acceptRequest('${escHtml(r.fromId)}')">✓</button>
          <button class="friend-remove-btn" onclick="declineRequest('${escHtml(r.fromId)}')">✕</button>
        </div>
      </div>`;
  }).join('');
}

// ─── Global helpers for inline onclick ───────────────────────────────────────
window.inviteFriend = function(friendId) {
  const roomId   = window.State?.currentRoom;
  const roomCode = document.getElementById('room-code-value')?.textContent || '';
  if (!roomId) return;
  getEngine().inviteToRoom(friendId, roomId, roomCode);
  showFriendToast('📨 Invite sent!', null, 'success');
};

window.removeFriendById = function(friendId) {
  getEngine().removeFriend(friendId);
};

window.acceptRequest = function(fromId) {
  getEngine().acceptFriendRequest(fromId);
  friendsState.requests = friendsState.requests.filter(r => r.fromId !== fromId);
  renderPendingRequests();
  updateFriendsBadge();
};

window.declineRequest = function(fromId) {
  getEngine().declineFriendRequest(fromId);
  friendsState.requests = friendsState.requests.filter(r => r.fromId !== fromId);
  renderPendingRequests();
  updateFriendsBadge();
};

// ─── Room Invite Pop-up ───────────────────────────────────────────────────────
function showRoomInvite({ fromUsername, roomCode, roomId }) {
  // Remove any existing invite
  document.getElementById('room-invite-popup')?.remove();

  const popup = document.createElement('div');
  popup.id = 'room-invite-popup';
  popup.className = 'room-invite-popup';
  popup.innerHTML = `
    <div class="room-invite-inner">
      <div class="room-invite-icon">🎮</div>
      <div class="room-invite-text">
        <span class="room-invite-name">${escHtml(fromUsername)}</span>
        <span> invited you to join a room!</span>
        <div class="room-invite-code">Code: <b>${escHtml(roomCode)}</b></div>
      </div>
      <div class="room-invite-btns">
        <button class="invite-accept-btn" id="btn-invite-join">Join</button>
        <button class="invite-dismiss-btn" id="btn-invite-dismiss">✕</button>
      </div>
    </div>
  `;
  document.body.appendChild(popup);

  document.getElementById('btn-invite-join')?.addEventListener('click', () => {
    popup.remove();
    // Auto-fill and join
    const input = document.getElementById('room-id-input');
    if (input) { input.value = roomCode; }
    showView('view-dashboard');
    window.joinRoom?.(roomId || roomCode, 8);
  });

  document.getElementById('btn-invite-dismiss')?.addEventListener('click', () => popup.remove());

  // Auto-dismiss after 30s
  setTimeout(() => popup?.remove?.(), 30000);
}

// ─── Friend Toast ─────────────────────────────────────────────────────────────
function showFriendToast(msg, duration = 3500, type = 'info') {
  const colors = { info: 'var(--accent)', success: '#22C55E', error: 'var(--danger)' };
  const textColors = { info: '#0D1117', success: '#0D1117', error: '#fff' };
  const t = document.createElement('div');
  t.style.cssText = `
    position:fixed;bottom:88px;right:14px;
    background:${colors[type] || colors.info};
    color:${textColors[type] || textColors.info};
    padding:10px 16px;border-radius:12px;font-size:12px;font-weight:600;
    z-index:9999;animation:fadeIn 0.2s ease;
    box-shadow:0 4px 16px rgba(0,0,0,0.4);max-width:240px;
  `;
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), duration || 3500);
}

// ─── Util ─────────────────────────────────────────────────────────────────────
function escHtml(s = '') {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ─── Init — called directly (scripts are at bottom of body, DOM is ready) ─────
initFriends();
