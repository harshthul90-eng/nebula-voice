/**
 * friends.js — In-memory friends, presence, and user registry.
 * All data resets on server restart (add a DB layer for persistence).
 */
const { getAllUsers } = require('./auth');

// ── User Registry ─────────────────────────────────────────────────────────────
// Populated when users authenticate via WS or REST
const userRegistry = new Map(); // userId → { id, username, avatar }

function registerUser(userId, info) {
  userRegistry.set(String(userId), {
    id:       String(userId),
    username: info.username || 'Unknown',
    avatar:   info.avatar   || null,
  });
}

function findUserByUsername(query) {
  const q = (query || '').toLowerCase().trim();
  if (!q) return null;
  return [...userRegistry.values()].find(u => u.username.toLowerCase() === q) || null;
}

function getRegisteredUser(userId) {
  return userRegistry.get(String(userId)) || null;
}

// ── Online Presence ───────────────────────────────────────────────────────────
const onlineMap = new Map(); // userId → { ws, peerId, status, roomId, username, avatar }

function setOnline(userId, info) { onlineMap.set(String(userId), info); }
function setOffline(userId)       { onlineMap.delete(String(userId)); }
function getOnline(userId)        { return onlineMap.get(String(userId)) || null; }
function isOnline(userId)         { return onlineMap.has(String(userId)); }

// ── Friend Store ──────────────────────────────────────────────────────────────
const friendships = new Map(); // userId → Set<userId>
const pendingReqs = new Map(); // toUserId → Set<fromUserId>

function sendFriendRequest(fromId, toId) {
  fromId = String(fromId); toId = String(toId);
  if (fromId === toId)       return { error: 'Cannot add yourself' };
  if (areFriends(fromId, toId)) return { error: 'Already friends' };
  // If target already sent us a request → auto-accept
  if (pendingReqs.get(fromId)?.has(toId)) return acceptFriendRequest(fromId, toId);
  if (!pendingReqs.has(toId)) pendingReqs.set(toId, new Set());
  if (pendingReqs.get(toId).has(fromId)) return { error: 'Request already pending' };
  pendingReqs.get(toId).add(fromId);
  return { ok: true };
}

function acceptFriendRequest(userId, fromId) {
  userId = String(userId); fromId = String(fromId);
  const reqs = pendingReqs.get(userId);
  if (!reqs?.has(fromId)) return { error: 'No request found' };
  reqs.delete(fromId);
  _addFriendship(userId, fromId);
  return { ok: true };
}

function declineFriendRequest(userId, fromId) {
  pendingReqs.get(String(userId))?.delete(String(fromId));
  return { ok: true };
}

function removeFriend(aId, bId) {
  aId = String(aId); bId = String(bId);
  friendships.get(aId)?.delete(bId);
  friendships.get(bId)?.delete(aId);
}

function getFriendIds(userId) {
  return [...(friendships.get(String(userId)) || [])];
}

function getPendingRequests(userId) {
  return [...(pendingReqs.get(String(userId)) || [])].map(fromId => ({
    fromId,
    user: getRegisteredUser(fromId) || { id: fromId, username: 'Unknown', avatar: null },
  }));
}

function areFriends(a, b) {
  return !!(friendships.get(String(a))?.has(String(b)));
}

function _addFriendship(a, b) {
  if (!friendships.has(a)) friendships.set(a, new Set());
  if (!friendships.has(b)) friendships.set(b, new Set());
  friendships.get(a).add(b);
  friendships.get(b).add(a);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Send a WS message to all online friends of userId. */
function notifyFriends(userId, msg) {
  // Global Directory: send to ALL online users except oneself
  for (const [uid, info] of onlineMap.entries()) {
    if (uid !== String(userId) && info.ws?.readyState === 1) {
      try { info.ws.send(JSON.stringify(msg)); } catch (_) {}
    }
  }
}

/** Get friend list enriched with live presence info. */
function getFriendsWithPresence(userId) {
  // Global Directory: return all registered users
  const allUsers = getAllUsers();
  return allUsers
    .filter(u => String(u.id) !== String(userId))
    .map(user => {
      const fid = String(user.id);
      const online = getOnline(fid);
      return {
        id:       fid,
        username: user.username,
        avatar:   user.avatar,
        status:   online ? online.status : 'offline',
        roomId:   online?.roomId || null,
      };
    });
}

module.exports = {
  registerUser, findUserByUsername, getRegisteredUser,
  setOnline, setOffline, getOnline, isOnline,
  sendFriendRequest, acceptFriendRequest, declineFriendRequest, removeFriend,
  getFriendIds, getPendingRequests, areFriends,
  notifyFriends, getFriendsWithPresence,
};
