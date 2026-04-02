const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  username: { type: String, required: true, unique: true, index: true },
  passwordHash: { type: String },
  email: { type: String, default: null },
  googleId: { type: String, default: null },
  avatar: { type: String, default: null },
  createdAt: { type: Date, default: Date.now },
  friendIds: { type: [String], default: [] },
  pendingRequests: { type: [String], default: [] }
});


module.exports = mongoose.model('User', UserSchema);
