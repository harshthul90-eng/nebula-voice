/**
 * auth.js — Login, Register, Google OAuth UI logic
 */

const API = 'https://nebula-voicechat.onrender.com/api';

// ─── Helpers ──────────────────────────────────────────────────────────────────
function setLoading(btnId, loading) {
  const btn = document.getElementById(btnId);
  if (!btn) return;
  btn.disabled = loading;
  btn.querySelector('.btn-label').classList.toggle('hidden', loading);
  btn.querySelector('.btn-spinner').classList.toggle('hidden', !loading);
}

function showError(elId, msg) {
  const el = document.getElementById(elId);
  if (!el) return;
  el.textContent = msg;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 5000);
}

function clearError(elId) {
  document.getElementById(elId)?.classList.add('hidden');
}

// ─── Tab Switcher ──────────────────────────────────────────────────────────────
document.querySelectorAll('.auth-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    const target = tab.dataset.tab;
    document.querySelectorAll('.auth-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === target));
    document.getElementById('form-login').classList.toggle('active', target === 'login');
    document.getElementById('form-login').classList.toggle('hidden', target !== 'login');
    document.getElementById('form-register').classList.toggle('active', target === 'register');
    document.getElementById('form-register').classList.toggle('hidden', target !== 'register');
    clearError('login-error');
    clearError('register-error');
  });
});

// ─── Password visibility toggle ────────────────────────────────────────────────
document.querySelectorAll('.btn-show-pass').forEach(btn => {
  btn.addEventListener('click', () => {
    const input = document.getElementById(btn.dataset.target);
    if (!input) return;
    input.type = input.type === 'password' ? 'text' : 'password';
    btn.textContent = input.type === 'password' ? '👁' : '🙈';
  });
});

// ─── Login Form ────────────────────────────────────────────────────────────────
document.getElementById('form-login')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  clearError('login-error');

  const username = document.getElementById('login-username').value.trim();
  const password = document.getElementById('login-password').value;
  if (!username || !password) { showError('login-error', 'Please fill in all fields.'); return; }

  setLoading('btn-login', true);
  try {
    const res = await fetch(`${API}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (!res.ok) { showError('login-error', data.error || 'Login failed.'); return; }
    onLoginSuccess(data.token, data.user);
  } catch {
    showError('login-error', 'Cannot connect to server. Is the backend running?');
  } finally {
    setLoading('btn-login', false);
  }
});

// ─── Register Form ─────────────────────────────────────────────────────────────
document.getElementById('form-register')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  clearError('register-error');

  const username = document.getElementById('reg-username').value.trim();
  const password = document.getElementById('reg-password').value;
  if (!username || !password) { showError('register-error', 'Please fill in all fields.'); return; }

  setLoading('btn-register', true);
  try {
    const res = await fetch(`${API}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (!res.ok) { showError('register-error', data.error || 'Registration failed.'); return; }
    onLoginSuccess(data.token, data.user);
  } catch {
    showError('register-error', 'Cannot connect to server. Is the backend running?');
  } finally {
    setLoading('btn-register', false);
  }
});

// ─── Google Sign-In ────────────────────────────────────────────────────────────
document.getElementById('btn-google-signin')?.addEventListener('click', () => {
  const api = window.nebula;

  if (api?.openGoogleAuth) {
    // Electron: open an in-app OAuth window
    api.openGoogleAuth(`${API}/auth/google`);

    // Listen for result
    api.onGoogleAuthResult((result) => {
      if (result.error) {
        showError('login-error', `Google sign-in failed: ${result.error}`);
        return;
      }
      if (!result.token) return;

      // Decode basic payload (no library needed — just parse middle segment)
      try {
        const payload = JSON.parse(atob(result.token.split('.')[1]));
        onLoginSuccess(result.token, {
          id: payload.id,
          username: payload.username,
          avatar: payload.avatar,
          email: payload.email,
        });
      } catch {
        showError('login-error', 'Failed to parse auth token.');
      }
    });
  } else {
    // Browser / dev: open in new tab for testing
    window.open(`${API}/auth/google`, '_blank', 'width=500,height=640');
  }
});
