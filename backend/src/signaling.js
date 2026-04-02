const { WebSocketServer } = require('ws');
const { v4: uuidv4 } = require('uuid');
const {
  addPeerToRoom, removePeerFromRoom, getRoomPeers, getPeerRoom,
  isRoomFull, getRoomCapacity, resolveCode, getRoomCode,
} = require('./rooms');
const { verifyToken } = require('./auth');
const {
  registerUser, getRegisteredUser, findUserByUsername,
  setOnline, setOffline, getOnline,
  sendFriendRequest, acceptFriendRequest, declineFriendRequest, removeFriend,
  getPendingRequests, getFriendIds, areFriends,
  notifyFriends, getFriendsWithPresence,
} = require('./friends');

function setupSignaling(server) {
  const wss = new WebSocketServer({ server, path: '/ws' });
  const peerSockets = new Map(); // peerId → ws
  const peerUserMap = new Map(); // peerId → userId (set on authenticate)

  // ─── Helpers ────────────────────────────────────────────────────────────────
  function broadcast(roomId, message, excludePeerId = null) {
    const room = getRoomPeers(roomId);
    if (!room) return;
    const payload = JSON.stringify(message);
    for (const [peerId, peer] of room) {
      if (peerId !== excludePeerId && peer.ws.readyState === 1 /* OPEN */) {
        peer.ws.send(payload);
      }
    }
  }

  function sendToPeer(peerId, message) {
    const ws = peerSockets.get(peerId);
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify(message));
    }
  }

  // ─── Connection Handler ──────────────────────────────────────────────────────
  wss.on('connection', (ws) => {
    const peerId = uuidv4();
    peerSockets.set(peerId, ws);

    // Let the client know its assigned peer ID immediately
    ws.send(JSON.stringify({ type: 'connected', peerId }));

    // ─── Message Handler ─────────────────────────────────────────────────────
    ws.on('message', async (data) => {
      let msg;
      try {
        msg = JSON.parse(data);
      } catch {
        return; // Ignore malformed messages
      }

      switch (msg.type) {

        // ── authenticate ─ called right after WS connect, registers presence ──
        case 'authenticate': {
          const user = verifyToken(msg.token);
          if (!user) { ws.send(JSON.stringify({ type: 'auth-error' })); break; }
          
          await registerUser(user.id, user); // Async DB call
          peerUserMap.set(peerId, String(user.id));
          setOnline(user.id, { ws, peerId, status: 'online', roomId: null, username: user.username, avatar: user.avatar });
          
          // Tell others this user is online
          notifyFriends(user.id, {
            type: 'friend-status', userId: String(user.id), username: user.username,
            avatar: user.avatar, status: 'online', roomId: null,
          });
          
          ws.send(JSON.stringify({ type: 'authenticated', userId: String(user.id) }));
          
          const pending = await getPendingRequests(user.id);
          if (pending?.length) ws.send(JSON.stringify({ type: 'pending-requests', requests: pending }));
          break;
        }

        // ── join-room ─────────────────────────────────────────────────────────
        case 'join-room': {
          const { token, maxPeers } = msg;
          let { roomId } = msg;
          if (!roomId) return;

          // ── Resolve 5-digit code → real roomId ────────────────────────────
          const isCode = /^\d{5}$/.test(String(roomId));
          if (isCode) {
            const resolved = resolveCode(roomId);
            if (!resolved) {
              ws.send(JSON.stringify({
                type: 'error',
                message: `Room code "${roomId}" not found. Ask the host to share the correct code.`,
              }));
              return;
            }
            roomId = resolved;
          }

          // Verify auth token
          const user = verifyToken(token);
          if (!user) {
            ws.send(JSON.stringify({ type: 'error', message: 'Unauthorized' }));
            return;
          }

          // ── Capacity check ────────────────────────────────────────────────
          if (isRoomFull(roomId)) {
            const cap = getRoomCapacity(roomId);
            ws.send(JSON.stringify({
              type: 'room-full',
              roomId,
              current: cap.current,
              max:     cap.max,
              message: `Room "${roomId}" is full (${cap.current}/${cap.max} players)`,
            }));
            console.log(`[Room ${roomId}] ${user.username} rejected — room full (${cap.current}/${cap.max})`);
            return;
          }

          const existingRoom = getRoomPeers(roomId);
          const existingPeers = [...existingRoom.entries()].map(([pid, p]) => ({
            peerId: pid,
            username: p.username,
            avatar: p.avatar,
            muted: p.muted,
            status: p.status || 'online',
          }));

          // Register peer (pass maxPeers so first joiner sets capacity)
          addPeerToRoom(roomId, peerId, {
            ws,
            userId: user.id,
            username: user.username,
            avatar: user.avatar,
            muted: false,
            deafened: false,
            status: msg.status || 'online',
          }, maxPeers);

          const capacity = getRoomCapacity(roomId);
          const roomCode = getRoomCode(roomId);

          // Update presence
          const userId = peerUserMap.get(peerId);
          if (userId) {
            const p = getOnline(userId);
            if (p) { p.status = 'in-match'; p.roomId = roomId; }
            notifyFriends(userId, { type: 'friend-status', userId, username: user.username, avatar: user.avatar, status: 'in-match', roomId });
          }

          // Send current room state + capacity + code to newcomer
          ws.send(JSON.stringify({
            type: 'room-joined',
            roomId,
            roomCode,
            peerId,
            peers: existingPeers,
            maxPeers: capacity.max,
          }));

          // Notify everyone else (include updated count)
          broadcast(roomId, {
            type: 'peer-joined',
            peerId,
            username: user.username,
            avatar: user.avatar,
            status: msg.status || 'online',
            current: capacity.current,
            max:     capacity.max,
          }, peerId);

          console.log(`[Room ${roomId}] ${user.username} joined (${capacity.current}/${capacity.max})`);
          break;
        }

        case 'leave-room': {
          const roomId = getPeerRoom(peerId);
          if (roomId) {
            removePeerFromRoom(roomId, peerId);
            broadcast(roomId, { type: 'peer-left', peerId });
            console.log(`[Room ${roomId}] Peer ${peerId.slice(0, 8)} left`);
          }
          // Update presence → back to online
          const leavingUserId = peerUserMap.get(peerId);
          if (leavingUserId) {
            const pInfo = getOnline(leavingUserId);
            if (pInfo) { pInfo.status = 'online'; pInfo.roomId = null; }
            const lu = await getRegisteredUser(leavingUserId);
            notifyFriends(leavingUserId, { type: 'friend-status', userId: leavingUserId, username: lu?.username, avatar: lu?.avatar, status: 'online', roomId: null });
          }
          break;
        }

        // ── WebRTC Signaling relay ─────────────────────────────────────────────
        case 'offer':
        case 'answer':
        case 'ice-candidate':
          sendToPeer(msg.targetPeerId, { ...msg, fromPeerId: peerId });
          break;

        // ── Voice state broadcast ──────────────────────────────────────────────
        case 'speaking': {
          const roomId = getPeerRoom(peerId);
          if (roomId) {
            broadcast(roomId, { type: 'speaking', peerId, speaking: msg.speaking }, peerId);
          }
          break;
        }

        case 'mute-state': {
          const roomId = getPeerRoom(peerId);
          if (roomId) {
            const room = getRoomPeers(roomId);
            const peer = room.get(peerId);
            if (peer) peer.muted = msg.muted;
            broadcast(roomId, { type: 'mute-state', peerId, muted: msg.muted }, peerId);
          }
          break;
        }

        case 'chat-message': {
          const roomId = getPeerRoom(peerId);
          if (!roomId) break;
          const room = getRoomPeers(roomId);
          const sender = room.get(peerId);
          if (!sender) break;
          const text = String(msg.text || '').trim().slice(0, 500);
          if (!text) break;
          // Broadcast to everyone INCLUDING sender (server-confirmed echo)
          broadcast(roomId, {
            type:      'chat-message',
            peerId,
            username:  sender.username,
            avatar:    sender.avatar,
            text,
            timestamp: Date.now(),
          }); // no excludePeerId — sender sees their own message via server
          break;
        }

        case 'global-chat-message': {
          const userId = peerUserMap.get(peerId);
          if (!userId) break;
          const user = await getRegisteredUser(userId);
          const text = String(msg.text || '').trim().slice(0, 500);
          if (!text) break;
          const payload = JSON.stringify({
            type: 'global-chat-message',
            userId,
            username: user?.username || 'Unknown',
            avatar: user?.avatar,
            text,
            timestamp: Date.now(),
          });
          for (const wsClient of wss.clients) {
            if (wsClient.readyState === 1) wsClient.send(payload);
          }
          break;
        }

        case 'set-status': {
          const roomId = getPeerRoom(peerId);
          const validStatuses = ['online', 'away', 'in-match'];
          const status = validStatuses.includes(msg.status) ? msg.status : 'online';
          if (roomId) {
            const room = getRoomPeers(roomId);
            const peer = room.get(peerId);
            if (peer) peer.status = status;
            broadcast(roomId, { type: 'status-update', peerId, status }, peerId);
          }
          // Also update presence and notify friends
          const userId2 = peerUserMap.get(peerId);
          if (userId2) {
            const pInfo = getOnline(userId2);
            if (pInfo) pInfo.status = status;
            const u2 = await getRegisteredUser(userId2);
            notifyFriends(userId2, { type: 'friend-status', userId: userId2, username: u2?.username, avatar: u2?.avatar, status, roomId: pInfo?.roomId || null });
          }
          break;
        }

        // ── Friend system ─────────────────────────────────────────────────────
        case 'send-friend-request': {
          const fromUserId = peerUserMap.get(peerId);
          if (!fromUserId) break;
          const target = await findUserByUsername(msg.username);
          if (!target) { ws.send(JSON.stringify({ type: 'friend-error', message: `User "${msg.username}" not found` })); break; }
          if (target.id === fromUserId) { ws.send(JSON.stringify({ type: 'friend-error', message: 'Cannot add yourself' })); break; }
          
          const result = await sendFriendRequest(fromUserId, target.id);
          if (result.error) { ws.send(JSON.stringify({ type: 'friend-error', message: result.error })); break; }
          
          const targetOnline = getOnline(target.id);
          const fromUser = await getRegisteredUser(fromUserId);
          if (targetOnline?.ws?.readyState === 1) {
            targetOnline.ws.send(JSON.stringify({ type: 'friend-request', fromId: fromUserId, username: fromUser?.username, avatar: fromUser?.avatar }));
          }
          
          ws.send(JSON.stringify({ 
            type: 'friend-request-sent', 
            targetId: target.id, 
            targetUsername: target.username, 
            autoAccepted: !!result.autoAccepted 
          }));
          
          // If auto-accepted, send friend-added to both
          if (result.ok && (await areFriends(fromUserId, target.id))) {
            const senderPresence = getOnline(fromUserId);
            ws.send(JSON.stringify({ 
              type: 'friend-added', 
              friend: { 
                id: target.id, username: target.username, avatar: target.avatar, 
                status: targetOnline ? targetOnline.status : 'offline', 
                roomId: targetOnline?.roomId || null 
              } 
            }));
            if (targetOnline?.ws?.readyState === 1) {
              targetOnline.ws.send(JSON.stringify({ 
                type: 'friend-added', 
                friend: { 
                  id: fromUserId, username: fromUser?.username, avatar: fromUser?.avatar, 
                  status: senderPresence ? senderPresence.status : 'online', 
                  roomId: senderPresence?.roomId || null 
                } 
              }));
            }
          }
          break;
        }

        case 'accept-friend-request': {
          const userId = peerUserMap.get(peerId);
          if (!userId) break;
          const result = await acceptFriendRequest(userId, msg.fromId);
          if (result.error) break;
          
          const fromUser = await getRegisteredUser(msg.fromId);
          const myUser = await getRegisteredUser(userId);
          const myOnline = getOnline(userId);
          const fromOnline = getOnline(msg.fromId);
          
          ws.send(JSON.stringify({ 
            type: 'friend-added', 
            friend: { 
              id: msg.fromId, username: fromUser?.username, avatar: fromUser?.avatar, 
              status: fromOnline ? fromOnline.status : 'offline', 
              roomId: fromOnline?.roomId || null 
            } 
          }));
          
          if (fromOnline?.ws?.readyState === 1) {
            fromOnline.ws.send(JSON.stringify({ 
              type: 'friend-added', 
              friend: { 
                id: userId, username: myUser?.username, avatar: myUser?.avatar, 
                status: myOnline ? myOnline.status : 'online', 
                roomId: myOnline?.roomId || null 
              } 
            }));
          }
          break;
        }

        case 'decline-friend-request': {
          const userId = peerUserMap.get(peerId);
          if (userId) await declineFriendRequest(userId, msg.fromId);
          break;
        }

        case 'remove-friend': {
          const userId = peerUserMap.get(peerId);
          if (userId) await removeFriend(userId, msg.friendId);
          ws.send(JSON.stringify({ type: 'friend-removed', friendId: msg.friendId }));
          break;
        }

        case 'invite-to-room': {
          const fromUserId = peerUserMap.get(peerId);
          if (!fromUserId) break;
          const fromUser = await getRegisteredUser(fromUserId);
          const targetOnline = getOnline(msg.friendId);
          if (targetOnline?.ws?.readyState === 1) {
            targetOnline.ws.send(JSON.stringify({
              type:         'room-invite',
              fromId:       fromUserId,
              fromUsername: fromUser?.username,
              fromAvatar:   fromUser?.avatar,
              roomId:       msg.roomId,
              roomCode:     msg.roomCode,
            }));
          }
          break;
        }

        case 'get-friends': {
          const userId = peerUserMap.get(peerId);
          if (!userId) break;
          const friends = await getFriendsWithPresence(userId);
          ws.send(JSON.stringify({ type: 'friends-list', friends }));
          break;
        }

        default:
          break;
      }
    });

    // ─── Disconnect Handler ────────────────────────────────────────────────────
    ws.on('close', async () => {
      const roomId = getPeerRoom(peerId);
      if (roomId) {
        removePeerFromRoom(roomId, peerId);
        broadcast(roomId, { type: 'peer-left', peerId });
      }
      
      const userId = peerUserMap.get(peerId);
      if (userId) {
        setOffline(userId);
        peerUserMap.delete(peerId);
        const u = await getRegisteredUser(userId);
        notifyFriends(userId, { type: 'friend-status', userId, username: u?.username, avatar: u?.avatar, status: 'offline', roomId: null });
      }
      peerSockets.delete(peerId);
    });

    ws.on('error', (err) => {
      console.error(`WS error for peer ${peerId.slice(0, 8)}:`, err.message);
    });
  });

  console.log('🔌 WebSocket signaling server ready at /ws');
}

module.exports = { setupSignaling };
