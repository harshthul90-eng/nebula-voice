/**
 * friends.js — Persistence-backed presence and social graph.
 * Presence (onlineMap) remains in-memory for performance.
 * User registry and friendships are powered by MongoDB.
 */
const User = require('./models/User');

// ── Online Presence (In-Memory) ──────────────────────────────────────────────
const onlineMap = new Map(); // userId → { ws, peerId, status, roomId, username, avatar }

function setOnline(userId, info) { onlineMap.set(String(userId), info); }
function setOffline(userId)       { onlineMap.delete(String(userId)); }
function getOnline(userId)        { return onlineMap.get(String(userId)) || null; }
function isOnline(userId)         { return onlineMap.has(String(userId)); }

// ── User / Friend Logic (MongoDB) ─────────────────────────────────────────────

async function registerUser(userId, info) {
  // Check if user already exists in DB
  const existing = await User.findOne({ id: String(userId) });
  if (!existing) {
    await User.create({
      id: String(userId),
      username: info.username || 'Unknown',
      avatar: info.avatar || null,
    });
  }
}

async function findUserByUsername(query) {
  const q = (query || '').toLowerCase().trim();
  if (!q) return null;
  return await User.findOne({ username: { $regex: new RegExp(`^${q}$`, 'i') } });
}

async function getRegisteredUser(userId) {
  return await User.findOne({ id: String(userId) });
}

async function sendFriendRequest(fromId, toId) {
  fromId = String(fromId); toId = String(toId);
  if (fromId === toId) return { error: 'Cannot add yourself' };
  
  const fromUser = await User.findOne({ id: fromId });
  const toUser = await User.findOne({ id: toId });
  if (!fromUser || !toUser) return { error: 'User not found' };

  if (fromUser.friendIds.includes(toId)) return { error: 'Already friends' };
  
  // If target already sent us a request → auto-accept
  if (fromUser.pendingRequests.includes(toId)) {
    return await acceptFriendRequest(fromId, toId);
  }

  // Check if we already sent a request
  if (toUser.pendingRequests.includes(fromId)) return { error: 'Request already pending' };

  await User.updateOne({ id: toId }, { $addToSet: { pendingRequests: fromId } });
  return { ok: true };
}

async function acceptFriendRequest(userId, fromId) {
  userId = String(userId); fromId = String(fromId);
  
  const user = await User.findOne({ id: userId });
  if (!user || !user.pendingRequests.includes(fromId)) return { error: 'No request found' };

  // Remove from pending, add to friends for both
  await User.updateOne({ id: userId }, { 
    $pull: { pendingRequests: fromId },
    $addToSet: { friendIds: fromId }
  });
  await User.updateOne({ id: fromId }, { 
    $addToSet: { friendIds: userId }
  });

  return { ok: true, autoAccepted: true };
}

async function declineFriendRequest(userId, fromId) {
  await User.updateOne({ id: String(userId) }, { $pull: { pendingRequests: String(fromId) } });
  return { ok: true };
}

async function removeFriend(aId, bId) {
  aId = String(aId); bId = String(bId);
  await User.updateOne({ id: aId }, { $pull: { friendIds: bId } });
  await User.updateOne({ id: bId }, { $pull: { friendIds: aId } });
  return { ok: true };
}

async function getFriendIds(userId) {
  const user = await User.findOne({ id: String(userId) });
  return user ? user.friendIds : [];
}

async function getPendingRequests(userId) {
  const user = await User.findOne({ id: String(userId) });
  if (!user) return [];
  
  const requests = await User.find({ id: { $in: user.pendingRequests } });
  return requests.map(u => ({
    fromId: u.id,
    user: { id: u.id, username: u.username, avatar: u.avatar }
  }));
}

async function areFriends(a, b) {
  const user = await User.findOne({ id: String(a) });
  return user ? user.friendIds.includes(String(b)) : false;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Send a WS message to all online users (Global Directory logic). */
function notifyFriends(userId, msg) {
  for (const [uid, info] of onlineMap.entries()) {
    if (uid !== String(userId) && info.ws?.readyState === 1) {
      try { info.ws.send(JSON.stringify(msg)); } catch (_) {}
    }
  }
}

/** Get list of users with presence info (currently returns ALL users for Global Directory). */
async function getFriendsWithPresence(userId) {
  const allUsers = await User.find({});
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
