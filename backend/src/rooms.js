/**
 * In-memory room registry.
 * rooms:   Map<roomId, { peers, maxPeers, code, createdAt }>
 * codeMap: Map<code,   roomId>   — reverse lookup for join-by-code
 */

const rooms   = new Map();
const codeMap = new Map(); // '12345' → 'squad-alpha'

const DEFAULT_MAX_PEERS = 10;
const ABSOLUTE_MAX      = 50;

// ─── Code generation ──────────────────────────────────────────────────────────
function generateCode() {
  let code;
  do {
    // 5-digit: 10000–99999
    code = String(Math.floor(10000 + Math.random() * 90000));
  } while (codeMap.has(code));
  return code;
}

function _makeRoom(maxPeers) {
  return {
    peers:     new Map(),
    maxPeers:  Math.min(Math.max(1, maxPeers || DEFAULT_MAX_PEERS), ABSOLUTE_MAX),
    code:      generateCode(),
    createdAt: new Date(),
  };
}

// ─── API ──────────────────────────────────────────────────────────────────────

function getOrCreateRoom(roomId, maxPeers) {
  if (!rooms.has(roomId)) {
    const room = _makeRoom(maxPeers);
    rooms.set(roomId, room);
    codeMap.set(room.code, roomId); // register code → roomId
  }
  return rooms.get(roomId);
}

/** Resolve a 5-digit code to its real roomId (or null if not found). */
function resolveCode(code) {
  return codeMap.get(String(code)) || null;
}

/** Get the room code for a given roomId. */
function getRoomCode(roomId) {
  return rooms.get(roomId)?.code || null;
}

function isRoomFull(roomId) {
  const room = rooms.get(roomId);
  if (!room) return false;
  return room.peers.size >= room.maxPeers;
}

function getRoomCapacity(roomId) {
  const room = rooms.get(roomId);
  if (!room) return { current: 0, max: DEFAULT_MAX_PEERS };
  return { current: room.peers.size, max: room.maxPeers };
}

function addPeerToRoom(roomId, peerId, peerInfo, maxPeers) {
  const room = getOrCreateRoom(roomId, maxPeers);
  room.peers.set(peerId, peerInfo);
  return room;
}

function removePeerFromRoom(roomId, peerId) {
  const room = rooms.get(roomId);
  if (room) {
    room.peers.delete(peerId);
    if (room.peers.size === 0) {
      codeMap.delete(room.code); // free the code when room is empty
      rooms.delete(roomId);
    }
  }
}

function getRoomPeers(roomId) {
  return rooms.get(roomId)?.peers || new Map();
}

function getPeerRoom(peerId) {
  for (const [roomId, room] of rooms) {
    if (room.peers.has(peerId)) return roomId;
  }
  return null;
}

function getAllRooms() {
  return [...rooms.entries()].map(([roomId, room]) => ({
    roomId, peerCount: room.peers.size, maxPeers: room.maxPeers, code: room.code,
  }));
}

module.exports = {
  getOrCreateRoom, resolveCode, getRoomCode,
  isRoomFull, getRoomCapacity,
  addPeerToRoom, removePeerFromRoom, getRoomPeers, getPeerRoom, getAllRooms,
};
