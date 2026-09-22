'use strict';
/* ═══════════════════════════════════════════════════════════
   ORBIS — script.js
     (1) Constants & module registry
     (2) Storage helpers (users, session, activity)
     (3) showView + toast + modal + confirm systems
     (4) Ambient animation controllers
     (5) Validation helpers
     (6) Auth flow (login, signup, MFA)
     (7) Session manager
     (8) Admin dashboard renderers & handlers
     (9) Init

   Sections 1–3 and 7 are the reusable foundation. Later stages
   (Flight Board, GSE Entry, …) call showView / showToast /
   confirmDialog / getSession / hasPermission without refactoring.
   ═══════════════════════════════════════════════════════════ */

/* ═══ (1) CONSTANTS & MODULE REGISTRY ═══════════════════════ */

const USERS_KEY = 'orbis_users';
const SESSION_KEY = 'orbis_session';
const ACTIVITY_KEY = 'orbis_activity';
const SESSION_MS = 15 * 60 * 1000;     // 15-minute session
const MFA_CODE = '12345';
const LOAD_DELAY = 500;

const ROLES = {
  SUPER_ADMIN: 'System Administrator',
  SUPERVISOR: 'Ramp Supervisor',
  SHIFT_MANAGER: 'Shift Operations Manager',
  STATION_ADMIN: 'Station Administrator',
  AIRLINE_REP: 'Airline Representative'
};

const STATUSES = { PENDING: 'Pending', APPROVED: 'Approved', REJECTED: 'Rejected', SUSPENDED: 'Suspended' };

/* SVG path bodies for the ORBIS modules */
const ICONS = {
  flightboard: '<path d="M12 2 L14.5 9.5 L22 12 L14.5 14.5 L12 22 L9.5 14.5 L2 12 L9.5 9.5 Z"/>',
  turnaround: '<path d="M21 12 a9 9 0 1 1-3-6.7"/><path d="M21 4 V9 H16"/>',
  gse: '<rect x="3" y="7" width="12" height="8" rx="1.5"/><path d="M15 10 h4 l2 3 v2 h-6"/><circle cx="7" cy="17" r="1.7"/><circle cx="17" cy="17" r="1.7"/>',
  offblock: '<circle cx="12" cy="12" r="9"/><path d="M12 7 V12 L15.5 14"/>',
  manager: '<path d="M4 20 V10 M10 20 V4 M16 20 V13 M22 20 H2"/>',
  equipment: '<path d="M12 2 v3 M12 19 v3 M2 12 h3 M19 12 h3"/><circle cx="12" cy="12" r="4"/><path d="M12 8 a4 4 0 0 1 4 4"/>',
  gha: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M9 8 h1.5 M13.5 8 h1.5 M9 12 h1.5 M13.5 12 h1.5 M9 16 h1.5 M13.5 16 h1.5"/>',
  weights: '<path d="M12 3 v18 M6 7 h12 M4 21 h16"/><path d="M6 7 L3 13 a3 3 0 0 0 6 0 Z"/><path d="M18 7 L15 13 a3 3 0 0 0 6 0 Z"/>',
  analytics: '<path d="M3 3 v18 h18"/><path d="M7 15 L11 10 L14 13 L20 6"/>',
  loadsheet: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M7 8 h10 M7 12 h10 M7 16 h6"/><circle cx="17.5" cy="16.5" r="1.6"/>'
};

const MODULES = {
  flightboard: { label: 'Flight Board', locked: true },
  turnaround: { label: 'Turnaround Detail', locked: false },
  gse: { label: 'GSE Entry', locked: false },
  offblock: { label: 'Block Times', locked: false },
  loadsheet: { label: 'Loadsheet', locked: false },
  manager: { label: 'Manager Dashboard', locked: false },
  equipment: { label: 'Equipment Register', locked: false },
  gha: { label: 'GHA Management', locked: false },
  weights: { label: 'Weights & Thresholds', locked: false },
  analytics: { label: 'Accuracy Analytics', locked: false }
};
const ALL_MODULES = Object.keys(MODULES);

/* corporate-email gate: reject these free providers (matched on the domain's first label) */
const FREE_PROVIDERS = new Set([
  'gmail', 'yahoo', 'hotmail', 'outlook', 'aol', 'icloud', 'mail',
  'protonmail', 'zoho', 'yandex', 'gmx', 'live', 'msn'
]);

/* ═══ (2) STORAGE HELPERS ═══════════════════════════════════ */

function readJSON(key, fallback) {
  try { const v = JSON.parse(localStorage.getItem(key)); return v == null ? fallback : v; }
  catch (e) { return fallback; }
}
function getUsers() { const u = readJSON(USERS_KEY, []); return Array.isArray(u) ? u : []; }
function saveUsers(u) { localStorage.setItem(USERS_KEY, JSON.stringify(u)); }
function findUser(pred) { return getUsers().find(pred) || null; }
function updateUser(id, changes) {
  const users = getUsers();
  const u = users.find(x => x.id === id);
  if (!u) return null;
  Object.assign(u, changes);
  saveUsers(users);
  return u;
}

function getActivity() { const a = readJSON(ACTIVITY_KEY, []); return Array.isArray(a) ? a : []; }
function logActivity({ action, target, category = 'user', severity = 'info', actor }) {
  const session = getSession();
  const entry = {
    id: uid('a'), timestamp: new Date().toISOString(),
    actor: actor || (session ? session.name : 'System'), action, target: target || '—', category, severity
  };
  const all = getActivity(); all.unshift(entry);
  localStorage.setItem(ACTIVITY_KEY, JSON.stringify(all.slice(0, 200)));
  return entry;
}

function getSession() {
  const s = readJSON(SESSION_KEY, null);
  if (!s || !s.expiresAt || Date.now() > s.expiresAt) { if (s) clearSession(); return null; }
  return s;
}
function setSession(user, expiresAt) {
  const s = {
    userId: user.id, name: user.name, email: user.email, role: user.role,
    expiresAt: expiresAt || (Date.now() + SESSION_MS)
  };
  localStorage.setItem(SESSION_KEY, JSON.stringify(s));
  return s;
}
function clearSession() { localStorage.removeItem(SESSION_KEY); }

/* seed on first load */
function seedIfEmpty() {
  if (getUsers().length) return;
  const now = Date.now();
  const iso = ms => new Date(ms).toISOString();
  const mk = (o) => Object.assign({
    id: uid('u'), permissions: ['flightboard'], organisation: '', registeredAt: iso(now),
    decidedAt: null, decidedBy: null, rejectionReason: null, sessionActive: false, lastActiveAt: null
  }, o);

  const users = [
    mk({
      id: 'seed-admin', name: 'System Admin', email: 'admin', password: 'admin', role: 'SUPER_ADMIN',
      organisation: 'ORBIS', status: 'APPROVED', permissions: [...ALL_MODULES],
      decidedAt: iso(now), decidedBy: 'System'
    }),
    mk({
      name: 'Ayesha Raza', email: 'ayesha.raza@menzies-ras.pk', password: 'Ramp@2024', role: 'SUPERVISOR',
      organisation: 'Menzies-RAS', status: 'PENDING', registeredAt: iso(now - 36e5)
    }),
    mk({
      name: 'Bilal Ahmed', email: 'bilal.ahmed@piac.com.pk', password: 'Shift@2024', role: 'SHIFT_MANAGER',
      organisation: 'PIA', status: 'PENDING', registeredAt: iso(now - 72e5)
    }),
    mk({
      name: 'Sana Malik', email: 'sana.malik@menzies-ras.pk', password: 'Statn@2024', role: 'STATION_ADMIN',
      organisation: 'Menzies-RAS', status: 'APPROVED', permissions: [...ALL_MODULES],
      registeredAt: iso(now - 864e5 * 3), decidedAt: iso(now - 864e5 * 2), decidedBy: 'System Admin', lastActiveAt: iso(now - 6e5)
    }),
    mk({
      name: 'Usman Tariq', email: 'usman.tariq@piac.com.pk', password: 'Airln@2024', role: 'AIRLINE_REP',
      organisation: 'PIA', airline: 'PK', status: 'APPROVED', permissions: ['flightboard', 'turnaround', 'manager', 'analytics'],
      registeredAt: iso(now - 864e5 * 5), decidedAt: iso(now - 864e5 * 4), decidedBy: 'System Admin'
    }),
    mk({
      name: 'Hina Shah', email: 'hina.shah@piac.com.pk', password: 'Reqst@2024', role: 'AIRLINE_REP',
      organisation: 'PIA', status: 'REJECTED', registeredAt: iso(now - 864e5 * 2),
      decidedAt: iso(now - 864e5), decidedBy: 'System Admin', rejectionReason: 'Organisation affiliation could not be verified.'
    }),
    mk({
      id: 'seed-guest', name: 'Guest Viewer', email: 'demo.viewer@orbis.local', password: 'Guest@View2026', role: 'AIRLINE_REP',
      organisation: 'ORBIS Demo', status: 'APPROVED', permissions: ['flightboard', 'turnaround', 'manager', 'analytics'],
      decidedAt: iso(now), decidedBy: 'System'
    })
  ];
  saveUsers(users);
}

/* a browser whose localStorage was seeded before the guest/demo viewer
   account existed won't pick it up from seedIfEmpty (users already present) —
   backfill it so temp access can be handed out without clearing storage */
function seedGuestUser() {
  const users = getUsers();
  if (!users.length || users.some(u => u.id === 'seed-guest')) return;
  const now = Date.now();
  users.push({
    id: 'seed-guest', name: 'Guest Viewer', email: 'demo.viewer@orbis.local', password: 'Guest@View2026', role: 'AIRLINE_REP',
    organisation: 'ORBIS Demo', permissions: ['flightboard', 'turnaround', 'manager', 'analytics'],
    registeredAt: new Date(now).toISOString(), decidedAt: new Date(now).toISOString(), decidedBy: 'System',
    status: 'APPROVED', rejectionReason: null, sessionActive: false, lastActiveAt: null
  });
  saveUsers(users);
}

/* a returning browser's admin/station-admin accounts were seeded before the
   'gha' module existed, so their frozen permissions arrays never picked it
   up automatically — backfill it for those two roles only, matching the
   "granted to the admin + station admins by default" rule from a fresh seed */
function migratePermissions() {
  const users = getUsers();
  let changed = false;
  users.forEach(u => {
    if ((u.role === 'SUPER_ADMIN' || u.role === 'STATION_ADMIN') && u.permissions && !u.permissions.includes('gha')) {
      u.permissions.push('gha'); changed = true;
    }
    /* 'loadsheet' defaults to station admin + ramp supervisor roles */
    if ((u.role === 'SUPER_ADMIN' || u.role === 'STATION_ADMIN' || u.role === 'SUPERVISOR') && u.permissions && !u.permissions.includes('loadsheet')) {
      u.permissions.push('loadsheet'); changed = true;
    }
  });
  if (changed) saveUsers(users);
}

/* ═══ (3) showView + toast + modal + confirm ════════════════ */

const VIEW_IDS = ['view-auth', 'view-mfa', 'view-admin', 'view-app'];

function showView(id) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  const el = document.getElementById(id);
  if (el) el.classList.add('active');
  window.scrollTo(0, 0);
  if (id === 'view-auth') ambient.start(); else ambient.stop();
}

/* toasts */
const TOAST_ICONS = {
  success: '<path d="M20 6 L9 17 L4 12"/>',
  error: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5 V13 M12 16.2 V16.3"/>',
  notice: '<path d="M12 3 L22 20 H2 Z"/><path d="M12 10 V14 M12 17 V17.1"/>'
};
function showToast(message, type = 'success') {
  const wrap = document.getElementById('toast-wrap'); if (!wrap) return;
  const t = document.createElement('div');
  t.className = `toast toast-${type}`;
  t.innerHTML = `<span class="toast-ico"><svg viewBox="0 0 24 24" width="14" height="14" fill="none"
    stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${TOAST_ICONS[type] || TOAST_ICONS.success}</svg></span>
    <span class="toast-msg"></span>
    <button class="toast-x" type="button" aria-label="Dismiss"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M18 6 L6 18 M6 6 L18 18"/></svg></button>`;
  t.querySelector('.toast-msg').textContent = message;
  const dismiss = () => { t.classList.add('out'); t.addEventListener('animationend', () => t.remove(), { once: true }); };
  t.querySelector('.toast-x').onclick = e => { e.stopPropagation(); dismiss(); };
  t.onclick = dismiss;
  wrap.appendChild(t);
  setTimeout(() => { if (t.parentNode) dismiss(); }, 3400);
}

/* generic modal host */
function openModal(html, wide) {
  const host = document.getElementById('modal-host');
  host.innerHTML = `<div class="modal${wide ? ' wide' : ''}">${html}</div>`;
  host.hidden = false;
  host.onclick = e => { if (e.target === host) closeModal(); };
  return host.querySelector('.modal');
}
function closeModal() { const h = document.getElementById('modal-host'); h.hidden = true; h.innerHTML = ''; }

/* confirm dialog → Promise<null | true | {reason}> */
function confirmDialog({ title, message, confirmLabel = 'Confirm', danger = true, withReason = false, reasonLabel = 'Reason' }) {
  return new Promise(resolve => {
    const host = document.getElementById('confirm-host');
    host.innerHTML = `
      <div class="confirm">
        <div class="confirm-ico ${danger ? 'danger' : 'warn'}">
          <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 L22 20 H2 Z"/><path d="M12 10 V14 M12 17 V17.1"/></svg>
        </div>
        <h3></h3><p></p>
        ${withReason ? `<textarea id="confirm-reason" placeholder="${reasonLabel}…"></textarea>` : ''}
        <div class="confirm-foot">
          <button class="btn btn-ghost" data-cancel>Cancel</button>
          <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-ok>${confirmLabel}</button>
        </div>
      </div>`;
    host.querySelector('h3').textContent = title;
    host.querySelector('p').textContent = message;
    host.hidden = false;

    const done = val => { host.hidden = true; host.innerHTML = ''; host.onclick = null; resolve(val); };
    host.onclick = e => { if (e.target === host) done(null); };
    host.querySelector('[data-cancel]').onclick = () => done(null);
    host.querySelector('[data-ok]').onclick = () => {
      if (withReason) {
        const reason = host.querySelector('#confirm-reason').value.trim();
        done({ reason });
      } else done(true);
    };
  });
}

/* body-level kebab menu */
let activeKebabAnchor = null;

function positionKebab(anchorEl, menu) {
  if (!anchorEl || !menu) return;
  const r = anchorEl.getBoundingClientRect();
  if (r.bottom < 0 || r.top > window.innerHeight || r.right < 0 || r.left > window.innerWidth) {
    closeKebab(); return;
  }
  const mw = 190;
  const menuHeight = menu.offsetHeight || 180;
  const top = (r.bottom + 6 + menuHeight > window.innerHeight) ? Math.max(8, r.top - menuHeight - 6) : r.bottom + 6;
  const left = Math.max(8, Math.min(r.right - mw, window.innerWidth - mw - 8));
  menu.style.top = `${top}px`;
  menu.style.left = `${left}px`;
}

function openKebab(anchorEl, items) {
  const host = document.getElementById('kebab-host');
  activeKebabAnchor = anchorEl;
  const menu = document.createElement('div');
  menu.className = 'kebab-menu';
  menu.innerHTML = items.map(it => {
    if (it.sep) return '<div class="sep"></div>';
    if (it.note) return `<div class="you-note">${escapeHtml(it.note)}</div>`;
    return `<button class="${it.danger ? 'danger' : ''}" data-k="${it.key}">${escapeHtml(it.label)}</button>`;
  }).join('');
  host.innerHTML = ''; host.appendChild(menu); host.hidden = false;

  positionKebab(anchorEl, menu);

  host.onclick = e => {
    const btn = e.target.closest('button[data-k]');
    if (btn) { const key = btn.dataset.k; closeKebab(); const it = items.find(i => i.key === key); if (it && it.onClick) it.onClick(); }
    else if (e.target === host) closeKebab();
  };
}

function closeKebab() {
  const h = document.getElementById('kebab-host');
  if (h) { h.hidden = true; h.innerHTML = ''; h.onclick = null; }
  activeKebabAnchor = null;
}

/* small utilities */
function uid(p) { return `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`; }
function escapeHtml(v) { const d = document.createElement('div'); d.textContent = v == null ? '' : String(v); return d.innerHTML; }
function initials(name) {
  const p = String(name || '').trim().split(/\s+/); if (!p[0]) return '?';
  return (p[0][0] + (p.length > 1 ? p[p.length - 1][0] : '')).toUpperCase();
}
function fmtDate(iso) {
  if (!iso) return '—'; const d = new Date(iso); if (isNaN(d)) return '—';
  return d.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
}
function fmtDateTime(iso) {
  if (!iso) return '—'; const d = new Date(iso); if (isNaN(d)) return '—';
  return fmtDate(iso) + ', ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}
function pad2(n) { return String(n).padStart(2, '0'); }
function relTime(iso) {
  if (!iso) return 'never'; const s = Math.floor((Date.now() - new Date(iso)) / 1000);
  if (s < 60) return 'just now'; if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`; return `${Math.floor(s / 86400)}d ago`;
}
function countUp(el, target, dur = 600) {
  if (!el) return; const start = performance.now();
  (function frame(now) {
    const p = Math.min((now - start) / dur, 1); el.textContent = String(Math.round(target * (1 - Math.pow(1 - p, 3))));
    if (p < 1) requestAnimationFrame(frame); else el.textContent = String(target);
  })(performance.now());
}
function countUpMoney(el, target, dur = 600) {
  if (!el) return; const start = performance.now();
  (function frame(now) {
    const p = Math.min((now - start) / dur, 1); el.textContent = fmtMoney(target * (1 - Math.pow(1 - p, 3)));
    if (p < 1) requestAnimationFrame(frame); else el.textContent = fmtMoney(target);
  })(performance.now());
}

/* ═══ (4) AMBIENT ANIMATION CONTROLLERS ═════════════════════ */

const ambient = (function () {
  let timers = [], running = false, board = [];
  const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const seedBoard = () => ([
    { fl: 'PK-301', stand: 3, eibt: '14:00', buffer: 42, tobt: '14:42', risk: 'RED' },
    { fl: 'PK-305', stand: 1, eibt: '15:20', buffer: 34, tobt: '15:54', risk: 'AMBER' },
    { fl: 'ER-712', stand: 2, eibt: '16:45', buffer: 26, tobt: '17:11', risk: 'GREEN' },
    { fl: 'FZ-336', stand: 5, eibt: '19:25', buffer: 35, tobt: '20:00', risk: 'AMBER' },
    { fl: '9P-118', stand: 1, eibt: '18:10', buffer: 27, tobt: '18:37', risk: 'GREEN' },
    { fl: 'PA-204', stand: 4, eibt: '17:30', buffer: 44, tobt: '18:14', risk: 'RED' },
    { fl: 'QR-612', stand: 6, eibt: '20:05', buffer: 29, tobt: '20:34', risk: 'GREEN' },
    { fl: 'EK-623', stand: 2, eibt: '21:15', buffer: 38, tobt: '21:53', risk: 'AMBER' }
  ]);

  function rowHtml(r) {
    return `<div class="board-row" data-fl="${r.fl}">
      <span>${r.fl}</span><span>${r.stand}</span><span>${r.eibt}</span>
      <span>${r.buffer} min</span><span>${r.tobt}</span>
      <span class="risk risk-${r.risk}"><span class="rdot"></span>${r.risk}</span></div>`;
  }
  function paintBoard() {
    const host = document.getElementById('board-scroll'); if (!host) return;
    // doubled for a seamless infinite loop
    host.innerHTML = (board.concat(board)).map(rowHtml).join('');
  }
  function buildTicks() {
    const g = document.getElementById('ring-ticks'); if (!g || g.childNodes.length) return;
    let s = '';
    for (let i = 0; i < 60; i++) {
      const a = (i / 60) * 2 * Math.PI, r1 = i % 5 === 0 ? 76 : 80, r2 = 86;
      const x1 = 100 + r1 * Math.cos(a), y1 = 100 + r1 * Math.sin(a), x2 = 100 + r2 * Math.cos(a), y2 = 100 + r2 * Math.sin(a);
      s += `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"/>`;
    }
    g.innerHTML = s;
  }
  function buildStandDots() {
    const g = document.getElementById('stand-pings'); if (!g || g.childNodes.length) return;
    const pos = [[100, 14], [176, 72], [150, 178], [42, 150]];
    g.innerHTML = pos.map(([x, y]) => `<circle class="stand-ping" cx="${x}" cy="${y}" r="4"/>`).join('');
  }

  function tickClock() {
    const d = new Date(), hms = `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
    const bc = document.getElementById('brand-clock');
    if (bc) bc.textContent = `${d.toLocaleDateString(undefined, { day: '2-digit', month: 'short' })} · ${hms} · SHIFT A`;
  }
  let turnRemaining = 12 * 60 + 30;
  function tickTurn() {
    const el = document.getElementById('turn-count'); if (!el) return;
    turnRemaining = turnRemaining <= 0 ? 12 * 60 + 30 : turnRemaining - 1;
    el.textContent = `${pad2(Math.floor(turnRemaining / 60))}:${pad2(turnRemaining % 60)}`;
  }
  let heat = 47;
  function tickHeat() {
    heat = Math.max(34, Math.min(54, heat + (Math.random() * 2 - 1)));
    const v = document.getElementById('heat-val'), f = document.getElementById('heat-fill');
    if (v) v.textContent = `${Math.round(heat)}°C`;
    if (f) {
      f.style.width = `${Math.round(((heat - 30) / (56 - 30)) * 100)}%`;
      f.style.background = heat < 38 ? 'var(--green)' : heat <= 48 ? 'var(--amber)' : 'var(--red)';
    }
  }
  function pingStand() {
    const g = document.getElementById('stand-pings'); if (!g) return;
    const dots = g.querySelectorAll('.stand-ping'); if (!dots.length) return;
    const d = dots[Math.floor(Math.random() * dots.length)];
    const wave = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    wave.setAttribute('class', 'ping-wave'); wave.setAttribute('cx', d.getAttribute('cx')); wave.setAttribute('cy', d.getAttribute('cy'));
    g.appendChild(wave); setTimeout(() => wave.remove(), 1500);
  }
  function simulateRisk() {
    if (!board.length) return;
    const i = Math.floor(Math.random() * board.length), r = board[i];
    if (Math.random() < 0.5) {
      const order = ['GREEN', 'AMBER', 'RED'];
      r.risk = order[Math.min(order.length - 1, order.indexOf(r.risk) + (Math.random() < 0.5 ? 1 : -1) + 1) % order.length] || r.risk;
      r.risk = order[Math.max(0, Math.min(2, order.indexOf(r.risk)))];
    } else {
      r.buffer = Math.max(20, Math.min(55, r.buffer + (Math.random() < 0.5 ? -2 : 3)));
    }
    paintBoard();
    document.querySelectorAll(`.board-row[data-fl="${r.fl}"]`).forEach(row => {
      row.classList.add('flash'); setTimeout(() => row.classList.remove('flash'), 1100);
    });
  }

  return {
    init() { board = seedBoard(); buildTicks(); buildStandDots(); paintBoard(); tickClock(); tickTurn(); tickHeat(); },
    start() {
      if (running) return; running = true;
      tickClock();
      timers.push(setInterval(tickClock, 1000));
      if (REDUCED) return;                        // static ambience under reduced-motion
      timers.push(setInterval(tickTurn, 1000));
      timers.push(setInterval(tickHeat, 2500));
      timers.push(setInterval(pingStand, 2600));
      timers.push(setInterval(simulateRisk, 9000));
    },
    stop() { running = false; timers.forEach(clearInterval); timers = []; }
  };
})();

/* ═══ (5) VALIDATION HELPERS ════════════════════════════════ */

function isEmailFormat(v) { return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v); }
function emailProvider(v) { const m = /@([^.\s@]+)\./.exec(v); return m ? m[1].toLowerCase() : ''; }
function isCorporateEmail(v) { return isEmailFormat(v) && !FREE_PROVIDERS.has(emailProvider(v)); }

function passwordRules(pw) {
  return { len: pw.length >= 8, upper: /[A-Z]/.test(pw), number: /[0-9]/.test(pw), special: /[^A-Za-z0-9]/.test(pw) };
}
function passwordScore(pw) {
  const r = passwordRules(pw); const met = Object.values(r).filter(Boolean).length;
  const labels = ['Very weak', 'Weak', 'Medium', 'Almost there', 'Strong'];
  const colors = ['var(--red)', '#EA580C', '#CA8A04', '#CA8A04', 'var(--green)'];
  const idx = pw.length ? met : 0;
  return { met, rules: r, allMet: met === 4, label: pw.length ? labels[idx] : '—', color: colors[idx], pct: pw.length ? (idx / 4) * 100 : 0 };
}
function strengthText(pw) { const s = passwordScore(pw); return s.allMet ? 'Strong' : s.label; }

/* ═══ (6) AUTH FLOW ═════════════════════════════════════════ */

let authMode = 'login';

function renderAuth(prefillEmail) {
  authMode = 'login';
  const login = document.getElementById('login-form');
  const signup = document.getElementById('signup-form');
  const success = document.getElementById('signup-success');
  signup.hidden = true; success.hidden = true; login.hidden = false;
  login.reset(); signup.reset();
  clearFormMsg('login-msg'); clearFormMsg('signup-msg');
  document.querySelectorAll('#signup-form .field').forEach(f => f.classList.remove('ok', 'bad'));
  if (prefillEmail) document.getElementById('login-id').value = prefillEmail;
  cascade(login);
  showView('view-auth');
}

function cascade(card) {
  card.classList.remove('cascade'); void card.offsetWidth; card.classList.add('cascade');
}

function swapAuth(toSignup) {
  const login = document.getElementById('login-form');
  const signup = document.getElementById('signup-form');
  const outEl = toSignup ? login : signup;
  const inEl = toSignup ? signup : login;
  outEl.classList.add(toSignup ? 'slide-out-left' : 'slide-out-right');
  outEl.addEventListener('animationend', function h() {
    outEl.removeEventListener('animationend', h);
    outEl.classList.remove('slide-out-left', 'slide-out-right'); outEl.hidden = true;
    inEl.hidden = false; inEl.classList.add(toSignup ? 'slide-in-right' : 'slide-in-left');
    inEl.addEventListener('animationend', function h2() {
      inEl.removeEventListener('animationend', h2);
      inEl.classList.remove('slide-in-right', 'slide-in-left'); cascade(inEl);
    }, { once: true });
    authMode = toSignup ? 'signup' : 'login';
  }, { once: true });
}

function setFormMsg(id, text, type) {
  const el = document.getElementById(id);
  el.className = `form-msg ${type}`; el.textContent = text; el.hidden = false;
}
function clearFormMsg(id) { const el = document.getElementById(id); el.hidden = true; el.textContent = ''; }
function shakeField(fieldEl) { fieldEl.classList.remove('shake'); void fieldEl.offsetWidth; fieldEl.classList.add('shake'); }

/* ── login ── */
async function handleLogin(e) {
  e.preventDefault();
  const idEl = document.getElementById('login-id'), pwEl = document.getElementById('login-pw');
  const btn = document.getElementById('login-btn');
  const idVal = idEl.value.trim(), pw = pwEl.value;
  clearFormMsg('login-msg');

  if (!idVal) { shakeField(idEl.closest('.field')); setFormMsg('login-msg', 'Enter your email or username.', 'error'); return; }
  if (idVal !== 'admin' && !isEmailFormat(idVal)) { shakeField(idEl.closest('.field')); setFormMsg('login-msg', 'Enter a valid email address or username.', 'error'); return; }
  if (!pw) { shakeField(pwEl.closest('.field')); setFormMsg('login-msg', 'Enter your password.', 'error'); return; }

  setBtnLoading(btn, true, 'Signing in…');
  await wait(450);
  setBtnLoading(btn, false);

  const user = findUser(u => u.email === idVal || u.email.toLowerCase() === idVal.toLowerCase());
  if (!user || user.password !== pw) {
    shakeField(pwEl.closest('.field')); setFormMsg('login-msg', 'Invalid email/username or password.', 'error'); return;
  }
  if (user.status === 'PENDING') { setFormMsg('login-msg', 'Your account is pending administrator approval.', 'notice'); return; }
  if (user.status === 'REJECTED') {
    const reason = user.rejectionReason ? ` ${user.rejectionReason}` : '';
    setFormMsg('login-msg', `Your access request has been rejected.${reason}`, 'error'); return;
  }
  if (user.status === 'SUSPENDED') { setFormMsg('login-msg', 'Your account has been suspended. Contact your station admin.', 'error'); return; }

  // APPROVED → MFA
  pendingLogin = user;
  renderMFA();
}

/* ── signup live validation ── */
const signupTouched = {};

function validateSignupField(name, opts = {}) {
  const users = getUsers();
  const f = document.querySelector(`#signup-form .field[data-field="${name}"]`);
  if (!f) return false;
  const err = f.querySelector('.field-err');
  let ok = true, msg = '';

  if (name === 'name') {
    const v = document.getElementById('su-name').value.trim();
    if (v.length < 2) { ok = false; msg = 'Enter your full name (2+ characters).'; }
  } else if (name === 'email') {
    const v = document.getElementById('su-email').value.trim();
    if (!isEmailFormat(v)) { ok = false; msg = 'Enter a valid email address.'; }
    else if (!isCorporateEmail(v)) { ok = false; msg = 'Use your corporate email address.'; }
    else {
      const dup = users.find(u => u.email.toLowerCase() === v.toLowerCase());
      if (dup && dup.status !== 'REJECTED') { ok = false; msg = 'An account with this email already exists.'; }
    }
  } else if (name === 'org') {
    if (!document.getElementById('su-org').value.trim()) { ok = false; msg = 'Organisation is required.'; }
  } else if (name === 'role') {
    if (!document.getElementById('su-role').value) { ok = false; msg = 'Select a role.'; }
  } else if (name === 'pw') {
    ok = passwordScore(document.getElementById('su-pw').value).allMet;
    if (!ok) msg = 'Password does not meet all four rules.';
  } else if (name === 'confirm') {
    const p = document.getElementById('su-pw').value, c = document.getElementById('su-confirm').value;
    if (!c || c !== p) { ok = false; msg = 'Passwords do not match.'; }
  }

  const touched = signupTouched[name];
  if (ok) { f.classList.remove('bad'); if (touched) f.classList.add('ok'); if (err) err.textContent = ''; }
  else {
    f.classList.remove('ok');
    if (touched) { f.classList.add('bad'); if (err) err.textContent = msg; if (opts.shake) shakeField(f); }
  }
  return ok;
}

function updateStrengthUI() {
  const pw = document.getElementById('su-pw').value;
  const s = passwordScore(pw);
  const fill = document.querySelector('#su-strength .strength-fill');
  const label = document.querySelector('#su-strength .strength-label');
  fill.style.width = `${s.pct}%`; fill.style.background = s.color;
  label.textContent = s.label; label.style.color = pw.length ? s.color : 'var(--text-mute)';
  document.querySelectorAll('#su-checklist li').forEach(li => li.classList.toggle('met', s.rules[li.dataset.rule]));
}

async function handleSignup(e) {
  e.preventDefault();
  ['name', 'email', 'org', 'role', 'pw', 'confirm'].forEach(n => signupTouched[n] = true);
  const results = ['name', 'email', 'org', 'role', 'pw', 'confirm'].map(n => validateSignupField(n, { shake: true }));
  if (results.includes(false)) { setFormMsg('signup-msg', 'Please correct the highlighted fields.', 'error'); return; }
  clearFormMsg('signup-msg');

  const btn = document.getElementById('signup-btn');
  setBtnLoading(btn, true, 'Submitting…');
  await wait(500);
  setBtnLoading(btn, false);

  const email = document.getElementById('su-email').value.trim();
  const payload = {
    name: document.getElementById('su-name').value.trim(),
    email, password: document.getElementById('su-pw').value,
    organisation: document.getElementById('su-org').value.trim(),
    role: document.getElementById('su-role').value,
    status: 'PENDING', permissions: ['flightboard'],
    registeredAt: new Date().toISOString(), decidedAt: null, decidedBy: null,
    rejectionReason: null, sessionActive: false, lastActiveAt: null
  };

  const users = getUsers();
  const existingRejected = users.find(u => u.email.toLowerCase() === email.toLowerCase() && u.status === 'REJECTED');
  if (existingRejected) { Object.assign(existingRejected, payload, { id: existingRejected.id }); }
  else { users.push(Object.assign({ id: uid('u') }, payload)); }
  saveUsers(users);
  logActivity({ action: 'submitted access request', target: email, category: 'auth', severity: 'info' });

  // success panel + 3s ring, then back to login prefilled
  showSignupSuccess(email);
  showToast('Registration submitted — awaiting approval', 'success');
}

function showSignupSuccess(email) {
  const signup = document.getElementById('signup-form'), success = document.getElementById('signup-success');
  signup.hidden = true; success.hidden = false;
  const ring = document.getElementById('sr-fill'); ring.classList.remove('run'); void ring.getBoundingClientRect(); ring.classList.add('run');
  setTimeout(() => { success.hidden = true; renderAuth(email); }, 3000);
}

/* ── MFA ── */
let pendingLogin = null;
let mfaVerifying = false;   // guards against the auto-submit firing twice

function renderMFA() {
  mfaVerifying = false;
  const boxes = [...document.querySelectorAll('.mfa-box')];
  boxes.forEach((b, i) => {
    b.value = ''; b.classList.remove('shown', 'pop', 'fading'); void b.offsetWidth;
    setTimeout(() => b.classList.add('shown'), i * 65);
  });
  document.getElementById('mfa-msg').hidden = true;
  document.getElementById('mfa-success').hidden = true;
  showView('view-mfa');
  setTimeout(() => boxes[0].focus(), 360);
}

function wireMFA() {
  const boxes = [...document.querySelectorAll('.mfa-box')];
  boxes.forEach((box, i) => {
    box.addEventListener('input', () => {
      box.value = box.value.replace(/\D/g, '').slice(0, 1);
      if (box.value) {
        box.classList.add('pop'); setTimeout(() => box.classList.remove('pop'), 120);
        if (i < 4) boxes[i + 1].focus();
      }
      if (boxes.every(b => b.value)) submitMFA();
    });
    box.addEventListener('keydown', e => {
      if (e.key === 'Backspace' && !box.value && i > 0) boxes[i - 1].focus();
    });
    box.addEventListener('paste', e => {
      e.preventDefault();
      const digits = (e.clipboardData.getData('text').match(/\d/g) || []).slice(0, 5);
      digits.forEach((d, k) => { if (boxes[k]) { boxes[k].value = d; boxes[k].classList.add('shown'); } });
      if (digits.length) boxes[Math.min(digits.length, 5) - 1].focus();
      if (digits.length === 5) submitMFA();
    });
  });
  document.getElementById('mfa-back').addEventListener('click', () => { pendingLogin = null; renderAuth(); });
}

async function submitMFA() {
  if (mfaVerifying) return;                       // already handling this code
  const boxes = [...document.querySelectorAll('.mfa-box')];
  const code = boxes.map(b => b.value).join('');
  const group = document.getElementById('mfa-inputs');
  const msg = document.getElementById('mfa-msg');

  if (code !== MFA_CODE) {
    msg.className = 'form-msg error mfa-msg'; msg.textContent = 'Incorrect code. Please try again.'; msg.hidden = false;
    group.classList.add('shake'); setTimeout(() => group.classList.remove('shake'), 350);
    boxes.forEach(b => b.classList.add('fading'));
    setTimeout(() => { boxes.forEach(b => { b.value = ''; b.classList.remove('fading'); }); boxes[0].focus(); }, 450);
    return;
  }

  const user = pendingLogin;
  if (!user) { renderAuth(); return; }             // no pending login — bail safely
  mfaVerifying = true;
  pendingLogin = null;

  msg.hidden = true;
  document.getElementById('mfa-success').hidden = false;

  setSession(user);
  updateUser(user.id, { sessionActive: true, lastActiveAt: new Date().toISOString() });
  logActivity({ action: 'signed in', target: user.email, category: 'auth', severity: 'success' });

  await wait(1050);
  sessionMgr.start();
  if (user.role === 'SUPER_ADMIN') renderAdmin();
  else renderApp();
  mfaVerifying = false;
}

function setBtnLoading(btn, loading, text) {
  const sp = btn.querySelector('.spinner'), lbl = btn.querySelector('.btn-text');
  if (loading) {
    if (lbl) { btn.dataset.idle = lbl.textContent; lbl.textContent = text || lbl.textContent; }
    if (sp) sp.hidden = false; btn.disabled = true;
  }
  else { if (lbl && btn.dataset.idle) lbl.textContent = btn.dataset.idle; if (sp) sp.hidden = true; btn.disabled = false; }
}
const wait = ms => new Promise(r => setTimeout(r, ms));

/* ═══ (7) SESSION MANAGER ═══════════════════════════════════ */

const sessionMgr = (function () {
  let timer = null, activeUserId = null;

  function fmt(ms) { const s = Math.max(0, Math.floor(ms / 1000)); return `${pad2(Math.floor(s / 60))}:${pad2(s % 60)}`; }

  function paint() {
    // Read the raw record, not getSession() — the getter auto-clears an expired
    // session and returns null, which would hide the expiry from us.
    const s = readJSON(SESSION_KEY, null);
    if (!s || !s.expiresAt) { if (timer) expire(); return; }
    const remaining = s.expiresAt - Date.now();
    if (remaining <= 0) { expire(); return; }
    ['admin', 'app'].forEach(v => {
      const pill = document.getElementById(`${v}-session`); if (!pill) return;
      pill.querySelector('.sp-time').textContent = fmt(remaining);
      pill.classList.toggle('warn', remaining <= 120000 && remaining > 60000);
      pill.classList.toggle('danger', remaining <= 60000);
    });
    const now = new Date();
    ['admin', 'app'].forEach(v => {
      const c = document.getElementById(`${v}-clock`);
      if (c) c.textContent = `${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`;
    });
  }

  function topUp() {
    const s = readJSON(SESSION_KEY, null); if (!s) return;
    s.expiresAt = Date.now() + SESSION_MS;
    localStorage.setItem(SESSION_KEY, JSON.stringify(s));
    paint();   // reflect the reset immediately, don't wait for the next tick
  }

  function expire() {
    stop();
    if (activeUserId) updateUser(activeUserId, { sessionActive: false, lastActiveAt: new Date().toISOString() });
    activeUserId = null;
    clearSession();
    renderAuth();
    showToast('Session expired — please sign in again', 'notice');
  }

  /* Every click/keypress used to call topUp() unconditionally, which reset
     the visible countdown straight back to 15:00 on literally any click —
     it looked frozen/broken rather than a real countdown, since normal use
     never lets a minute pass without a click somewhere. Only extending once
     the session has genuinely aged (more than a minute since the last
     extension) lets the countdown actually tick down during active use,
     while still renewing well before it would ever expire on someone who's
     truly still working. */
  function onActivity() {
    if (!timer) return;
    const s = readJSON(SESSION_KEY, null); if (!s || !s.expiresAt) return;
    const remaining = s.expiresAt - Date.now();
    if (remaining < SESSION_MS - 60000) topUp();
  }

  function start() {
    stop();
    const s = readJSON(SESSION_KEY, null); activeUserId = s ? s.userId : null;
    timer = setInterval(paint, 1000); paint();
    document.addEventListener('click', onActivity, true);
    document.addEventListener('keydown', onActivity, true);
  }
  function stop() {
    if (timer) clearInterval(timer); timer = null;
    document.removeEventListener('click', onActivity, true);
    document.removeEventListener('keydown', onActivity, true);
  }

  return { start, stop, expire };
})();

function handleSignOut() {
  const s = getSession();
  if (s) {
    updateUser(s.userId, { sessionActive: false, lastActiveAt: new Date().toISOString() });
    logActivity({ action: 'signed out', target: s.email, category: 'auth', severity: 'info' });
  }
  sessionMgr.stop(); clearSession(); renderAuth(); showToast('Signed out', 'notice');
}

/* ═══ (8) ADMIN DASHBOARD ═══════════════════════════════════ */

let adminFilters = { q: '', status: 'ALL', role: 'ALL' };
let selectedIds = new Set();
let adminLoaded = false;

async function renderAdmin() {
  const s = getSession();
  document.getElementById('admin-who').textContent = s ? s.name : '';
  showView('view-admin');

  const skel = document.getElementById('admin-skeleton'), content = document.getElementById('admin-content');
  if (!adminLoaded) { skel.hidden = false; content.hidden = true; await wait(LOAD_DELAY); adminLoaded = true; }
  skel.hidden = true; content.hidden = false;

  renderStats({ animate: true });
  renderUsers();
  renderActivity();
}

function renderStats({ animate = false } = {}) {
  const c = { PENDING: 0, APPROVED: 0, REJECTED: 0, SUSPENDED: 0 };
  getUsers().forEach(u => { if (c[u.status] !== undefined) c[u.status]++; });
  const map = { 'c-pending': c.PENDING, 'c-approved': c.APPROVED, 'c-rejected': c.REJECTED, 'c-suspended': c.SUSPENDED };
  Object.entries(map).forEach(([id, v]) => {
    const el = document.getElementById(id);
    if (animate) countUp(el, v); else el.textContent = String(v);
  });

  const banner = document.getElementById('pending-banner');
  if (c.PENDING > 0) {
    banner.hidden = false;
    banner.querySelector('.pb-text').textContent = `${c.PENDING} access request${c.PENDING > 1 ? 's' : ''} awaiting review`;
  }
  else banner.hidden = true;

  document.getElementById('user-total').textContent = `${getUsers().length} registered`;
}

function accessStripHtml(user) {
  return `<span class="access-strip">` + ALL_MODULES.map(m => {
    const on = user.permissions && user.permissions.includes(m);
    return `<span class="am ${on ? 'on' : ''}" title="${MODULES[m].label}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${ICONS[m]}</svg></span>`;
  }).join('') + `</span>`;
}
function statusBadge(s) {
  const cls = { APPROVED: 'b-approved', PENDING: 'b-pending', REJECTED: 'b-rejected', SUSPENDED: 'b-suspended' }[s] || 'b-suspended';
  return `<span class="badge ${cls}"><span class="dot"></span>${STATUSES[s] || s}</span>`;
}

function sessionCellHtml(user) {
  if (user.sessionActive) return `<span class="session-cell"><span class="live"><span class="dot"></span>Active</span></span>`;
  return `<span class="session-cell"><span class="idle">Last active ${relTime(user.lastActiveAt)}</span></span>`;
}

function renderUsers() {
  const tbody = document.getElementById('users-body');
  const emptyEl = document.getElementById('users-empty');
  const session = getSession();
  const q = adminFilters.q.trim().toLowerCase();

  let rows = getUsers().filter(u => {
    if (adminFilters.status !== 'ALL' && u.status !== adminFilters.status) return false;
    if (adminFilters.role !== 'ALL' && u.role !== adminFilters.role) return false;
    if (q && !(`${u.name} ${u.email}`.toLowerCase().includes(q))) return false;
    return true;
  }).sort((a, b) => {
    const order = { PENDING: 0, APPROVED: 1, SUSPENDED: 2, REJECTED: 3 };
    if (order[a.status] !== order[b.status]) return order[a.status] - order[b.status];
    return new Date(b.registeredAt) - new Date(a.registeredAt);
  });

  if (!rows.length) {
    tbody.innerHTML = ''; emptyEl.hidden = false;
    emptyEl.innerHTML = `<div class="empty"><div class="empty-ico">
      <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="M20 20 L16.5 16.5"/></svg></div>
      <h4>No matching users</h4><p>Try a different search term or filter.</p></div>`;
    return;
  }
  emptyEl.hidden = true;

  tbody.innerHTML = rows.map(u => {
    const isSelf = session && u.id === session.userId;
    return `<tr data-id="${u.id}" class="${selectedIds.has(u.id) ? 'selected' : ''}">
      <td class="cell-check"><input type="checkbox" data-check="${u.id}" ${selectedIds.has(u.id) ? 'checked' : ''} aria-label="Select ${escapeHtml(u.name)}" /></td>
      <td class="td-name">${escapeHtml(u.name)}${isSelf ? ' <span class="you-tag">You</span>' : ''}</td>
      <td class="td-email">${escapeHtml(u.email)}</td>
      <td><span class="role-badge">${escapeHtml(ROLES[u.role] || u.role)}</span></td>
      <td>${statusBadge(u.status)}</td>
      <td>${accessStripHtml(u)}</td>
      <td>${sessionCellHtml(u)}</td>
      <td class="mono" style="font-size:12px;color:var(--text-mute)">${fmtDate(u.registeredAt)}</td>
      <td class="th-act"><button class="kebab-btn" data-kebab="${u.id}" aria-label="Actions">
        <svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor"><circle cx="12" cy="5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="19" r="1.6"/></svg></button></td>
    </tr>`;
  }).join('');

  document.getElementById('check-all').checked = rows.length > 0 && rows.every(u => selectedIds.has(u.id));
  updateBulkBar();
}

function updateBulkBar() {
  const bar = document.getElementById('bulkbar');
  if (selectedIds.size) { bar.hidden = false; document.getElementById('bulk-n').textContent = String(selectedIds.size); }
  else bar.hidden = true;
}

function flashRow(id) { const r = document.querySelector(`tr[data-id="${id}"]`); if (r) { r.classList.add('flash'); setTimeout(() => r.classList.remove('flash'), 1000); } }

/* ── row action menu ── */
function openRowMenu(id, anchor) {
  const user = findUser(u => u.id === id); if (!user) return;
  const session = getSession();
  const isSelf = session && id === session.userId;
  const isSeed = id === 'seed-admin';
  const items = [];

  items.push({ key: 'view', label: 'View details', onClick: () => openDrawer(id) });
  items.push({ key: 'perms', label: 'Access permissions', onClick: () => openPermissions(id) });
  items.push({ key: 'edit', label: 'Edit user', onClick: () => openEditUser(id) });
  items.push({ key: 'reset', label: 'Reset password', onClick: () => openResetPassword(id) });

  if (isSelf || isSeed) { items.push({ sep: true }); items.push({ note: 'This is you — self-management is disabled' }); openKebab(anchor, items); return; }

  items.push({ sep: true });
  if (user.status !== 'APPROVED') items.push({ key: 'approve', label: 'Approve', onClick: () => approveUser(id) });
  if (user.status !== 'REJECTED') items.push({ key: 'reject', label: 'Reject', onClick: () => rejectUser(id) });
  if (user.status === 'APPROVED') items.push({ key: 'suspend', label: 'Suspend', onClick: () => suspendUser(id) });
  if (user.status === 'SUSPENDED') items.push({ key: 'reactivate', label: 'Reactivate', onClick: () => reactivateUser(id) });
  if (user.sessionActive) items.push({ key: 'revoke', label: 'Revoke session', onClick: () => revokeSession(id) });
  items.push({ sep: true });
  items.push({ key: 'delete', label: 'Delete user', danger: true, onClick: () => deleteUser(id) });

  openKebab(anchor, items);
}

/* ── individual actions ── */
function afterMutation() { renderStats(); renderUsers(); renderActivity(); }

function approveUser(id) {
  const s = getSession(); const u = updateUser(id, { status: 'APPROVED', decidedAt: new Date().toISOString(), decidedBy: s ? s.name : 'Admin', rejectionReason: null });
  logActivity({ action: 'approved user', target: u.email, category: 'user', severity: 'success' });
  afterMutation(); flashRow(id); showToast(`${u.name} approved`, 'success');
}
async function rejectUser(id) {
  const u = findUser(x => x.id === id);
  const res = await confirmDialog({
    title: 'Reject access request', message: `Reject ${u.name}? Provide a reason — the applicant will see it at sign-in.`,
    confirmLabel: 'Reject', withReason: true, reasonLabel: 'Rejection reason'
  });
  if (!res) return;
  const s = getSession();
  updateUser(id, { status: 'REJECTED', decidedAt: new Date().toISOString(), decidedBy: s ? s.name : 'Admin', rejectionReason: res.reason || null, sessionActive: false });
  logActivity({ action: 'rejected user', target: u.email, category: 'user', severity: 'warn' });
  afterMutation(); flashRow(id); showToast(`${u.name} rejected`, 'notice');
}
async function suspendUser(id) {
  const u = findUser(x => x.id === id);
  const ok = await confirmDialog({ title: 'Suspend user', message: `Suspend ${u.name}? They will be unable to sign in until reactivated.`, confirmLabel: 'Suspend' });
  if (!ok) return;
  const s = getSession();
  updateUser(id, { status: 'SUSPENDED', decidedAt: new Date().toISOString(), decidedBy: s ? s.name : 'Admin', sessionActive: false });
  logActivity({ action: 'suspended user', target: u.email, category: 'user', severity: 'warn' });
  afterMutation(); flashRow(id); showToast(`${u.name} suspended`, 'notice');
}
function reactivateUser(id) {
  const s = getSession(); const u = updateUser(id, { status: 'APPROVED', decidedAt: new Date().toISOString(), decidedBy: s ? s.name : 'Admin' });
  logActivity({ action: 'reactivated user', target: u.email, category: 'user', severity: 'success' });
  afterMutation(); flashRow(id); showToast(`${u.name} reactivated`, 'success');
}
async function deleteUser(id) {
  const u = findUser(x => x.id === id);
  const ok = await confirmDialog({ title: 'Delete user', message: `Permanently delete ${u.name}? This cannot be undone.`, confirmLabel: 'Delete' });
  if (!ok) return;
  const row = document.querySelector(`tr[data-id="${id}"]`);
  const finish = () => {
    saveUsers(getUsers().filter(x => x.id !== id)); selectedIds.delete(id);
    logActivity({ action: 'deleted user', target: u.email, category: 'user', severity: 'danger' }); afterMutation(); showToast(`${u.name} deleted`, 'error');
  };
  if (row) { row.classList.add('removing'); setTimeout(finish, 350); } else finish();
}
function revokeSession(id) {
  const u = updateUser(id, { sessionActive: false, lastActiveAt: new Date().toISOString() });
  logActivity({ action: 'revoked session', target: u.email, category: 'security', severity: 'warn' });
  renderUsers(); showToast(`Session revoked for ${u.name}`, 'notice');
}

/* ── bulk actions ── */
async function bulkAction(kind) {
  const ids = [...selectedIds]; if (!ids.length) return;
  const session = getSession();
  const actable = ids.filter(id => id !== 'seed-admin' && !(session && id === session.userId));

  if (kind === 'clear') { selectedIds.clear(); renderUsers(); return; }
  if (kind === 'approve') {
    actable.forEach(id => updateUser(id, { status: 'APPROVED', decidedAt: new Date().toISOString(), decidedBy: session ? session.name : 'Admin', rejectionReason: null }));
    logActivity({ action: `bulk-approved ${actable.length} user(s)`, target: '—', category: 'user', severity: 'success' });
    selectedIds.clear(); afterMutation(); showToast(`${actable.length} user(s) approved`, 'success'); return;
  }
  if (kind === 'reject') {
    const res = await confirmDialog({ title: `Reject ${actable.length} user(s)`, message: 'Provide a reason applied to all selected requests.', confirmLabel: 'Reject all', withReason: true, reasonLabel: 'Rejection reason' });
    if (!res) return;
    actable.forEach(id => updateUser(id, { status: 'REJECTED', decidedAt: new Date().toISOString(), decidedBy: session ? session.name : 'Admin', rejectionReason: res.reason || null, sessionActive: false }));
    logActivity({ action: `bulk-rejected ${actable.length} user(s)`, target: '—', category: 'user', severity: 'warn' });
    selectedIds.clear(); afterMutation(); showToast(`${actable.length} user(s) rejected`, 'notice'); return;
  }
  if (kind === 'delete') {
    const ok = await confirmDialog({ title: `Delete ${actable.length} user(s)`, message: 'This permanently removes the selected users and cannot be undone.', confirmLabel: 'Delete all' });
    if (!ok) return;
    const del = new Set(actable);
    saveUsers(getUsers().filter(u => !del.has(u.id)));
    logActivity({ action: `bulk-deleted ${actable.length} user(s)`, target: '—', category: 'user', severity: 'danger' });
    selectedIds.clear(); afterMutation(); showToast(`${actable.length} user(s) deleted`, 'error'); return;
  }
}

/* ── Add / Edit / Reset password modals ── */
function pwFieldBlock(idPrefix) {
  return `<div class="field" data-field="${idPrefix}-pw">
      <label for="${idPrefix}-pw">Password</label>
      <div class="input-wrap"><input type="password" id="${idPrefix}-pw" placeholder="••••••••" autocomplete="new-password" />
        <button type="button" class="eye" data-eye="${idPrefix}-pw" tabindex="-1" aria-label="Show"></button></div>
      <div class="strength" id="${idPrefix}-strength"><div class="strength-bar"><span class="strength-fill"></span></div><span class="strength-label">—</span></div>
      <ul class="pw-checklist" id="${idPrefix}-checklist">
        <li data-rule="len"><span class="tick"></span>8+ characters</li><li data-rule="upper"><span class="tick"></span>Uppercase</li>
        <li data-rule="number"><span class="tick"></span>Number</li><li data-rule="special"><span class="tick"></span>Special character</li></ul></div>`;
}
function wirePwMeter(idPrefix) {
  const input = document.getElementById(`${idPrefix}-pw`); if (!input) return;
  input.addEventListener('input', () => {
    const s = passwordScore(input.value);
    const fill = document.querySelector(`#${idPrefix}-strength .strength-fill`);
    const label = document.querySelector(`#${idPrefix}-strength .strength-label`);
    fill.style.width = `${s.pct}%`; fill.style.background = s.color;
    label.textContent = s.label; label.style.color = input.value.length ? s.color : 'var(--text-mute)';
    document.querySelectorAll(`#${idPrefix}-checklist li`).forEach(li => li.classList.toggle('met', s.rules[li.dataset.rule]));
  });
}
function genPassword() {
  const U = 'ABCDEFGHJKLMNPQRSTUVWXYZ', L = 'abcdefghijkmnpqrstuvwxyz', N = '23456789', S = '!@#$%&*?';
  const pick = set => set[Math.floor(Math.random() * set.length)];
  let pw = pick(U) + pick(L) + pick(N) + pick(S);
  const all = U + L + N + S; for (let i = 0; i < 8; i++) pw += pick(all);
  return pw.split('').sort(() => Math.random() - 0.5).join('');
}
function roleOptions(sel) {
  return Object.entries(ROLES).filter(([k]) => k !== 'SUPER_ADMIN')
    .map(([k, v]) => `<option value="${k}" ${sel === k ? 'selected' : ''}>${v}</option>`).join('');
}

function openAddUser() {
  const modal = openModal(`
    <div class="modal-head"><div><h3>Add User</h3><p>Admin-created users are approved immediately.</p></div>
      <button class="modal-x" data-x aria-label="Close"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6 L18 18 M18 6 L6 18"/></svg></button></div>
    <div class="field" data-field="au-name"><label for="au-name">Full name</label><div class="input-wrap"><input type="text" id="au-name" placeholder="Jane Doe" /></div><p class="field-err"></p></div>
    <div class="field" data-field="au-email"><label for="au-email">Corporate email</label><div class="input-wrap"><input type="text" id="au-email" placeholder="jane@menzies-ras.pk" /></div><p class="field-err"></p></div>
    <div class="grid-2">
      <div class="field"><label for="au-org">Organisation</label><div class="input-wrap"><input type="text" id="au-org" placeholder="Menzies-RAS" /></div></div>
      <div class="field"><label for="au-role">Role</label><div class="input-wrap"><select id="au-role"><option value="" selected disabled>Select…</option>${roleOptions()}</select></div></div>
    </div>
    <div class="toggle-row"><label for="au-gen" style="font-size:13px;font-weight:500">Auto-generate secure password</label>
      <label class="switch"><input type="checkbox" id="au-gen" /><span class="slider"></span></label></div>
    <div id="au-pw-manual">${pwFieldBlock('au')}</div>
    <div id="au-pw-gen" hidden><div class="gen-pw"><code id="au-genpw"></code><button type="button" class="btn btn-ghost btn-xs" id="au-regen">Regenerate</button></div><p class="modal-note">Shown once — copy and share it with the user manually.</p></div>
    <div class="modal-foot"><button class="btn btn-ghost" data-x>Cancel</button><button class="btn btn-primary" id="au-save">Create user</button></div>`);

  wirePwMeter('au');
  modal.querySelectorAll('[data-x]').forEach(b => b.onclick = closeModal);
  modal.querySelectorAll('.eye').forEach(wireEyeEl);

  const genToggle = modal.querySelector('#au-gen');
  const setGen = () => {
    const on = genToggle.checked;
    modal.querySelector('#au-pw-manual').hidden = on; modal.querySelector('#au-pw-gen').hidden = !on;
    if (on) modal.querySelector('#au-genpw').textContent = genPassword();
  };
  genToggle.onchange = setGen;
  modal.querySelector('#au-regen').onclick = () => modal.querySelector('#au-genpw').textContent = genPassword();

  modal.querySelector('#au-save').onclick = () => {
    const name = modal.querySelector('#au-name').value.trim();
    const email = modal.querySelector('#au-email').value.trim();
    const org = modal.querySelector('#au-org').value.trim();
    const role = modal.querySelector('#au-role').value;
    const gen = genToggle.checked;
    const pw = gen ? modal.querySelector('#au-genpw').textContent : modal.querySelector('#au-pw').value;

    let bad = false;
    const fail = (sel, msg) => { const f = modal.querySelector(sel); f.classList.add('bad'); f.querySelector('.field-err').textContent = msg; bad = true; };
    modal.querySelectorAll('.field').forEach(f => f.classList.remove('bad'));
    if (name.length < 2) fail('[data-field="au-name"]', 'Enter a full name.');
    if (!isEmailFormat(email)) fail('[data-field="au-email"]', 'Enter a valid email.');
    else if (!isCorporateEmail(email)) fail('[data-field="au-email"]', 'Use a corporate email address.');
    else if (findUser(u => u.email.toLowerCase() === email.toLowerCase())) fail('[data-field="au-email"]', 'Email already exists.');
    if (!org) { showToast('Organisation is required', 'error'); bad = true; }
    if (!role) { showToast('Select a role', 'error'); bad = true; }
    if (!gen && !passwordScore(pw).allMet) { fail('[data-field="au-pw"]', 'Password must meet all four rules.'); }
    if (bad) return;

    const s = getSession();
    const users = getUsers();
    users.push({
      id: uid('u'), name, email, password: pw, organisation: org, role, status: 'APPROVED',
      permissions: ['flightboard'], registeredAt: new Date().toISOString(), decidedAt: new Date().toISOString(),
      decidedBy: s ? s.name : 'Admin', rejectionReason: null, sessionActive: false, lastActiveAt: null
    });
    saveUsers(users);
    logActivity({ action: 'created user', target: email, category: 'user', severity: 'success' });
    closeModal(); afterMutation(); showToast(`${name} created`, 'success');
  };
}

function openEditUser(id) {
  const u = findUser(x => x.id === id); if (!u) return;
  const modal = openModal(`
    <div class="modal-head"><div><h3>Edit User</h3><p>${escapeHtml(u.name)}</p></div>
      <button class="modal-x" data-x aria-label="Close"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6 L18 18 M18 6 L6 18"/></svg></button></div>
    <div class="field" data-field="eu-name"><label for="eu-name">Full name</label><div class="input-wrap"><input type="text" id="eu-name" value="${escapeHtml(u.name)}" /></div><p class="field-err"></p></div>
    <div class="field" data-field="eu-email"><label for="eu-email">Corporate email</label><div class="input-wrap"><input type="text" id="eu-email" value="${escapeHtml(u.email)}" /></div><p class="field-err"></p></div>
    <div class="grid-2">
      <div class="field"><label for="eu-org">Organisation</label><div class="input-wrap"><input type="text" id="eu-org" value="${escapeHtml(u.organisation)}" /></div></div>
      <div class="field"><label for="eu-role">Role</label><div class="input-wrap"><select id="eu-role" ${u.id === 'seed-admin' ? 'disabled' : ''}>${u.role === 'SUPER_ADMIN' ? '<option value="SUPER_ADMIN" selected>System Administrator</option>' : roleOptions(u.role)}</select></div></div>
    </div>
    <div class="modal-foot"><button class="btn btn-ghost" data-x>Cancel</button><button class="btn btn-primary" id="eu-save">Save changes</button></div>`);
  modal.querySelectorAll('[data-x]').forEach(b => b.onclick = closeModal);
  modal.querySelector('#eu-save').onclick = () => {
    const name = modal.querySelector('#eu-name').value.trim();
    const email = modal.querySelector('#eu-email').value.trim();
    const org = modal.querySelector('#eu-org').value.trim();
    const role = u.id === 'seed-admin' ? u.role : modal.querySelector('#eu-role').value;
    modal.querySelectorAll('.field').forEach(f => f.classList.remove('bad'));
    let bad = false;
    const fail = (sel, msg) => { const f = modal.querySelector(sel); f.classList.add('bad'); f.querySelector('.field-err').textContent = msg; bad = true; };
    if (name.length < 2) fail('[data-field="eu-name"]', 'Enter a full name.');
    if (!isEmailFormat(email)) fail('[data-field="eu-email"]', 'Enter a valid email.');
    else if (!isCorporateEmail(email) && email !== 'admin') fail('[data-field="eu-email"]', 'Use a corporate email address.');
    else { const dup = findUser(x => x.email.toLowerCase() === email.toLowerCase() && x.id !== id); if (dup) fail('[data-field="eu-email"]', 'Email already exists.'); }
    if (bad) return;
    updateUser(id, { name, email, organisation: org, role });
    logActivity({ action: 'edited user', target: email, category: 'user', severity: 'info' });
    closeModal(); afterMutation(); showToast(`${name} updated`, 'success');
  };
}

function openResetPassword(id) {
  const u = findUser(x => x.id === id); if (!u) return;
  const modal = openModal(`
    <div class="modal-head"><div><h3>Reset Password</h3><p>${escapeHtml(u.name)}</p></div>
      <button class="modal-x" data-x aria-label="Close"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6 L18 18 M18 6 L6 18"/></svg></button></div>
    <div class="toggle-row"><label for="rp-gen" style="font-size:13px;font-weight:500">Auto-generate secure password</label>
      <label class="switch"><input type="checkbox" id="rp-gen" /><span class="slider"></span></label></div>
    <div id="rp-manual">${pwFieldBlock('rp')}</div>
    <div id="rp-gen-box" hidden><div class="gen-pw"><code id="rp-genpw"></code><button type="button" class="btn btn-ghost btn-xs" id="rp-regen">Regenerate</button></div><p class="modal-note">Shown once — copy and share it with the user manually.</p></div>
    <div class="modal-foot"><button class="btn btn-ghost" data-x>Cancel</button><button class="btn btn-primary" id="rp-save">Reset password</button></div>`);
  wirePwMeter('rp');
  modal.querySelectorAll('[data-x]').forEach(b => b.onclick = closeModal);
  modal.querySelectorAll('.eye').forEach(wireEyeEl);
  const gen = modal.querySelector('#rp-gen');
  gen.onchange = () => {
    const on = gen.checked; modal.querySelector('#rp-manual').hidden = on; modal.querySelector('#rp-gen-box').hidden = !on;
    if (on) modal.querySelector('#rp-genpw').textContent = genPassword();
  };
  modal.querySelector('#rp-regen').onclick = () => modal.querySelector('#rp-genpw').textContent = genPassword();
  modal.querySelector('#rp-save').onclick = () => {
    const on = gen.checked; const pw = on ? modal.querySelector('#rp-genpw').textContent : modal.querySelector('#rp-pw').value;
    if (!on && !passwordScore(pw).allMet) { const f = modal.querySelector('[data-field="rp-pw"]'); f.classList.add('bad'); f.querySelector('.field-err').textContent = 'Password must meet all four rules.'; return; }
    updateUser(id, { password: pw });
    logActivity({ action: 'reset password', target: u.email, category: 'security', severity: 'warn' });
    closeModal(); showToast(`Password reset for ${u.name}`, 'success');
  };
}

/* ── access permissions panel ── */
function openPermissions(id) {
  const u = findUser(x => x.id === id); if (!u) return;
  let perms = new Set(u.permissions && u.permissions.length ? u.permissions : ['flightboard']);
  perms.add('flightboard');

  const itemHtml = m => `<div class="perm-item ${perms.has(m) ? 'on' : ''} ${MODULES[m].locked ? 'locked' : ''}" data-perm="${m}">
      <span class="perm-check"></span>
      <span class="perm-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${ICONS[m]}</svg></span>
      <span class="perm-label">${MODULES[m].label}</span>${MODULES[m].locked ? '<span class="perm-lock">LOCKED</span>' : ''}</div>`;

  const modal = openModal(`
    <div class="modal-head"><div><h3>Access permissions</h3><p>${escapeHtml(u.name)} — choose the ORBIS modules this user can open.</p></div>
      <button class="modal-x" data-x aria-label="Close"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6 L18 18 M18 6 L6 18"/></svg></button></div>
    <div class="perm-shortcuts"><button id="perm-all">Select all</button><button id="perm-clear">Clear all</button></div>
    <div class="perm-grid" id="perm-grid">${ALL_MODULES.map(itemHtml).join('')}</div>
    <div class="perm-preview" id="perm-preview"></div>
    <div class="modal-foot"><button class="btn btn-ghost" data-x>Cancel</button><button class="btn btn-primary" id="perm-save">Save access</button></div>`, true);

  const preview = () => {
    modal.querySelector('#perm-preview').innerHTML =
      `This user's navigation will show: <strong>${ALL_MODULES.filter(m => perms.has(m)).map(m => MODULES[m].label).join(', ')}</strong>`;
  };
  const repaint = () => {
    modal.querySelectorAll('.perm-item').forEach(el => el.classList.toggle('on', perms.has(el.dataset.perm)));
    preview();
  };
  preview();

  modal.querySelector('#perm-grid').onclick = e => {
    const item = e.target.closest('.perm-item'); if (!item) return;
    const m = item.dataset.perm; if (MODULES[m].locked) return;
    if (perms.has(m)) perms.delete(m); else perms.add(m);
    repaint();
  };
  modal.querySelector('#perm-all').onclick = () => { perms = new Set(ALL_MODULES); repaint(); };
  modal.querySelector('#perm-clear').onclick = () => { perms = new Set(['flightboard']); repaint(); };
  modal.querySelectorAll('[data-x]').forEach(b => b.onclick = closeModal);

  modal.querySelector('#perm-save').onclick = () => {
    const list = ALL_MODULES.filter(m => perms.has(m));
    updateUser(id, { permissions: list });
    logActivity({ action: 'updated access permissions', target: u.email, category: 'security', severity: 'info' });
    closeModal(); renderUsers(); showToast(`Access updated for ${u.name}`, 'success');
  };
}

/* ── detail drawer ── */
function openDrawer(id) {
  const u = findUser(x => x.id === id); if (!u) return;
  const acts = getActivity().filter(a => a.target === u.email).slice(0, 8);
  const pwAssess = passwordScore(u.password);
  const host = document.getElementById('drawer-host');
  host.innerHTML = `
    <div class="drawer">
      <div class="drawer-head"><h3 style="font-size:15px;font-weight:700">User details</h3>
        <button class="modal-x" data-x aria-label="Close"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6 L18 18 M18 6 L6 18"/></svg></button></div>
      <div class="drawer-body">
        <div class="drawer-avatar">${escapeHtml(initials(u.name))}</div>
        <div class="dw-name">${escapeHtml(u.name)}</div>
        <div class="dw-email">${escapeHtml(u.email)}</div>
        <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">${statusBadge(u.status)}<span class="role-badge">${escapeHtml(ROLES[u.role] || u.role)}</span></div>
        <div class="dw-section"><h4>Account</h4>
          <div class="dw-grid">
            <div class="dw-item"><div class="k">Organisation</div><div class="v">${escapeHtml(u.organisation || '—')}</div></div>
            <div class="dw-item"><div class="k">Registered</div><div class="v">${fmtDate(u.registeredAt)}</div></div>
            <div class="dw-item"><div class="k">Decision</div><div class="v">${u.decidedBy ? escapeHtml(u.decidedBy) + ' · ' + fmtDate(u.decidedAt) : '—'}</div></div>
            <div class="dw-item"><div class="k">Session</div><div class="v">${u.sessionActive ? 'Active now' : 'Last active ' + relTime(u.lastActiveAt)}</div></div>
          </div>
          ${u.rejectionReason ? `<div class="dw-item" style="margin-top:12px"><div class="k">Rejection reason</div><div class="v">${escapeHtml(u.rejectionReason)}</div></div>` : ''}
        </div>
        <div class="dw-section"><h4>Password strength</h4>
          <div class="strength"><div class="strength-bar"><span class="strength-fill" style="width:${pwAssess.pct}%;background:${pwAssess.color}"></span></div><span class="strength-label" style="color:${pwAssess.color}">${pwAssess.label}</span></div>
        </div>
        <div class="dw-section"><h4>Current permissions</h4>
          <div class="dw-perms">${(u.permissions || ['flightboard']).map(m => `<span class="dw-perm">${MODULES[m] ? MODULES[m].label : m}</span>`).join('')}</div>
        </div>
        <div class="dw-section"><h4>Activity history</h4>
          ${acts.length ? acts.map(a => `<div class="dw-act"><span class="sev act-sev ${a.severity}"></span><div><div>${escapeHtml(a.action)}</div><div class="act-meta">${escapeHtml(a.actor)} · ${fmtDateTime(a.timestamp)}</div></div></div>`).join('')
      : '<p style="font-size:12.5px;color:var(--text-mute)">No recorded activity for this user.</p>'}
        </div>
      </div>
    </div>`;
  host.hidden = false;
  host.onclick = e => { if (e.target === host || e.target.closest('[data-x]')) closeDrawer(); };
}
function closeDrawer() { const h = document.getElementById('drawer-host'); h.hidden = true; h.innerHTML = ''; h.onclick = null; }

/* ── activity log + export ── */
function renderActivity() {
  const list = document.getElementById('activity-list');
  const acts = getActivity().slice(0, 40);
  document.getElementById('activity-count').textContent = `${getActivity().length} entries`;
  if (!acts.length) { list.innerHTML = `<div class="empty"><div class="empty-ico"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8 v4 l3 2"/><circle cx="12" cy="12" r="9"/></svg></div><h4>No activity yet</h4><p>Administrative actions will be recorded here.</p></div>`; return; }
  list.innerHTML = acts.map(a => `<div class="act-row"><span class="act-sev ${a.severity}"></span>
      <div class="act-body"><div class="act-line"><strong>${escapeHtml(a.actor)}</strong> ${escapeHtml(a.action)} <span style="color:var(--text-mute)">${escapeHtml(a.target)}</span></div>
      <div class="act-meta">${fmtDateTime(a.timestamp)}</div></div><span class="act-cat">${escapeHtml(a.category)}</span></div>`).join('');
}

function download(filename, text, type) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
}
function exportCSV() {
  const acts = getActivity();
  const header = ['id', 'timestamp', 'actor', 'action', 'target', 'category', 'severity'];
  const esc = v => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  const csv = [header.join(','), ...acts.map(a => header.map(h => esc(a[h])).join(','))].join('\r\n');
  download('orbis-activity.csv', csv, 'text/csv');
  showToast('Activity exported as CSV', 'success');
}
function exportJSON() {
  download('orbis-activity.json', JSON.stringify(getActivity(), null, 2), 'application/json');
  showToast('Activity exported as JSON', 'success');
}

/* ═══ (view-app) permission-driven navigation ═══════════════ */

function renderApp() {
  const s = getSession();
  const user = findUser(u => u.id === s.userId);
  document.getElementById('app-who').textContent = s ? s.name : '';
  const perms = (user && user.permissions && user.permissions.length) ? user.permissions : ['flightboard'];
  const allowed = ALL_MODULES.filter(m => perms.includes(m));

  const nav = document.getElementById('app-nav');
  nav.innerHTML = `<div class="nav-label">Navigation</div>` + allowed.map((m, i) => `
    <div class="nav-item ${i === 0 ? 'active' : ''}" data-mod="${m}">
      <span class="ni-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${ICONS[m]}</svg></span>
      <span>${MODULES[m].label}</span></div>`).join('');

  const setStage = m => {
    document.getElementById('stage-icon').innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${ICONS[m]}</svg>`;
    document.getElementById('stage-title').textContent = MODULES[m].label;
    document.getElementById('stage-msg').textContent = `The ${MODULES[m].label} module will be built in a later prompt. Your access to it is enabled.`;
    const inner = document.getElementById('app-stage'); inner.style.animation = 'none'; void inner.offsetWidth; inner.style.animation = '';
  };
  setStage(allowed[0]);

  nav.onclick = e => {
    const item = e.target.closest('.nav-item'); if (!item) return;
    nav.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    item.classList.add('active'); setStage(item.dataset.mod);
  };

  showView('view-app');
}

function hasPermission(module) {
  const s = getSession(); if (!s) return false;
  const u = findUser(x => x.id === s.userId);
  return !!(u && u.permissions && u.permissions.includes(module));
}

/* ═══ (9) INIT & EVENT WIRING ═══════════════════════════════ */

function wireEyeEl(btn) {
  btn.addEventListener('click', () => {
    const input = document.getElementById(btn.dataset.eye); if (!input) return;
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password'; btn.classList.toggle('on', show);
  });
}

function wireAuth() {
  document.getElementById('login-form').addEventListener('submit', handleLogin);
  document.getElementById('signup-form').addEventListener('submit', handleSignup);
  document.getElementById('to-signup').addEventListener('click', e => { e.preventDefault(); swapAuth(true); });
  document.getElementById('to-login').addEventListener('click', e => { e.preventDefault(); swapAuth(false); });
  document.querySelectorAll('.eye').forEach(wireEyeEl);

  // live signup validation
  const wire = (id, name) => {
    const el = document.getElementById(id);
    el.addEventListener('blur', () => { signupTouched[name] = true; validateSignupField(name); });
    el.addEventListener('input', () => {
      if (name === 'pw') { updateStrengthUI(); if (document.getElementById('su-confirm').value) validateSignupField('confirm'); }
      if (signupTouched[name]) validateSignupField(name);
      else if (!signupTouched[name]) setTimeout(() => { signupTouched[name] = true; validateSignupField(name); }, 600);
    });
  };
  wire('su-name', 'name'); wire('su-email', 'email'); wire('su-org', 'org'); wire('su-pw', 'pw'); wire('su-confirm', 'confirm');
  document.getElementById('su-role').addEventListener('change', () => { signupTouched.role = true; validateSignupField('role'); });
}

function wireAdmin() {
  document.getElementById('admin-signout').addEventListener('click', handleSignOut);
  document.getElementById('add-user-btn').addEventListener('click', openAddUser);
  document.getElementById('pb-link').addEventListener('click', () => {
    document.getElementById('filter-status').value = 'PENDING'; adminFilters.status = 'PENDING'; renderUsers();
    document.querySelector('.panel').scrollIntoView({ behavior: 'smooth' });
  });

  document.getElementById('user-search').addEventListener('input', e => { adminFilters.q = e.target.value; renderUsers(); });
  document.getElementById('filter-status').addEventListener('change', e => { adminFilters.status = e.target.value; renderUsers(); });
  document.getElementById('filter-role').addEventListener('change', e => { adminFilters.role = e.target.value; renderUsers(); });

  const tbody = document.getElementById('users-body');
  tbody.addEventListener('click', e => {
    const kebab = e.target.closest('[data-kebab]');
    if (kebab) { e.stopPropagation(); openRowMenu(kebab.dataset.kebab, kebab); return; }
    const check = e.target.closest('[data-check]');
    if (check) {
      const id = check.dataset.check; if (check.checked) selectedIds.add(id); else selectedIds.delete(id);
      const tr = check.closest('tr'); tr.classList.toggle('selected', check.checked); updateBulkBar();
      document.getElementById('check-all').checked = [...tbody.querySelectorAll('[data-check]')].every(c => c.checked); return;
    }
    const row = e.target.closest('tr[data-id]'); if (row) openDrawer(row.dataset.id);
  });

  document.getElementById('check-all').addEventListener('change', e => {
    const rows = [...tbody.querySelectorAll('[data-check]')];
    rows.forEach(c => {
      c.checked = e.target.checked; if (e.target.checked) selectedIds.add(c.dataset.check); else selectedIds.delete(c.dataset.check);
      c.closest('tr').classList.toggle('selected', e.target.checked);
    });
    updateBulkBar();
  });

  document.getElementById('bulkbar').addEventListener('click', e => {
    const b = e.target.closest('[data-bulk]'); if (b) bulkAction(b.dataset.bulk);
  });

  document.getElementById('export-csv').addEventListener('click', exportCSV);
  document.getElementById('export-json').addEventListener('click', exportJSON);
}

function wireApp() { document.getElementById('app-signout').addEventListener('click', handleSignOut); }

function init() {
  seedIfEmpty();
  seedGuestUser();
  migratePermissions();
  seedOpsData();
  seedLoadsheets();
  ambient.init();
  wireAuth(); wireMFA(); wireAdmin(); wireApp();

  document.addEventListener('scroll', () => {
    const h = document.getElementById('kebab-host');
    if (h && !h.hidden) closeKebab();
  }, { capture: true, passive: true });
  window.addEventListener('resize', closeKebab);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeKebab(); closeDrawer(); } });

  // restore live session
  const s = getSession();
  if (s) {
    const u = findUser(x => x.id === s.userId);
    if (u && u.status === 'APPROVED') { sessionMgr.start(); if (u.role === 'SUPER_ADMIN') renderAdmin(); else renderApp(); return; }
    clearSession();
  }
  renderAuth();
}

/* ═══════════════════════════════════════════════════════════
   ORBIS OPERATIONAL MODULES  (Phases A–F)
     (S)  Simulation engine — PURE, no DOM
     (D)  Storage keys, weight versions, seed data
     (H)  App shell · showModule · nav · guards
     (X)  Shared render/chart helpers
     (M)  S2–S9 module renderers
     (F)  Alert engine · degraded mode · audit
   ═══════════════════════════════════════════════════════════ */

/* ═══ (S) SIMULATION ENGINE ═════════════════════════════════
   A faithful port of the ORBIS specification. Arrays in, numbers
   out — NO DOM access, NO Math.random(). Every draw comes from a
   seeded PRNG so a disputed prediction is fully reproducible. */
const ENGINE = (function () {
  const ITERATIONS = 1000;
  const VAR_NAMES = ['Heat Index', 'GSE Availability', 'Equipment Failure Risk', 'Passenger Load', 'PRM Handling'];
  const HIST_BINS = 24;

  function clamp(x, lo, hi) { return x < lo ? lo : x > hi ? hi : x; }

  /* mulberry32 — small deterministic PRNG */
  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      let t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  /* FNV-1a hash → 32-bit seed */
  function hashSeed(str) {
    let h = 2166136261 >>> 0;
    str = String(str);
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }

  /* STEP 1 — normalise raw inputs to five values in [0,1] */
  function normalise(raw, params) {
    return [
      clamp((raw.heatIndexC - 28.0) / (55.0 - 28.0), 0, 1),                 // v1 Heat Index
      clamp(1.0 - (raw.gseAvailable / raw.gseTotal), 0, 1),                 // v2 GSE unavailable
      clamp(raw.mtbfFailureProb, 0, 1),                                     // v3 MTBF failure
      clamp(raw.loadFactorPercent / 100.0, 0, 1),                          // v4 Load factor
      clamp(raw.prmCount / params.stationPrmP95, 0, 1)                      // v5 PRM handling
    ];
  }

  /* Input validation — reject / clamp / block, returns findings */
  function validate(raw, params) {
    const warnings = [];
    if (raw == null) return { ok: false, code: 'INCOMPLETE_DATA', warnings };
    const req = ['heatIndexC', 'gseAvailable', 'gseTotal', 'mtbfFailureProb', 'loadFactorPercent', 'prmCount'];
    for (const k of req) { if (raw[k] == null || Number.isNaN(Number(raw[k]))) return { ok: false, code: 'INCOMPLETE_DATA', field: k, warnings }; }
    if (raw.gseAvailable > raw.gseTotal) return { ok: false, code: 'REJECT_GSE', warnings };
    if (raw.passengerTotal != null && raw.prmCount > raw.passengerTotal) return { ok: false, code: 'REJECT_PRM', warnings };
    if (raw.loadFactorPercent > 100) warnings.push('loadFactorPercent > 100 — clamped to 100');
    if (raw.heatIndexC < -10 || raw.heatIndexC > 70) warnings.push('heatIndexC out of range — cached value used');
    return { ok: true, warnings };
  }

  /* Box–Muller standard normal driven by seeded rng */
  function gaussian(rng) {
    let u1 = 0, u2 = 0;
    while (u1 <= 1e-12) u1 = rng();
    u2 = rng();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }

  /* STEP 2–5 — Monte Carlo + attribution + classification + TOBT bits.
     `iters` overrides the 1000-draw default (used only by the fast T9
     self-check); production always runs the full 1000. */
  function run(raw, params, flightNumber, calcTimestamp, iters) {
    const N = iters || ITERATIONS;
    const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const v = normalise(raw, params);
    const W = params.weights, SIGMA = params.sigma;
    const seed = hashSeed(String(flightNumber) + '|' + String(calcTimestamp));
    const rng = mulberry32(seed);

    const buffers = new Array(N);
    let sum = 0;
    for (let i = 0; i < N; i++) {
      let composite = 0;
      for (let k = 0; k < 5; k++) {
        const s = clamp(v[k] + SIGMA[k] * gaussian(rng), 0, 1);
        composite += s * W[k];
      }
      const delayProb = 1 / (1 + Math.exp(-10 * (composite - 0.5)));
      const buf = params.baseBuffer + delayProb * params.maxAdditional;
      buffers[i] = buf; sum += buf;
    }
    buffers.sort((a, b) => a - b);
    const mean = sum / N;
    let sq = 0; for (let i = 0; i < N; i++) { const d = buffers[i] - mean; sq += d * d; }
    const std = Math.sqrt(sq / N);
    const pct = q => buffers[clamp(Math.floor(q * N), 0, N - 1)];
    const p10 = pct(0.10), p50 = pct(0.50), p90 = pct(0.90);

    /* STEP 3 — dominant variable attribution */
    const contributions = v.map((x, k) => x * W[k]);
    const csum = contributions.reduce((a, b) => a + b, 0);
    const shares = csum > 0 ? contributions.map(c => c / csum) : [0, 0, 0, 0, 0];
    let dominant = 0; for (let k = 1; k < 5; k++) if (shares[k] > shares[dominant]) dominant = k;

    /* STEP 4 — risk classification */
    const spread = p90 - p10, th = params.thresholds;
    let riskLevel;
    if (p90 <= th.green_p90 && spread < th.green_spread) riskLevel = 'GREEN';
    else if (p90 <= th.amber_p90 && spread < th.amber_spread) riskLevel = 'AMBER';
    else riskLevel = 'RED';

    /* histogram of the 1000 simulated buffers (adaptive bounds for full-width density curve) */
    const minBuf = buffers[0], maxBuf = buffers[N - 1];
    const pad = Math.max(1.5, (maxBuf - minBuf) * 0.12);
    const histLo = Math.max(0, Math.floor(minBuf - pad));
    const histHi = Math.ceil(maxBuf + pad);
    const histBins = new Array(HIST_BINS).fill(0);
    for (let i = 0; i < N; i++) {
      let idx = Math.floor((buffers[i] - histLo) / (histHi - histLo) * HIST_BINS);
      histBins[clamp(idx, 0, HIST_BINS - 1)]++;
    }

    const t1 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    return {
      p10, p50, p90, mean, std, seed, computeMs: +(t1 - t0).toFixed(2),
      buffer: Math.round(p50), riskLevel, spread,
      dominant, shares, contributions, normalisedVector: v,
      histBins, histLo, histHi
    };
  }

  return { ITERATIONS, VAR_NAMES, run, normalise, validate, hashSeed, clamp };
})();

/* ═══ (D) OPS STORAGE KEYS & HELPERS ════════════════════════ */
const FLIGHTS_KEY = 'orbis_flights';
const GSE_KEY = 'orbis_gse';
const GSE_SHIFT_KEY = 'orbis_gse_shift';
const ALERTS_KEY = 'orbis_alerts';
const OUTCOMES_KEY = 'orbis_outcomes';
const WEIGHTS_KEY = 'orbis_weights';
const RULES_KEY = 'orbis_action_rules';
const INTEG_KEY = 'orbis_integration';
const GHAS_KEY = 'orbis_ghas';
const GHA_PERF_KEY = 'orbis_gha_performance';
const GHA_PERF_CONFIG_KEY = 'orbis_gha_perf_config';
const EQUIP_PERF_CONFIG_KEY = 'orbis_equipment_perf_config';
const GHO_CERT_KEY = 'orbis_gho_certificates';
const LOADSHEET_KEY = 'orbis_loadsheets';

function lsGet(key, fb) { const v = readJSON(key, fb); return v == null ? fb : v; }
function lsSet(key, val) { localStorage.setItem(key, JSON.stringify(val)); }

function getFlights() { const f = lsGet(FLIGHTS_KEY, []); return Array.isArray(f) ? f : []; }
function saveFlights(f) { lsSet(FLIGHTS_KEY, f); }
function getFlight(id) { return getFlights().find(f => f.id === id) || null; }
function updateFlight(id, changes) {
  const all = getFlights(); const f = all.find(x => x.id === id);
  if (!f) return null; Object.assign(f, changes); saveFlights(all); return f;
}

function getGse() { const g = lsGet(GSE_KEY, []); return Array.isArray(g) ? g : []; }
function saveGse(g) { lsSet(GSE_KEY, g); }
function getGseShifts() { const s = lsGet(GSE_SHIFT_KEY, []); return Array.isArray(s) ? s : []; }
function getAlerts() { const a = lsGet(ALERTS_KEY, []); return Array.isArray(a) ? a : []; }
function saveAlerts(a) { lsSet(ALERTS_KEY, a); }
function getOutcomes() { const o = lsGet(OUTCOMES_KEY, []); return Array.isArray(o) ? o : []; }
function getWeightVersions() { const w = lsGet(WEIGHTS_KEY, []); return Array.isArray(w) ? w : []; }
function saveWeightVersions(w) { lsSet(WEIGHTS_KEY, w); }
function getActiveWeightVersion() { return getWeightVersions().find(v => v.status === 'ACTIVE') || getWeightVersions()[0]; }
function getWeightVersion(id) { return getWeightVersions().find(v => v.id === id) || getActiveWeightVersion(); }
function getActionRules() { return lsGet(RULES_KEY, {}); }
function getIntegration() { return lsGet(INTEG_KEY, { weather: 'HEALTHY', dcs: 'HEALTHY' }); }
function saveIntegration(i) { lsSet(INTEG_KEY, i); }

function getGhas() { const g = lsGet(GHAS_KEY, []); return Array.isArray(g) ? g : []; }
function saveGhas(g) { lsSet(GHAS_KEY, g); }
function getGha(id) { return getGhas().find(g => g.id === id) || null; }

/* GHA performance — monthly snapshots (append/upsert, not versioned) */
function getGhaPerfRecords() { const r = lsGet(GHA_PERF_KEY, []); return Array.isArray(r) ? r : []; }
function saveGhaPerfRecords(r) { lsSet(GHA_PERF_KEY, r); }
function getGhaPerfRecord(ghaId, period) { return getGhaPerfRecords().find(r => r.ghaId === ghaId && r.period === period) || null; }

/* GHA performance config — append-only versioning, identical convention to orbis_weights */
function getGhaPerfConfigVersions() { const v = lsGet(GHA_PERF_CONFIG_KEY, []); return Array.isArray(v) ? v : []; }
function saveGhaPerfConfigVersions(v) { lsSet(GHA_PERF_CONFIG_KEY, v); }
function getActiveGhaPerfConfig() { return getGhaPerfConfigVersions().find(v => v.status === 'ACTIVE') || getGhaPerfConfigVersions()[0]; }

function getEquipPerfConfigVersions() { return lsGet(EQUIP_PERF_CONFIG_KEY, []); }
function saveEquipPerfConfigVersions(v) { lsSet(EQUIP_PERF_CONFIG_KEY, v); }
function getActiveEquipPerfConfig() { const v = getEquipPerfConfigVersions(); return v.find(x => x.status === 'ACTIVE') || { params: { perCategoryCurves: { POWERED: { yearlyDeclinePercent: 8, floorPercent: 35 }, NON_POWERED: { yearlyDeclinePercent: 5, floorPercent: 45 }, INFRASTRUCTURE: { yearlyDeclinePercent: 3, floorPercent: 55 } }, maintenanceBonusPercent: 3, reactivationPenaltyPercent: 10 } }; }

/* GHO certificates — append-only; only new records are added, and only the
   status/revocation fields on the current record are ever changed in place */
function getGhoCertificates() { const c = lsGet(GHO_CERT_KEY, []); return Array.isArray(c) ? c : []; }
function saveGhoCertificates(c) { lsSet(GHO_CERT_KEY, c); }
function getGhoCertificate(id) { return getGhoCertificates().find(c => c.id === id) || null; }
/* the record actually in force for a GHA — the most recent ISSUED or AT_RISK
   certificate; REVOKED/EXPIRED ones are history, not "current" */
function currentGhoCertificate(ghaId) {
  return getGhoCertificates().filter(c => c.ghaId === ghaId && (c.status === 'ISSUED' || c.status === 'AT_RISK'))
    .sort((a, b) => new Date(b.issuedAt) - new Date(a.issuedAt))[0] || null;
}
function ghoCertificateHistory(ghaId) {
  return getGhoCertificates().filter(c => c.ghaId === ghaId).sort((a, b) => new Date(b.issuedAt) - new Date(a.issuedAt));
}
/* strictly increasing across the whole append-only array, so it's always
   unique regardless of which GHA or year it's issued under. Accepts an
   optional in-progress list — recomputeGhoStatuses() can issue certificates
   to several GHAs in one pass before ever saving, and a fresh getGhoCertificates()
   read wouldn't see those not-yet-persisted siblings, so it must count against
   the same in-memory array being built rather than risk a colliding number. */
function nextGhoCertificateNumber(list) {
  const seq = (list || getGhoCertificates()).length + 1;
  return `GHO-MUX-${new Date().getFullYear()}-${String(seq).padStart(4, '0')}`;
}

/* Loadsheets — one record per flight, edited in place through its DRAFT →
   PREPARED → APPROVED (→ SUPERSEDED_BY_LMC → re-APPROVED) workflow */
function getLoadsheets() { const l = lsGet(LOADSHEET_KEY, []); return Array.isArray(l) ? l : []; }
function saveLoadsheets(l) { lsSet(LOADSHEET_KEY, l); }
function getLoadsheet(id) { return getLoadsheets().find(x => x.id === id) || null; }
function getLoadsheetByFlight(flightId) { return getLoadsheets().find(x => x.flightId === flightId) || null; }
function updateLoadsheet(id, changes) {
  const all = getLoadsheets(); const l = all.find(x => x.id === id);
  if (!l) return null; Object.assign(l, changes); saveLoadsheets(all); return l;
}

/* time utilities */
function addMinutesISO(iso, min) { return new Date(new Date(iso).getTime() + min * 60000).toISOString(); }
function addMonthsISO(iso, months) { const d = new Date(iso); d.setMonth(d.getMonth() + months); return d.toISOString(); }
function periodStartISO(period) { const [y, m] = period.split('-').map(Number); return new Date(y, m - 1, 1).toISOString(); }
function periodEndISO(period) { const [y, m] = period.split('-').map(Number); return new Date(y, m, 0, 23, 59, 59).toISOString(); }
function hhmm(iso) { if (!iso) return '--:--'; const d = new Date(iso); return pad2(d.getHours()) + ':' + pad2(d.getMinutes()); }
function minutesBetween(aIso, bIso) { return Math.round((new Date(aIso) - new Date(bIso)) / 60000); }
function nowISO() { return new Date().toISOString(); }

/* the default calibration parameter set (spec defaults) */
function defaultEngineParams() {
  return {
    weights: [0.30, 0.25, 0.15, 0.15, 0.15],
    sigma: [0.05, 0.08, 0.06, 0.04, 0.07],
    baseBuffer: 25.0, maxAdditional: 25.0,
    thresholds: { green_p90: 30, green_spread: 6, amber_p90: 40, amber_spread: 12 },
    stationPrmP95: 8
  };
}

/* the engine's single public entry point.
   Stores nothing — callers persist the returned object onto the flight. */
function calculateFlightRisk(flight, versionId, fixedTs) {
  const version = versionId ? getWeightVersion(versionId) : getActiveWeightVersion();
  const params = version.params;
  const calcTs = fixedTs || nowISO();
  const r = ENGINE.run(flight.rawInputs, params, flight.flightNumber, calcTs);

  /* data quality — DEGRADED if any input arrived stale/cached */
  let quality = 'GOOD';
  const prov = flight.inputProvenance && flight.inputProvenance.perVariable;
  if (prov) for (const k in prov) { const q = prov[k].quality; if (q === 'STALE' || q === 'CACHED') quality = 'DEGRADED'; }

  return {
    p10: r.p10, p50: r.p50, p90: r.p90, mean: r.mean, std: r.std, seed: r.seed, computeMs: r.computeMs,
    bufferMinutes: r.buffer, riskLevel: r.riskLevel, tobt: addMinutesISO(flight.eibt, r.buffer),
    dominantVariable: ENGINE.VAR_NAMES[r.dominant], dominantIndex: r.dominant,
    dominantSharePercent: +(r.shares[r.dominant] * 100).toFixed(1),
    shares: r.shares, normalisedVector: r.normalisedVector, contributions: r.contributions,
    histBins: r.histBins, histLo: r.histLo, histHi: r.histHi, spread: r.spread,
    weightVersionId: version.id, calculatedAt: calcTs, dataQuality: quality
  };
}

/* recompute + persist a flight's stored calculation (fresh timestamp) */
function recomputeFlight(id) {
  const f = getFlight(id); if (!f) return null;
  const calc = calculateFlightRisk(f);
  updateFlight(id, { calculation: calc });
  return calc;
}

/* action-rules lookup → checklist array for a (risk, dominant) pair */
function lookupActions(riskLevel, dominantVariable) {
  const rules = getActionRules();
  let key = riskLevel + '|' + dominantVariable;
  if (riskLevel === 'GREEN') key = 'GREEN|*';
  let txt = rules[key] || rules[riskLevel + '|*'] || ('Review ' + dominantVariable + ' with ramp team; Confirm resourcing; Monitor status');
  let list = [];
  if (txt.includes(';')) {
    list = txt.split(';').map(s => s.trim()).filter(Boolean);
  } else if (txt.includes(' plus ')) {
    const parts = txt.split(' plus ');
    list = [parts[0].trim(), parts[1].charAt(0).toUpperCase() + parts[1].slice(1).trim(), 'Confirm crew readiness on stand'];
  } else {
    list = [txt, 'Confirm ramp crew readiness on stand', 'Monitor turnaround timeline'];
  }
  return list;
}

function formatStand(stand) {
  if (stand == null || stand === '') return 'Stand —';
  const str = String(stand).trim();
  if (/^stand\s+/i.test(str)) return str;
  return 'Stand ' + str;
}

/* ═══ (D) SEED DATA — make every screen look alive ══════════ */
function seedOpsData() {
  const now = Date.now();
  const iso = ms => new Date(ms).toISOString();
  const dayAgo = d => iso(now - d * 864e5);
  const dayAhead = d => iso(now + d * 864e5);

  /* ── weight versions (append-only; one ACTIVE + one SUPERSEDED) ── */
  if (!getWeightVersions().length) {
    const older = {
      id: 'wv-base-0', createdAt: dayAgo(21), author: 'System', note: 'Initial station calibration.',
      status: 'SUPERSEDED',
      params: {
        weights: [0.26, 0.24, 0.16, 0.18, 0.16], sigma: [0.05, 0.08, 0.06, 0.04, 0.07],
        baseBuffer: 25.0, maxAdditional: 25.0,
        thresholds: { green_p90: 30, green_spread: 6, amber_p90: 40, amber_spread: 12 }, stationPrmP95: 8
      }
    };
    const active = {
      id: 'wv-active-1', createdAt: dayAgo(7), author: 'System Admin', note: 'Seasonal re-weighting toward heat exposure.',
      status: 'ACTIVE', params: defaultEngineParams()
    };
    saveWeightVersions([older, active]);
  }

  /* ── GHA performance scoring config (append-only, same convention as orbis_weights) ── */
  if (!getGhaPerfConfigVersions().length) {
    saveGhaPerfConfigVersions([{
      id: 'gpc-base-1', createdAt: dayAgo(180), author: 'System', status: 'ACTIVE',
      note: 'Initial performance-scoring calibration.',
      params: {
        metricWeights: { deployment: 0.25, serviceability: 0.30, suitability: 0.25, fuelEfficiency: 0.20 },
        minimumThreshold: 85,
        ghoAnnualThreshold: 85, ghoMaxMonthsBelow: 1, ghoValidityMonths: 12
      }
    }]);
  }
  /* a returning browser's config was seeded before the GHO fields existed —
     backfill the active version's params in place (defaults, not a
     deliberate recalibration, so no new version is created for this) */
  {
    const gpcVersions = getGhaPerfConfigVersions();
    const activeGpc = gpcVersions.find(v => v.status === 'ACTIVE');
    if (activeGpc && activeGpc.params.ghoAnnualThreshold === undefined) {
      Object.assign(activeGpc.params, { ghoAnnualThreshold: 85, ghoMaxMonthsBelow: 1, ghoValidityMonths: 12 });
      saveGhaPerfConfigVersions(gpcVersions);
    }
  }

  if (!getEquipPerfConfigVersions().length) {
    saveEquipPerfConfigVersions([{
      id: 'epc-base-1', createdAt: dayAgo(180), author: 'System', status: 'ACTIVE',
      note: 'Initial equipment performance decay curves.',
      params: {
        perCategoryCurves: {
          POWERED:        { yearlyDeclinePercent: 8,  floorPercent: 35 },
          NON_POWERED:    { yearlyDeclinePercent: 5,  floorPercent: 45 },
          INFRASTRUCTURE: { yearlyDeclinePercent: 3,  floorPercent: 55 }
        },
        maintenanceBonusPercent: 3,
        reactivationPenaltyPercent: 10
      }
    }]);
  }

  /* ── action rules ── */
  if (!Object.keys(getActionRules()).length) {
    lsSet(RULES_KEY, {
      'GREEN|*': 'Standard procedure — monitor for changes; Confirm all GSE in position; Inspect stand safety area',
      'AMBER|Heat Index': 'Activate crew rotation; Confirm hydration station stocked; Provide shade canopy for ramp crew',
      'AMBER|GSE Availability': 'Confirm backup belt loader; Verify GPU serviceable; Pre-position tractor on stand',
      'AMBER|Equipment Failure Risk': 'Pre-check standby equipment; Place maintenance on standby; Verify hydraulic systems',
      'AMBER|Passenger Load': 'Stage second baggage crew; Confirm belt loader availability; Pre-sort priority baggage',
      'AMBER|PRM Handling': 'Brief PRM team 45 min prior; Stage ambulift at stand; Confirm passenger manifest count',
      'RED|Heat Index': 'Mandatory 15-min rotation; Assign extra crew; Notify shift manager; Stock ice & hydration packs',
      'RED|GSE Availability': 'Deploy all serviceable GSE to stand; Escalate to shift manager; Reallocate equipment from Stand 5',
      'RED|Equipment Failure Risk': 'Assign standby equipment; Pre-brief maintenance team; Inspect critical systems prior to arrival',
      'RED|Passenger Load': 'Deploy second belt loader; Assign additional baggage crew; Pre-stage extra baggage carts',
      'RED|PRM Handling': 'Deploy full PRM team; Stage two ambulifts; Brief team 60 min prior; Direct ramp escort'
    });
  }

  /* ── integration health ── */
  if (!localStorage.getItem(INTEG_KEY)) saveIntegration({ weather: 'HEALTHY', dcs: 'HEALTHY' });

  /* ── Ground Handling Agents (own entity — GSE units reference these by id) ──
     ids are kept as the original short codes so GHA_BY_TYPE's seed mapping and
     every already-shipped ghaOf()/ghaBadge() call site need no further change.
     Contract ends are anchored to "now" (not fixed calendar dates) so one
     agent (PIA) is always inside the 90-day expiring-soon window and one
     (RAS) is always already expired, without needing manual test setup. */
  if (!getGhas().length) {
    saveGhas([
      {
        id: 'DNATA', name: "Gerry's dnata", code: 'DNATA', ownership: 'PRIVATE',
        licenseNumber: 'PCAA/GH/MUX/047', contactName: 'Farhan Qureshi',
        contactPhone: '+92-61-4560221', contactEmail: 'farhan.qureshi@dnata.com',
        contractStart: dayAgo(2200), contractEnd: dayAhead(400),
        airlinesServed: ['QR', 'FZ', 'EK'], status: 'ACTIVE',
        createdAt: dayAgo(2200), updatedAt: dayAgo(30)
      },
      {
        id: 'PIA', name: 'PIA Ground Handling (PIAC)', code: 'PIAGH', ownership: 'PRIVATE',
        licenseNumber: 'PCAA/GH/MUX/012', contactName: 'Nadia Baig',
        contactPhone: '+92-61-4560355', contactEmail: 'nadia.baig@piac.com.pk',
        contractStart: dayAgo(1500), contractEnd: dayAhead(45),
        airlinesServed: ['PK', 'PA'], status: 'ACTIVE',
        createdAt: dayAgo(1500), updatedAt: dayAgo(10)
      },
      {
        id: 'SAPS', name: 'Shaheen Airport Services', code: 'SAPS', ownership: 'PRIVATE',
        licenseNumber: 'PCAA/GH/MUX/089', contactName: 'Imran Yousafzai',
        contactPhone: '+92-61-4560780', contactEmail: 'imran.yousafzai@shaheenair.com',
        contractStart: dayAgo(1100), contractEnd: dayAhead(180),
        airlinesServed: ['ER', '9P'], status: 'SUSPENDED',
        createdAt: dayAgo(1100), updatedAt: dayAgo(5)
      },
      {
        id: 'RAS', name: 'Royal Airport Services', code: 'RAS', ownership: 'PRIVATE',
        licenseNumber: 'PCAA/GH/MUX/033', contactName: 'Zara Chaudhry',
        contactPhone: '+92-61-4560990', contactEmail: 'zara.chaudhry@royalairportservices.pk',
        contractStart: dayAgo(2600), contractEnd: dayAgo(15),
        airlinesServed: ['PK', '9P'], status: 'ACTIVE',
        createdAt: dayAgo(2600), updatedAt: dayAgo(60)
      },
      {
        id: 'AUTH', name: 'Airport Authority (MUX)', code: 'MUX', ownership: 'AIRPORT_SUBSIDIARY',
        licenseNumber: 'PCAA/GH/MUX/001', contactName: 'Station Duty Manager',
        contactPhone: '+92-61-4560100', contactEmail: 'duty.manager@caa.gov.pk',
        contractStart: dayAgo(3600), contractEnd: dayAhead(900),
        airlinesServed: [], status: 'ACTIVE',
        createdAt: dayAgo(3600), updatedAt: dayAgo(200)
      }
    ]);
  }

  /* ── GSE fleet (Comprehensive Real-World Airport Equipment) ── */
  if (!getGse().length || getGse().length < 35 || !getGse()[0].category || getGse()[0].ghaId === undefined || getGse()[0].financial === undefined) {
    const svcDates = (lastD, nextD) => ({ lastService: dayAgo(lastD), nextServiceDue: iso(now + nextD * 864e5) });
    const unit = (typeCode, type, n, serial, status, mtbf, lastD, nextD, cat = 'POWERED', log) => Object.assign({
      id: 'gse-' + typeCode + '-' + n, typeCode, type, serial, status, category: cat,
      ghaId: GHA_BY_TYPE[typeCode] || 'AUTH', mtbfHours: mtbf,
      maintLog: log || [{ date: dayAgo(lastD), type: 'Scheduled service', notes: 'Routine inspection completed.', hours: 2 }]
    }, svcDates(lastD, nextD));
    const gseList = [
      // POWERED GSE
      unit('TUG', 'Pushback Tug', 1, 'TUG-77', 'SERVICEABLE', 1500, 25, 70, 'POWERED'),
      unit('TUG', 'Pushback Tug', 2, 'TUG-78', 'SERVICEABLE', 1350, 55, 4, 'POWERED'),
      unit('TLT', 'Towbarless Tractor', 1, 'TLT-101', 'SERVICEABLE', 1600, 10, 80, 'POWERED'),
      unit('TLT', 'Towbarless Tractor', 2, 'TLT-102', 'MAINTENANCE', 1400, 4, 15, 'POWERED'),
      unit('BL', 'Belt Loader', 1, 'BL-4471', 'SERVICEABLE', 900, 12, 48, 'POWERED'),
      unit('BL', 'Belt Loader', 2, 'BL-4472', 'SERVICEABLE', 760, 40, 8, 'POWERED'),
      unit('BL', 'Belt Loader', 3, 'BL-4473', 'UNSERVICEABLE', 540, 70, -4, 'POWERED'),
      unit('BT', 'Baggage Tractor', 1, 'BT-91', 'SERVICEABLE', 1100, 15, 65, 'POWERED'),
      unit('BT', 'Baggage Tractor', 2, 'BT-92', 'SERVICEABLE', 990, 48, 10, 'POWERED'),
      unit('BT', 'Baggage Tractor', 3, 'BT-93', 'MAINTENANCE', 520, 6, 25, 'POWERED'),
      unit('CL', 'Cargo High Loader', 1, 'CL-501', 'SERVICEABLE', 1300, 18, 60, 'POWERED'),
      unit('CL', 'Cargo High Loader', 2, 'CL-502', 'SERVICEABLE', 1250, 30, 45, 'POWERED'),
      unit('GPU', 'Ground Power Unit (GPU)', 1, 'GPU-208', 'SERVICEABLE', 1200, 18, 60, 'POWERED'),
      unit('GPU', 'Ground Power Unit (GPU)', 2, 'GPU-209', 'MAINTENANCE', 600, 4, 20, 'POWERED'),
      unit('ASU', 'Air Start Unit (ASU)', 1, 'ASU-12', 'SERVICEABLE', 1100, 22, 50, 'POWERED'),
      unit('ASU', 'Air Start Unit (ASU)', 2, 'ASU-13', 'SERVICEABLE', 1050, 45, 12, 'POWERED'),
      unit('PCA', 'Preconditioned Air (PCA)', 1, 'PCA-04', 'SERVICEABLE', 1000, 14, 75, 'POWERED'),
      unit('PCA', 'Preconditioned Air (PCA)', 2, 'PCA-05', 'SERVICEABLE', 950, 50, 5, 'POWERED'),
      unit('FLT', 'Fuel Bowser Truck', 1, 'FBL-88', 'SERVICEABLE', 1800, 20, 90, 'POWERED'),
      unit('FLT', 'Fuel Bowser Truck', 2, 'FBL-89', 'SERVICEABLE', 1750, 40, 30, 'POWERED'),
      unit('PWT', 'Potable Water Truck', 1, 'PWT-15', 'SERVICEABLE', 700, 30, 30, 'POWERED'),
      unit('LST', 'Lavatory Service Truck', 1, 'LST-22', 'SERVICEABLE', 680, 60, 2, 'POWERED'),
      unit('LST', 'Lavatory Service Truck', 2, 'LST-23', 'UNSERVICEABLE', 450, 75, -6, 'POWERED'),
      unit('DCT', 'De-icing Truck', 1, 'DCT-01', 'SERVICEABLE', 1400, 15, 120, 'POWERED'),
      unit('CAT', 'Catering Hi-Lift Truck', 1, 'CAT-301', 'SERVICEABLE', 1200, 28, 40, 'POWERED'),
      unit('CAT', 'Catering Hi-Lift Truck', 2, 'CAT-302', 'SERVICEABLE', 1150, 55, 8, 'POWERED'),
      unit('PBS', 'Mobile Boarding Stairs', 1, 'PBS-14', 'SERVICEABLE', 850, 35, 45, 'POWERED'),
      unit('AMB', 'Ambulift (PRM)', 1, 'AMB-31', 'SERVICEABLE', 800, 20, 55, 'POWERED'),
      unit('AMB', 'Ambulift (PRM)', 2, 'AMB-32', 'UNSERVICEABLE', 430, 80, -9, 'POWERED'),
      unit('FLK', 'Ramp Forklift', 1, 'FLK-08', 'SERVICEABLE', 950, 25, 60, 'POWERED'),
      unit('SWP', 'Runway/Apron Sweeper', 1, 'SWP-03', 'SERVICEABLE', 1600, 12, 70, 'POWERED'),
      unit('RFF', 'ARFF Crash Tender', 1, 'RFF-01', 'SERVICEABLE', 2500, 10, 150, 'POWERED'),
      unit('BCV', 'Bird Control Vehicle', 1, 'BCV-01', 'SERVICEABLE', 1100, 15, 80, 'POWERED'),

      // NON-POWERED / MANUAL GSE
      unit('CHK', 'Wheel Chocks', 1, 'CHK-SET-01', 'SERVICEABLE', 5000, 5, 180, 'NON_POWERED'),
      unit('CHK', 'Wheel Chocks', 2, 'CHK-SET-02', 'SERVICEABLE', 5000, 10, 180, 'NON_POWERED'),
      unit('CNS', 'Safety Cones', 1, 'CNS-SET-01', 'SERVICEABLE', 5000, 5, 180, 'NON_POWERED'),
      unit('BCD', 'Baggage Cart / Dolly', 1, 'BCD-101', 'SERVICEABLE', 3000, 30, 90, 'NON_POWERED'),
      unit('BCD', 'Baggage Cart / Dolly', 2, 'BCD-102', 'SERVICEABLE', 3000, 45, 75, 'NON_POWERED'),
      unit('CPD', 'Cargo Pallet Dolly', 1, 'CPD-201', 'SERVICEABLE', 3000, 20, 100, 'NON_POWERED'),
      unit('ULD', 'ULD Container Dolly', 1, 'ULD-301', 'SERVICEABLE', 3000, 15, 110, 'NON_POWERED'),
      unit('JCK', 'Aircraft Hydraulic Jacks', 1, 'JCK-A320-1', 'SERVICEABLE', 2000, 40, 60, 'NON_POWERED'),
      unit('COV', 'Wing & Engine Covers', 1, 'COV-ENG-01', 'SERVICEABLE', 4000, 60, 120, 'NON_POWERED'),
      unit('MSH', 'Marshalling Wands', 1, 'MSH-WAND-01', 'SERVICEABLE', 5000, 1, 180, 'NON_POWERED'),

      // FIXED INFRASTRUCTURE
      unit('PBB', 'Passenger Boarding Bridge', 1, 'PBB-GATE-01', 'SERVICEABLE', 4000, 15, 90, 'INFRASTRUCTURE'),
      unit('PBB', 'Passenger Boarding Bridge', 2, 'PBB-GATE-02', 'SERVICEABLE', 3800, 25, 65, 'INFRASTRUCTURE'),
      unit('PBB', 'Passenger Boarding Bridge', 3, 'PBB-GATE-03', 'MAINTENANCE', 3200, 5, 10, 'INFRASTRUCTURE'),
      unit('FHS', 'Fuel Hydrant System', 1, 'FHS-STAND-01', 'SERVICEABLE', 5000, 10, 120, 'INFRASTRUCTURE'),
      unit('FHS', 'Fuel Hydrant System', 2, 'FHS-STAND-02', 'SERVICEABLE', 5000, 20, 110, 'INFRASTRUCTURE')
    ];

    /* ── financial & operational enrichment ──
       ownership rides the existing GHA_BY_TYPE assignment: AUTH-operated
       units are the airport's own fixed/safety assets, everything else is
       GHA-owned mobile ramp kit — same split, no separate randomised rule.
       Per-serial ageYears + suitableFor are hand-picked for narrative spread
       (some units brand-new, some past their useful life) rather than random,
       so depreciation and suitability demo consistently on every reseed. */
    const NARROW = ['Airbus A320', 'Airbus A321', 'Boeing 737-800'];
    const WIDE = ['Boeing 777-200ER', 'Boeing 777-300ER', 'Boeing 787 Dreamliner', 'Airbus A330-300', 'Boeing 747-400 (Hajj Peak)'];
    /* litres/hour ("lph") lives in the shared GSE_FUEL_BENCHMARK table (see
       the GHA Performance Scoring Engine section below) — the rate used to
       seed a unit's "normal" fuel burn is the exact same one later used to
       grade it, so a unit seeded at-benchmark always scores ~100 on fuel
       efficiency until a period's synthetic figures deliberately push it off. */
    const TYPE_FIN = {
      TUG: { cost: 82000, life: 10 }, TLT: { cost: 175000, life: 10 },
      BL: { cost: 42000, life: 9 }, BT: { cost: 27000, life: 9 },
      CL: { cost: 205000, life: 11 }, GPU: { cost: 30000, life: 8 },
      ASU: { cost: 92000, life: 10 }, PCA: { cost: 105000, life: 10 },
      FLT: { cost: 145000, life: 11 }, PWT: { cost: 62000, life: 9 },
      LST: { cost: 68000, life: 9 }, DCT: { cost: 310000, life: 12 },
      CAT: { cost: 155000, life: 10 }, PBS: { cost: 52000, life: 12 },
      AMB: { cost: 185000, life: 10 }, FLK: { cost: 36000, life: 10 },
      SWP: { cost: 140000, life: 11 }, RFF: { cost: 820000, life: 15 },
      BCV: { cost: 40000, life: 9 },
      CHK: { cost: 550, life: 15 }, CNS: { cost: 280, life: 12 }, BCD: { cost: 2100, life: 15 },
      CPD: { cost: 3400, life: 15 }, ULD: { cost: 4100, life: 15 }, JCK: { cost: 11500, life: 18 },
      COV: { cost: 3600, life: 12 }, MSH: { cost: 140, life: 10 },
      PBB: { cost: 1250000, life: 28 }, FHS: { cost: 620000, life: 30 }
    };
    const GSE_META = {
      'TUG-77': { suitableFor: ['ALL'], ageYears: 4.5 }, 'TUG-78': { suitableFor: NARROW, ageYears: 1.2 },
      'TLT-101': { suitableFor: WIDE, ageYears: 7.5 }, 'TLT-102': { suitableFor: NARROW, ageYears: 0.4, electric: true },
      'BL-4471': { suitableFor: NARROW, ageYears: 3.0 }, 'BL-4472': { suitableFor: ['ALL'], ageYears: 0.8 },
      'BL-4473': { suitableFor: NARROW, ageYears: 9.5 },
      'BT-91': { suitableFor: ['ALL'], ageYears: 2.5 }, 'BT-92': { suitableFor: ['ALL'], ageYears: 6.0 },
      'BT-93': { suitableFor: ['ALL'], ageYears: 0.3, electric: true },
      'CL-501': { suitableFor: WIDE, ageYears: 5.5 }, 'CL-502': { suitableFor: ['ALL'], ageYears: 1.5 },
      'GPU-208': { suitableFor: ['ALL'], ageYears: 6.5 }, 'GPU-209': { suitableFor: NARROW, ageYears: 0.2, electric: true },
      'ASU-12': { suitableFor: WIDE, ageYears: 3.5 }, 'ASU-13': { suitableFor: NARROW, ageYears: 8.5 },
      'PCA-04': { suitableFor: ['ALL'], ageYears: 2.0 }, 'PCA-05': { suitableFor: NARROW, ageYears: 0.6, electric: true },
      'FBL-88': { suitableFor: ['ALL'], ageYears: 4.0 }, 'FBL-89': { suitableFor: NARROW, ageYears: 9.0 },
      'PWT-15': { suitableFor: ['ALL'], ageYears: 5.0 },
      'LST-22': { suitableFor: ['ALL'], ageYears: 2.8 }, 'LST-23': { suitableFor: NARROW, ageYears: 12.0 },
      'DCT-01': { suitableFor: ['ALL'], ageYears: 3.2 },
      'CAT-301': { suitableFor: NARROW, ageYears: 6.8 }, 'CAT-302': { suitableFor: ['ALL'], ageYears: 1.0 },
      'PBS-14': { suitableFor: NARROW, ageYears: 4.2 },
      'AMB-31': { suitableFor: ['ALL'], ageYears: 2.2 }, 'AMB-32': { suitableFor: NARROW, ageYears: 10.5 },
      'FLK-08': { suitableFor: ['ALL'], ageYears: 5.8 }, 'SWP-03': { suitableFor: ['ALL'], ageYears: 3.8 },
      'RFF-01': { suitableFor: ['ALL'], ageYears: 6.0 }, 'BCV-01': { suitableFor: ['ALL'], ageYears: 2.6 },
      'CHK-SET-01': { suitableFor: NARROW, ageYears: 6.0 }, 'CHK-SET-02': { suitableFor: ['ALL'], ageYears: 2.0 },
      'CNS-SET-01': { suitableFor: ['ALL'], ageYears: 3.0 },
      'BCD-101': { suitableFor: ['ALL'], ageYears: 5.0 }, 'BCD-102': { suitableFor: ['ALL'], ageYears: 1.5 },
      'CPD-201': { suitableFor: ['ALL'], ageYears: 4.0 }, 'ULD-301': { suitableFor: WIDE, ageYears: 3.5 },
      'JCK-A320-1': { suitableFor: ['Airbus A320'], ageYears: 5.0 },
      'COV-ENG-01': { suitableFor: NARROW, ageYears: 4.5 }, 'MSH-WAND-01': { suitableFor: ['ALL'], ageYears: 6.0 },
      'PBB-GATE-01': { suitableFor: WIDE, ageYears: 8.0 }, 'PBB-GATE-02': { suitableFor: NARROW, ageYears: 5.0 },
      'PBB-GATE-03': { suitableFor: ['ALL'], ageYears: 12.0 },
      'FHS-STAND-01': { suitableFor: ['ALL'], ageYears: 10.0 }, 'FHS-STAND-02': { suitableFor: ['ALL'], ageYears: 6.0 }
    };
    saveGse(gseList.map(u => {
      const meta = GSE_META[u.serial] || {};
      const fin = TYPE_FIN[u.typeCode] || { cost: 40000, life: 10 };
      const ageYears = meta.ageYears != null ? meta.ageYears : 4;
      const acquisitionCost = fin.cost, usefulLifeYears = fin.life, lph = GSE_FUEL_BENCHMARK[u.typeCode] || 6;
      const isElectric = !!meta.electric;
      const fuelType = u.category !== 'POWERED' ? 'N/A' : (isElectric ? 'ELECTRIC' : 'DIESEL');
      const fuelCostPerHour = fuelType === 'DIESEL' ? Math.round(lph * 1.35 * 10) / 10 : 0;
      const jitter = u.mtbfHours % 37;
      const deploymentHoursThisMonth = u.status === 'UNSERVICEABLE' ? 4 + (jitter % 12)
        : u.status === 'MAINTENANCE' ? 18 + (jitter % 22)
        : u.category === 'INFRASTRUCTURE' ? 125 + (jitter % 55)
        : u.category === 'NON_POWERED' ? 30 + (jitter % 45)
        : 50 + (jitter % 70);
      const fuelConsumptionThisMonth = fuelType === 'DIESEL' ? Math.round(deploymentHoursThisMonth * lph) : 0;
      const maintBase = Math.round(acquisitionCost * 0.018 * Math.min(ageYears, usefulLifeYears) / 50) * 50;
      const maintExtra = u.status === 'UNSERVICEABLE' ? 1800 : u.status === 'MAINTENANCE' ? 900 : 0;
      return Object.assign(u, {
        ownership: u.ghaId === 'AUTH' ? 'AIRPORT' : 'GHA',
        suitableFor: meta.suitableFor || ['ALL'],
        financial: {
          acquisitionCost, acquisitionDate: dayAgo(Math.round(ageYears * 365.25)), usefulLifeYears,
          fuelType, fuelCostPerHour, maintenanceCostToDate: maintBase + maintExtra
        },
        nonFinancial: { deploymentHoursThisMonth, fuelConsumptionThisMonth }
      });
    }));

    // Enrich select units with recent maintenance for performance-score demo
    const gse = getGse();
    const recentMaintUnits = ['gse-TUG-1', 'gse-GPU-1', 'gse-BL-1', 'gse-PBB-1', 'gse-FLT-1'];
    recentMaintUnits.forEach(id => {
      const u = gse.find(x => x.id === id);
      if (u) u.maintLog.push({ date: dayAgo(15), type: 'Scheduled service', notes: 'Comprehensive preventive maintenance completed.', hours: 4 });
    });
    // Reactivation demo: units recently repaired
    const reactUnit1 = gse.find(x => x.id === 'gse-TLT-2');
    if (reactUnit1) {
      reactUnit1.status = 'SERVICEABLE';
      reactUnit1.maintLog.push({ date: dayAgo(10), type: 'Corrective repair', notes: 'Motor overhaul — restored to service after failure.', hours: 12 });
    }
    const reactUnit2 = gse.find(x => x.id === 'gse-BT-3');
    if (reactUnit2) {
      reactUnit2.status = 'SERVICEABLE';
      reactUnit2.maintLog.push({ date: dayAgo(5), type: 'Major repair and reactivation', notes: 'Fixed hydraulic system failure — unit reactivated.', hours: 8 });
    }
    saveGse(gse);
  }

  /* ── flights (Official Aircraft Fleet Specs) ── */
  const aircraftMap = {
    'A320': 'Airbus A320',
    'A321': 'Airbus A321',
    'ATR72': 'Airbus A320',
    'B737': 'Boeing 737-800',
    'B737-800': 'Boeing 737-800',
    'B777-200ER': 'Boeing 777-200ER',
    'B777-300ER': 'Boeing 777-300ER',
    'B787-9': 'Boeing 787 Dreamliner',
    'A330-300': 'Airbus A330-300',
    'B747-400': 'Boeing 747-400 (Hajj Peak)',
    'Boeing 747-400': 'Boeing 747-400 (Hajj Peak)'
  };

  const existingFlights = getFlights();
  if (existingFlights.length) {
    let updated = false;
    existingFlights.forEach(f => {
      if (aircraftMap[f.aircraftType]) {
        f.aircraftType = aircraftMap[f.aircraftType];
        updated = true;
      }
    });
    if (updated) saveFlights(existingFlights);
  }

  /* a browser that already ran an earlier build of this seed (before the
     block-on lifecycle existed) has flight records with no actualInBlock
     KEY at all — not just null — so that's the signal to migrate/reseed,
     distinct from a legitimately-still-SCHEDULED flight's null value */
  const needsLifecycleReseed = getFlights().some(f => f.actualInBlock === undefined);
  if (!getFlights().length || getFlights().length < 8 || needsLifecycleReseed) {
    const prov = (quality, ageMin) => ({
      source: quality === 'STALE' ? 'Weather feed (cached)' : 'Live feed',
      timestamp: iso(now - (ageMin || 3) * 60000), quality
    });
    const makeProv = (stale) => ({
      perVariable: {
        heatIndexC: stale ? prov('STALE', 68) : prov('GOOD', 4),
        gseAvailable: prov('GOOD', 6), mtbfFailureProb: prov('MANUAL', 15),
        loadFactorPercent: prov('GOOD', 9), prmCount: prov('MANUAL', 20)
      }
    });
    const F = (o) => Object.assign({
      id: 'flt-' + o.flightNumber, status: 'SCHEDULED', alertId: null,
      ackStatus: 'NONE', ackAt: null, ackBy: null, actualOffBlock: null, delayReasonCode: null,
      actualInBlock: null, inBlockLoggedBy: null, inBlockVarianceMin: null,
      inputProvenance: makeProv(!!o.stale)
    }, o);

    /* eibt/std for the arrived/departed flights below are placeholders —
       backfilled to real, buffer-anchored values in the profiling pass
       further down, once each flight's own bufferMinutes is known. */
    const flights = [
      F({
        flightNumber: 'PK-301', airline: 'PK', stand: 3, aircraftType: 'Airbus A320', eibt: iso(now), std: iso(now), status: 'IN_BLOCK',
        rawInputs: { heatIndexC: 53, gseAvailable: 3, gseTotal: 10, mtbfFailureProb: 0.55, loadFactorPercent: 94, prmCount: 5, passengerTotal: 180 }
      }),
      F({
        flightNumber: 'PA-204', airline: 'PA', stand: 4, aircraftType: 'Boeing 777-200ER', eibt: iso(now), std: iso(now), status: 'IN_BLOCK', stale: true,
        rawInputs: { heatIndexC: 50, gseAvailable: 4, gseTotal: 12, mtbfFailureProb: 0.60, loadFactorPercent: 90, prmCount: 6, passengerTotal: 280 }
      }),
      F({
        flightNumber: 'ER-712', airline: 'ER', stand: 2, aircraftType: 'Airbus A321', eibt: iso(now + 14 * 60000), std: iso(now + 59 * 60000), status: 'SCHEDULED',
        rawInputs: { heatIndexC: 49, gseAvailable: 5, gseTotal: 10, mtbfFailureProb: 0.52, loadFactorPercent: 88, prmCount: 4, passengerTotal: 220 }
      }),
      /* Boeing 747-400: Seasonal Hajj/Umrah peak operations only (not year-round) */
      F({
        flightNumber: 'PK-305', airline: 'PK', stand: 1, aircraftType: 'Boeing 747-400 (Hajj Peak)', eibt: iso(now), std: iso(now), status: 'IN_BLOCK',
        rawInputs: { heatIndexC: 44, gseAvailable: 6, gseTotal: 10, mtbfFailureProb: 0.40, loadFactorPercent: 62, prmCount: 3, passengerTotal: 416 }
      }),
      F({
        flightNumber: 'FZ-336', airline: 'FZ', stand: 5, aircraftType: 'Boeing 737-800', eibt: iso(now + 55 * 60000), std: iso(now + 100 * 60000), status: 'SCHEDULED',
        rawInputs: { heatIndexC: 45, gseAvailable: 6, gseTotal: 10, mtbfFailureProb: 0.42, loadFactorPercent: 70, prmCount: 3, passengerTotal: 186 }
      }),
      F({
        flightNumber: 'EK-623', airline: 'EK', stand: 2, aircraftType: 'Boeing 777-300ER', eibt: iso(now - 6 * 60000), std: iso(now + 39 * 60000), status: 'SCHEDULED',
        rawInputs: { heatIndexC: 43, gseAvailable: 7, gseTotal: 10, mtbfFailureProb: 0.38, loadFactorPercent: 66, prmCount: 2, passengerTotal: 358 }
      }),
      F({
        flightNumber: 'ER-540', airline: 'ER', stand: 5, aircraftType: 'Airbus A330-300', eibt: iso(now), std: iso(now), status: 'OFF_BLOCK',
        rawInputs: { heatIndexC: 46, gseAvailable: 7, gseTotal: 10, mtbfFailureProb: 0.35, loadFactorPercent: 68, prmCount: 2, passengerTotal: 290 }
      }),
      F({
        flightNumber: '9P-118', airline: '9P', stand: 1, aircraftType: 'Airbus A320', eibt: iso(now), std: iso(now), status: 'OFF_BLOCK',
        rawInputs: { heatIndexC: 36, gseAvailable: 8, gseTotal: 10, mtbfFailureProb: 0.20, loadFactorPercent: 40, prmCount: 1, passengerTotal: 180 }
      }),
      F({
        flightNumber: 'QR-612', airline: 'QR', stand: 3, aircraftType: 'Boeing 787 Dreamliner', eibt: iso(now), std: iso(now), status: 'OFF_BLOCK',
        rawInputs: { heatIndexC: 34, gseAvailable: 9, gseTotal: 10, mtbfFailureProb: 0.15, loadFactorPercent: 35, prmCount: 1, passengerTotal: 290 }
      }),
      F({
        flightNumber: '9P-220', airline: '9P', stand: 4, aircraftType: 'Airbus A321', eibt: iso(now), std: iso(now), status: 'IN_BLOCK',
        rawInputs: { heatIndexC: 37, gseAvailable: 8, gseTotal: 10, mtbfFailureProb: 0.22, loadFactorPercent: 45, prmCount: 2, passengerTotal: 220 }
      })
    ];

    /* calculate + persist every flight, then raise alerts for AMBER/RED */
    const alerts = [];
    flights.forEach((f, i) => {
      f.calculation = calculateFlightRisk(f, undefined, iso(now - (flights.length - i) * 1000));
      if (f.calculation.riskLevel !== 'GREEN') {
        const al = makeAlertRecord(f);
        /* stagger created times a little so a couple are already escalated for the demo */
        al.createdAt = iso(now - [7, 4, 9, 1, 6, 2, 3, 5][i % 8] * 60000);
        rollAlertStages(al);
        f.alertId = al.id; f.ackStatus = 'REQUIRED';
        alerts.push(al);
      }
    });

    /* place each arrived/departed flight at a realistic point in its
       SCHEDULED → IN_BLOCK → OFF_BLOCK lifecycle, anchored to that flight's
       OWN computed buffer — so the live elapsed-vs-buffer states (under /
       approaching / over) are correct the instant the app loads, not just
       plausible-looking. The three SCHEDULED flights above already carry
       their real near-term EIBTs; this pass backfills the rest. */
    const inBlockProfiles = {
      'PK-301': { elapsedRatio: 1.30, minElapsed: 8, lateMin: 9, loggedBy: 'A. Khan' },    // deliberately OVER buffer on load
      'PA-204': { elapsedRatio: 0.90, minElapsed: 6, lateMin: -2, loggedBy: 'S. Malik' },  // APPROACHING buffer
      'PK-305': { elapsedRatio: 0.35, minElapsed: 4, lateMin: -1, loggedBy: 'B. Ahmed' },  // comfortably UNDER
      '9P-220': { elapsedRatio: 0, minElapsed: 4, lateMin: 3, loggedBy: 'R. Iqbal' }        // just arrived
    };
    const offBlockProfiles = {
      'ER-540': { startedAgoMin: 150, offErrMin: 3, loggedBy: 'A. Khan', reason: null },
      '9P-118': { startedAgoMin: 225, offErrMin: 9, loggedBy: 'S. Malik', reason: 'Baggage handling' },
      'QR-612': { startedAgoMin: 130, offErrMin: 19, loggedBy: 'B. Ahmed', reason: 'ATC/slot' }
    };
    flights.forEach(f => {
      const buf = f.calculation.bufferMinutes;
      const ib = inBlockProfiles[f.flightNumber];
      const ob = offBlockProfiles[f.flightNumber];
      if (ib) {
        const elapsedMin = Math.max(ib.minElapsed, Math.round(buf * ib.elapsedRatio));
        const actualInBlock = iso(now - elapsedMin * 60000);
        const eibt = iso(new Date(actualInBlock).getTime() - ib.lateMin * 60000);
        f.eibt = eibt; f.std = addMinutesISO(eibt, 45);
        f.actualInBlock = actualInBlock; f.inBlockLoggedBy = ib.loggedBy; f.inBlockVarianceMin = ib.lateMin;
        f.calculation.tobt = addMinutesISO(eibt, buf);
      } else if (ob) {
        const actualInBlock = iso(now - ob.startedAgoMin * 60000);
        const eibt = iso(new Date(actualInBlock).getTime() - 4 * 60000);
        const actualOffBlock = addMinutesISO(eibt, buf + ob.offErrMin);
        f.eibt = eibt; f.std = addMinutesISO(eibt, 45);
        f.actualInBlock = actualInBlock; f.inBlockLoggedBy = ob.loggedBy; f.inBlockVarianceMin = 4;
        f.actualOffBlock = actualOffBlock; f.delayReasonCode = ob.reason;
        f.calculation.tobt = addMinutesISO(eibt, buf);
      }
    });

    /* an alert belonging to a flight that has already departed is moot —
       acknowledge it; among the still-active flights, ack exactly one
       outstanding AMBER up-front so both ack states remain visible */
    alerts.forEach(al => {
      const ff = flights.find(x => x.id === al.flightId);
      if (ff && ff.status === 'OFF_BLOCK') {
        al.stage = 'ACKNOWLEDGED'; al.ackAt = ff.actualOffBlock; al.ackBy = ff.inBlockLoggedBy;
        ff.ackStatus = 'ACKNOWLEDGED'; ff.ackAt = al.ackAt; ff.ackBy = al.ackBy;
      }
    });
    const ackTarget = alerts.find(a => a.stage !== 'ACKNOWLEDGED' && a.riskLevel === 'AMBER');
    if (ackTarget) {
      ackTarget.stage = 'ACKNOWLEDGED'; ackTarget.ackAt = iso(now - 30000); ackTarget.ackBy = 'A. Khan';
      const ff = flights.find(x => x.id === ackTarget.flightId); if (ff) { ff.ackStatus = 'ACKNOWLEDGED'; ff.ackAt = ackTarget.ackAt; ff.ackBy = 'A. Khan'; }
    }

    saveFlights(flights);
    saveAlerts(alerts);
  }

  /* ── historical outcomes (learning dataset) ── */
  if (!getOutcomes().length) {
    const sups = ['A. Khan', 'S. Malik', 'B. Ahmed', 'R. Iqbal'];
    const risks = ['GREEN', 'AMBER', 'RED'];
    const doms = ENGINE.VAR_NAMES;
    const active = getActiveWeightVersion();
    const rnd = () => Math.random();
    const gauss = () => { let u = 0, v = 0; while (u <= 1e-9) u = rnd(); v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
    const outcomes = [];
    const N = 56;
    for (let i = 0; i < N; i++) {
      const risk = risks[Math.floor(rnd() * 3)];
      const predicted = risk === 'GREEN' ? 26 + rnd() * 4 : risk === 'AMBER' ? 33 + rnd() * 6 : 42 + rnd() * 7;
      /* signed error: modest bias + noise, occasional outlier */
      const bias = risk === 'RED' ? 2.5 : risk === 'AMBER' ? 0.5 : -0.5;
      let err = bias + gauss() * 6.5;
      if (rnd() < 0.08) err += (rnd() < 0.5 ? -1 : 1) * (12 + rnd() * 10);   // outliers
      const actual = Math.max(15, predicted + err);
      const dominant = doms[Math.floor(rnd() * doms.length)];
      const quality = rnd() < 0.12 ? 'DEGRADED' : 'GOOD';
      const daysBack = Math.floor(rnd() * 30);
      outcomes.push({
        id: uid('oc'), flightNumber: ['PK', 'ER', '9P', 'FZ', 'EK', 'QR'][Math.floor(rnd() * 6)] + '-' + (100 + Math.floor(rnd() * 800)),
        predictedBuffer: +predicted.toFixed(1), actualBuffer: +actual.toFixed(1), error: +(actual - predicted).toFixed(1),
        normalisedVector: [rnd(), rnd(), rnd(), rnd(), rnd()].map(x => +x.toFixed(3)),
        weightVersionId: active.id, riskLevel: risk, dominantVariable: dominant,
        supervisor: sups[Math.floor(rnd() * sups.length)], dataQuality: quality,
        loggedAt: iso(now - daysBack * 864e5 - Math.floor(rnd() * 12) * 36e5), delayReasonCode: null
      });
    }
    outcomes.sort((a, b) => new Date(b.loggedAt) - new Date(a.loggedAt));
    lsSet(OUTCOMES_KEY, outcomes);
  }

  /* real outcomes for the flights seeded straight into OFF_BLOCK above, so
     Off-Block history and Analytics reflect actual seed data — not only the
     synthetic 56. Runs every load (not just first-ever seed) and is
     dedup-safe by flightId, so it also backfills a returning browser whose
     orbis_outcomes predates this reseed. */
  const outcomesNow = getOutcomes();
  const missingLinked = getFlights().filter(f => f.status === 'OFF_BLOCK' && !outcomesNow.some(o => o.flightId === f.id));
  if (missingLinked.length) {
    missingLinked.forEach(f => {
      const c = f.calculation;
      outcomesNow.push({
        id: uid('oc'), flightId: f.id, flightNumber: f.flightNumber,
        predictedBuffer: c.bufferMinutes, actualBuffer: minutesBetween(f.actualOffBlock, f.eibt),
        error: minutesBetween(f.actualOffBlock, c.tobt),
        normalisedVector: c.normalisedVector, weightVersionId: c.weightVersionId,
        riskLevel: c.riskLevel, dominantVariable: c.dominantVariable,
        supervisor: f.inBlockLoggedBy || 'Supervisor', dataQuality: c.dataQuality,
        loggedAt: f.actualOffBlock, delayReasonCode: f.delayReasonCode
      });
    });
    outcomesNow.sort((a, b) => new Date(b.loggedAt) - new Date(a.loggedAt));
    lsSet(OUTCOMES_KEY, outcomesNow);
  }

  /* ── GHA performance history — 6 months × 5 GHAs, run through the real
     GHA_PERF.* scoring functions (see the scoring-engine section further
     down the file — already loaded by the time this runs). Fleet sizes and
     required-aircraft-type counts are read live off the seeded fleet/GHAs;
     only the per-month ratios below are authored, to build a deliberate
     narrative: DNATA & AUTH consistently strong, PIA trending up, RAS
     trending down through the minimum threshold, SAPS hovering near it —
     so the warning system in Part E has something real to flag. */
  if (!getGhaPerfRecords().length) {
    const periods = last6Periods();
    const trend = {
      DNATA: {
        deploy: [0.88, 0.90, 0.92, 0.89, 0.93, 0.91], svc: [0.92, 0.90, 0.94, 0.91, 0.95, 0.93],
        suitFrac: [1, 1, 1, 1, 1, 1], fuelMult: [0.90, 0.85, 0.92, 0.88, 0.90, 0.87]
      },
      PIA: {
        deploy: [0.55, 0.62, 0.68, 0.75, 0.82, 0.90], svc: [0.60, 0.66, 0.72, 0.80, 0.86, 0.93],
        suitFrac: [1 / 3, 1 / 3, 2 / 3, 2 / 3, 1, 1], fuelMult: [1.55, 1.35, 1.20, 1.10, 1.00, 0.90]
      },
      SAPS: {
        /* month 6 (current) is intentionally worse than the "hover" pattern
           of months 1-5: with suitability naturally maxed on live-mutated
           current-month equipment (see below), deploy/svc/fuel need to be
           this low on their own for SAPS to still land below minimum —
           which is also what makes its Jul→Aug dip a genuine fresh
           threshold-crossing for the activity-log feature to demonstrate. */
        deploy: [0.80, 0.75, 0.85, 0.72, 0.83, 0.65], svc: [0.88, 0.82, 0.90, 0.80, 0.87, 0.70],
        suitFrac: [2 / 3, 2 / 3, 1, 2 / 3, 1, 2 / 3], fuelMult: [1.05, 1.15, 0.95, 1.20, 1.00, 1.40]
      },
      RAS: {
        deploy: [0.92, 0.86, 0.80, 0.72, 0.65, 0.58], svc: [0.94, 0.88, 0.82, 0.75, 0.68, 0.60],
        suitFrac: [1, 1, 2 / 3, 2 / 3, 1 / 3, 1 / 3], fuelMult: [0.85, 0.95, 1.10, 1.30, 1.50, 1.70]
      },
      AUTH: {
        deploy: [0.85, 0.82, 0.88, 0.86, 0.90, 0.87], svc: [0.92, 0.90, 0.94, 0.91, 0.95, 0.92],
        suitFrac: [1, 1, 1, 1, 1, 1], fuelMult: [0.90, 0.95, 0.85, 0.92, 0.88, 0.90]
      }
    };
    const perfConfig = getActiveGhaPerfConfig();
    const curPeriod = currentPeriod();

    /* CURRENT month only: actually mutate the live orbis_gse fields
       (deployment hours, status mix, diesel fuel burn) to match each GHA's
       month-6 ratios, so a later live recompute (e.g. from the config
       screen) reproduces the same story instead of silently overwriting it
       with unrelated equipment-seed defaults. Historical months stay pure
       synthetic — they're never recomputed live, so there's nothing to
       stay consistent with. */
    const fullFleet = getGse();
    getGhas().forEach(gha => {
      const profile = trend[gha.id]; if (!profile) return;
      const units = fullFleet.filter(u => u.ghaId === gha.id && u.status !== 'RETIRED').sort((a, b) => a.id.localeCompare(b.id));
      const totalCount = units.length; if (!totalCount) return;
      const hoursCapacity = totalCount * referenceDaysForPeriod(curPeriod) * 8;
      const hoursAchieved = Math.round(hoursCapacity * profile.deploy[5]);
      const perUnitHours = Math.round(hoursAchieved / totalCount);
      const serviceableCount = Math.round(totalCount * profile.svc[5]);

      units.forEach((u, idx) => {
        u.status = idx < serviceableCount ? 'SERVICEABLE' : 'UNSERVICEABLE';
        u.nonFinancial = u.nonFinancial || {};
        u.nonFinancial.deploymentHoursThisMonth = idx === totalCount - 1 ? hoursAchieved - perUnitHours * (totalCount - 1) : perUnitHours;
        if (u.category === 'POWERED' && u.financial && u.financial.fuelType === 'DIESEL') {
          const lph = GSE_FUEL_BENCHMARK[u.typeCode] || 6;
          u.nonFinancial.fuelConsumptionThisMonth = Math.round(u.nonFinancial.deploymentHoursThisMonth * lph * profile.fuelMult[5]);
        }
      });
    });
    saveGse(fullFleet);

    const perfRecords = [];
    getGhas().forEach(gha => {
      const profile = trend[gha.id]; if (!profile) return;
      const units = getGse().filter(u => u.ghaId === gha.id && u.status !== 'RETIRED');
      const totalCount = units.length;
      const requiredTypes = requiredAircraftTypesForGha(gha);
      const requiredCount = requiredTypes.length;
      const poweredDiesel = units.filter(u => u.category === 'POWERED' && u.financial && u.financial.fuelType === 'DIESEL');

      periods.forEach((period, i) => {
        /* current month: real computeGhaPerformance against the
           just-mutated live fleet, so seed and future recompute agree */
        if (period === curPeriod) {
          const result = computeGhaPerformance(gha.id, period);
          perfRecords.push(Object.assign({ id: 'gp-' + gha.id + '-' + period }, result));
          return;
        }

        const refDays = referenceDaysForPeriod(period);
        const hoursCapacity = totalCount * refDays * 8;
        const hoursAchieved = Math.round(hoursCapacity * profile.deploy[i]);
        const deployment = GHA_PERF.deploymentScore(hoursAchieved, hoursCapacity);

        const serviceableCount = Math.round(totalCount * profile.svc[i]);
        const serviceability = GHA_PERF.serviceabilityScore(serviceableCount, totalCount);

        const coveredCount = requiredCount ? Math.round(requiredCount * profile.suitFrac[i]) : 0;
        const suitability = GHA_PERF.suitabilityScore(coveredCount, requiredCount);

        let fuelScoreSum = 0;
        poweredDiesel.forEach(u => {
          const lph = GSE_FUEL_BENCHMARK[u.typeCode] || 6;
          fuelScoreSum += GHA_PERF.fuelEfficiencyScore(lph * profile.fuelMult[i], lph);
        });
        const poweredTotal = units.filter(u => u.category === 'POWERED').length;
        const fuelEfficiency = poweredTotal ? Math.round((fuelScoreSum + (poweredTotal - poweredDiesel.length) * 100) / poweredTotal) : 100;

        const metrics = { deployment, serviceability, suitability, fuelEfficiency };
        const overallScore = GHA_PERF.overallScore(metrics, perfConfig.params.metricWeights);
        const belowMinimum = overallScore < perfConfig.params.minimumThreshold;

        perfRecords.push({
          id: 'gp-' + gha.id + '-' + period, ghaId: gha.id, period, metrics, overallScore, belowMinimum,
          computedAt: iso(now - (5 - i) * 30 * 864e5),
          detail: {
            deployment: `${hoursAchieved} of ${hoursCapacity} possible hours`,
            serviceability: `${serviceableCount} of ${totalCount} units serviceable`,
            suitability: requiredCount ? `${coveredCount} of ${requiredCount} required types covered` : 'No airlines served — nothing required',
            fuelEfficiency: `${Math.abs(Math.round((profile.fuelMult[i] - 1) * 100))}% ${profile.fuelMult[i] <= 1 ? 'under' : 'above'} benchmark`
          }
        });
      });
    });
    saveGhaPerfRecords(perfRecords);

    /* fire the one genuine "crossed below minimum" activity entry for
       whichever GHA's current month just dipped, through the same de-dup
       path the live recompute uses — not a bulk log of all 30 records */
    perfRecords.filter(r => r.period === curPeriod).forEach(r => upsertGhaPerfRecord(r, { log: true }));
  }

  /* ── GHO certificates — seed two PRIOR-cycle records so the very first
     recomputeGhoStatuses() pass below has something to transition (an
     already-ISSUED certificate going AT_RISK, an already-EXPIRED one
     prompting a fresh renewal) rather than only ever issuing from a blank
     slate. Which GHAs end up ISSUED / AT_RISK / uncertified is otherwise
     entirely driven by the real evaluation against the seeded 6-month
     performance history, run once here — never re-seeded or re-run
     automatically on later loads, matching "once at seed time". */
  if (!getGhoCertificates().length) {
    saveGhoCertificates([
      { // DNATA's prior annual cycle, already lapsed — recompute renews it
        id: 'ghoc-seed-1', certificateNumber: 'GHO-MUX-2025-0001', ghaId: 'DNATA', periodType: 'ANNUAL',
        evaluationWindow: { from: dayAgo(14 * 30), to: dayAgo(2 * 30) },
        trailingAverageScore: 93, monthsBelow: 0,
        status: 'EXPIRED', issuedAt: dayAgo(14 * 30), expiresAt: dayAgo(2 * 30), revokedAt: null, revokedReason: null,
        basisMetrics: { deployment: 90, serviceability: 93, suitability: 100, fuelEfficiency: 91 }
      },
      { // RAS earned this while it was still a strong performer — still
        // valid on paper, but its trailing average has since fallen, so
        // the first evaluation pass moves it to AT_RISK, not a hardcoded state
        id: 'ghoc-seed-2', certificateNumber: 'GHO-MUX-2025-0002', ghaId: 'RAS', periodType: 'ANNUAL',
        evaluationWindow: { from: dayAgo(200 + 365), to: dayAgo(200) },
        trailingAverageScore: 92, monthsBelow: 0,
        status: 'ISSUED', issuedAt: dayAgo(200), expiresAt: dayAhead(165), revokedAt: null, revokedReason: null,
        basisMetrics: { deployment: 90, serviceability: 93, suitability: 100, fuelEfficiency: 91 }
      }
    ]);
    recomputeGhoStatuses();
    recomputeAllEquipmentScores();
  }
}

/* ═══ (F) ALERT ENGINE — records, staging, escalation ═══════
   Demo timers are compressed but the STAGES and their ordering are
   intact (noted on the manager dashboard). */
const ALERT_T = { RED: { sms: 2, esc: 5 }, AMBER: { sms: 5, esc: 10 } };   // minutes

function makeAlertRecord(f) {
  return {
    id: uid('al'), flightId: f.id, flightNumber: f.flightNumber, riskLevel: f.calculation.riskLevel,
    createdAt: f.calculation.calculatedAt, stage: 'AWAITING', ackAt: null, ackBy: null,
    events: [{ stage: 'ISSUED', at: f.calculation.calculatedAt }]
  };
}
function alertAckDeadline(al) { return new Date(al.createdAt).getTime() + ALERT_T[al.riskLevel].esc * 60000; }

/* advance an alert through its escalation stages based on elapsed time */
function rollAlertStages(al) {
  if (al.stage === 'ACKNOWLEDGED') return al;
  const t = ALERT_T[al.riskLevel];
  const ageMin = (Date.now() - new Date(al.createdAt)) / 60000;
  const f = getFlight(al.flightId);
  const addEvent = stage => { if (!al.events.some(e => e.stage === stage)) al.events.push({ stage, at: nowISO() }); };
  let stage = 'AWAITING';
  if (ageMin >= t.sms) { stage = 'SMS_SENT'; addEvent('SMS_SENT'); }
  if (ageMin >= t.esc) { stage = 'ESCALATED'; addEvent('ESCALATED'); }
  if (f && ageMin >= t.esc && minutesBetween(f.eibt, nowISO()) <= 30) { stage = 'UNACK_CRITICAL'; addEvent('UNACK_CRITICAL'); }
  al.stage = stage;
  return al;
}

/* acknowledge a flight's alert */
function acknowledgeAlert(flightId, who) {
  const alerts = getAlerts();
  const al = alerts.find(a => a.flightId === flightId && a.stage !== 'ACKNOWLEDGED');
  const when = nowISO();
  if (al) { al.stage = 'ACKNOWLEDGED'; al.ackAt = when; al.ackBy = who; al.events.push({ stage: 'ACKNOWLEDGED', at: when }); saveAlerts(alerts); }
  updateFlight(flightId, { ackStatus: 'ACKNOWLEDGED', ackAt: when, ackBy: who });
  const f = getFlight(flightId);
  logActivity({ action: 'acknowledged ' + (f ? f.calculation.riskLevel : '') + ' alert', target: f ? f.flightNumber : flightId, category: 'alert', severity: 'success' });
  updateAlertBadge();
}

/* outstanding = not yet acknowledged */
function outstandingAlerts() { return getAlerts().filter(a => a.stage !== 'ACKNOWLEDGED'); }

const alertEngine = (function () {
  let timer = null;
  function tick() {
    const alerts = getAlerts(); let changed = false;
    alerts.forEach(a => { const before = a.stage; rollAlertStages(a); if (a.stage !== before) changed = true; });
    if (changed) saveAlerts(alerts);
    updateAlertBadge();
    /* live-refresh the board countdowns & manager escalation panel */
    if (currentModule === 'flightboard') { tickBoardCountdowns(); tickBoardElapsed(); }
    if (currentModule === 'manager') tickManagerLive();
    if (currentModule === 'offblock') tickBlockOnDue();
    if (currentModule === 'turnaround') tickTurnaroundElapsed();
  }
  return {
    start() { if (timer) clearInterval(timer); tick(); timer = setInterval(tick, 1000); },
    stop() { if (timer) clearInterval(timer); timer = null; }
  };
})();

/* ═══ (H) APP SHELL · navigation · module guard ═════════════ */
let currentModule = null;
let selectedFlightId = null;

function currentUser() { const s = getSession(); return s ? findUser(u => u.id === s.userId) : null; }
function currentActor() { const s = getSession(); return s ? s.name : 'Supervisor'; }

/* renderApp — override of the Phase-shell stub: builds the persistent
   module shell from the signed-in user's permission array. */
function renderApp() {
  const s = getSession(); if (!s) return renderAuth();
  const user = findUser(u => u.id === s.userId);
  document.getElementById('app-who').textContent = s.name || '';
  const perms = (user && user.permissions && user.permissions.length) ? user.permissions : ['flightboard'];
  const allowed = ALL_MODULES.filter(m => perms.includes(m));

  buildAppNav(allowed);
  renderDegradedBanner();
  alertEngine.start();
  showView('view-app');

  const first = allowed.includes('flightboard') ? 'flightboard' : allowed[0];
  showModule(first || 'flightboard');
}

function buildAppNav(allowed) {
  const nav = document.getElementById('app-nav');
  nav.innerHTML = `<div class="nav-label">Modules</div>` + allowed.map(m => `
    <button class="nav-item" data-mod="${m}" type="button">
      <span class="ni-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${ICONS[m]}</svg></span>
      <span class="ni-label">${MODULES[m].label}</span></button>`).join('');
  nav.onclick = e => { const it = e.target.closest('.nav-item'); if (it) showModule(it.dataset.mod); };
}

/* the module dispatch — permission-guarded */
function renderModule(key, el) {
  switch (key) {
    case 'flightboard': return renderFlightBoard(el);
    case 'turnaround': return renderTurnaround(el);
    case 'gse': return renderGseEntry(el);
    case 'offblock': return renderOffBlock(el);
    case 'manager': return renderManager(el);
    case 'equipment': return renderEquipment(el);
    case 'gha': return renderGhaManagement(el);
    case 'weights': return renderWeights(el);
    case 'analytics': return renderAnalytics(el);
    case 'loadsheet': return renderLoadsheet(el);
    default: return renderFlightBoard(el);
  }
}

function showModule(key) {
  /* real enforcement — a denied key never renders */
  if (!hasPermission(key)) { renderAccessDenied(key); return; }
  currentModule = key;
  document.querySelectorAll('#app-nav .nav-item').forEach(n => n.classList.toggle('active', n.dataset.mod === key));
  const root = document.getElementById('module-root'); if (!root) return;
  root.scrollTop = 0; root.innerHTML = '';
  const view = document.createElement('section'); view.className = 'module-view';
  root.appendChild(view);
  renderModule(key, view);
  requestAnimationFrame(() => view.classList.add('in'));
  closeKebab(); updateAlertBadge();
}

function renderAccessDenied(key) {
  currentModule = null;
  document.querySelectorAll('#app-nav .nav-item').forEach(n => n.classList.remove('active'));
  const root = document.getElementById('module-root'); if (!root) return;
  root.innerHTML = `
    <div class="module-view in"><div class="access-denied">
      <div class="empty-ico" style="width:56px;height:56px;background:var(--red-lite);color:var(--red);border-radius:14px">
        <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2 L20 5 V11 C20 16 16.5 19.5 12 22 C7.5 19.5 4 16 4 11 V5 Z"/><path d="M12 8 v4 M12 16 v.1"/></svg></div>
      <h2>You don't have access to this module</h2>
      <p>${MODULES[key] ? MODULES[key].label : 'This module'} is not enabled for your account. Ask a station administrator to grant access.</p>
      <button class="btn btn-primary" id="ad-back">Go to Flight Board</button>
    </div></div>`;
  const back = document.getElementById('ad-back'); if (back) back.onclick = () => showModule('flightboard');
  showToast('Access to that module is not enabled for your account', 'notice');
  setTimeout(() => { if (!currentModule) showModule('flightboard'); }, 2600);
}

/* alert badge in the top bar */
function updateAlertBadge() {
  const badge = document.getElementById('alert-badge'); if (!badge) return;
  const n = outstandingAlerts().length;
  badge.hidden = n === 0;
  const cnt = document.getElementById('alert-count'); if (cnt) cnt.textContent = String(n);
  const critical = outstandingAlerts().some(a => a.stage === 'ESCALATED' || a.stage === 'UNACK_CRITICAL');
  badge.classList.toggle('critical', critical);
  badge.onclick = () => { if (hasPermission('manager')) showModule('manager'); else showModule('flightboard'); };
}

/* degraded-integration banner */
function renderDegradedBanner() {
  const banner = document.getElementById('degraded-banner'); if (!banner) return;
  const integ = getIntegration();
  const down = [];
  if (integ.weather !== 'HEALTHY') down.push('Weather');
  if (integ.dcs !== 'HEALTHY') down.push('DCS');
  if (!down.length) { banner.hidden = true; banner.innerHTML = ''; return; }
  banner.hidden = false;
  banner.innerHTML = `
    <span class="db-dot"></span>
    <span class="db-text"><strong>Degraded mode</strong> — ${down.join(' & ')} feed${down.length > 1 ? 's' : ''} unavailable. Affected flights fall back to cached inputs and are flagged; predictions still run.</span>`;
}

/* ═══ (X) SHARED RENDER / CHART HELPERS ═════════════════════ */
function riskColor(level) { return level === 'RED' ? 'var(--red)' : level === 'AMBER' ? 'var(--amber)' : 'var(--green)'; }
function riskChip(level) { return `<span class="risk-chip r-${level}"><span class="rc-dot"></span>${level}</span>`; }
function mmss(ms) { const s = Math.max(0, Math.floor(ms / 1000)); return pad2(Math.floor(s / 60)) + ':' + pad2(s % 60); }
function errorClass(err) { const a = Math.abs(err); return a <= 5 ? 'good' : a <= 15 ? 'warn' : 'bad'; }
function fmtSigned(n) { return (n > 0 ? '+' : '') + n; }
function isSameDay(iso) {
  if (!iso) return false;
  const d = new Date(iso), n = new Date();
  return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
}
function refreshStaleFlightTimestamps() {
  const flights = getFlights();
  if (!flights.length) return;
  const now = Date.now();
  let changed = false;

  const inBlockProfiles = {
    'PK-301': { elapsedRatio: 1.30, minElapsed: 32, lateMin: 9 },   // over buffer
    'PA-204': { elapsedRatio: 0.90, minElapsed: 24, lateMin: -2 },  // approaching buffer
    'PK-305': { elapsedRatio: 0.35, minElapsed: 9, lateMin: -1 },   // comfortably under
    '9P-220': { elapsedRatio: 0, minElapsed: 4, lateMin: 3 }        // just arrived
  };

  flights.forEach(f => {
    if (f.status === 'IN_BLOCK' && f.actualInBlock) {
      const ageMs = now - new Date(f.actualInBlock).getTime();
      if (ageMs > 60 * 60 * 1000 || ageMs < 0) {
        const ib = inBlockProfiles[f.flightNumber] || { minElapsed: 15, lateMin: 0 };
        const buf = (f.calculation && f.calculation.bufferMinutes) || 25;
        const elapsedMin = ib.elapsedRatio ? Math.round(buf * ib.elapsedRatio) : ib.minElapsed;
        const actualInBlock = iso(now - elapsedMin * 60000);
        const eibt = iso(new Date(actualInBlock).getTime() - ib.lateMin * 60000);
        f.actualInBlock = actualInBlock;
        f.eibt = eibt;
        f.std = addMinutesISO(eibt, 45);
        if (f.calculation) f.calculation.tobt = addMinutesISO(eibt, buf);
        changed = true;
      }
    }
  });

  if (changed) {
    saveFlights(flights);
  }
}

/* the live prediction-vs-reality comparison that powers the Part-C elapsed
   readouts on the Flight Board, Turnaround Detail and Manager Dashboard —
   one shared source of truth so the three surfaces can never disagree. */
function turnaroundElapsedInfo(sinceIso, bufferMinutes) {
  let elapsedMs = Date.now() - new Date(sinceIso).getTime();
  let elapsedMin = elapsedMs / 60000;
  const buf = bufferMinutes || 25;

  // Prototype safety clamp: if elapsedMin > 60 (stale stored timestamp from previous session),
  // clamp it so it stays within realistic turnaround bounds for demo display
  if (isNaN(elapsedMin) || elapsedMin < 0 || elapsedMin > 60) {
    elapsedMin = Math.min(Math.max(4, elapsedMin), Math.round(buf * 1.25));
    elapsedMs = elapsedMin * 60000;
  }

  const ratio = buf > 0 ? elapsedMin / buf : 0;
  let state = 'under';
  if (elapsedMin > buf) state = 'over';
  else if (ratio >= 0.85) state = 'approaching';
  return { elapsedMs, elapsedMin, buf, ratio, state, overBy: Math.max(0, Math.round(elapsedMin - buf)) };
}
function openGenericDrawer(html) {
  const host = document.getElementById('drawer-host');
  host.innerHTML = `<div class="drawer">${html}</div>`;
  host.hidden = false;
  host.onclick = e => { if (e.target === host || e.target.closest('[data-x]')) closeDrawer(); };
}

/* a downsampled polyline path for line/area charts */
function polyPath(points) { return points.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' '); }

/* ═══ (M) MODULE HELPERS — raw values, provenance, charts ═══ */
function rawValueLabel(f, idx) {
  const r = f.rawInputs;
  switch (idx) {
    case 0: return Math.round(r.heatIndexC) + '°C';
    case 1: return r.gseAvailable + '/' + r.gseTotal;
    case 2: return Math.round(r.mtbfFailureProb * 100) + '%';
    case 3: return Math.round(r.loadFactorPercent) + '%';
    case 4: return r.prmCount + ' PRM';
  }
  return '—';
}
const PROV_KEYS = ['heatIndexC', 'gseAvailable', 'mtbfFailureProb', 'loadFactorPercent', 'prmCount'];
function provFor(f, idx) {
  const p = f.inputProvenance && f.inputProvenance.perVariable;
  const key = PROV_KEYS[idx];
  return (p && p[key]) ? p[key] : { source: '—', timestamp: null, quality: 'GOOD' };
}
function qualityFlag(q) { return `<span class="q-flag q-${q}">${q || 'GOOD'}</span>`; }

/* histogram bars as an inline SVG */
function histBarsSVG(bins, w, h, color) {
  const bList = Array.isArray(bins) && bins.length ? bins : new Array(24).fill(1);
  const max = Math.max(1, ...bList);
  const bw = w / bList.length;
  return `<svg class="hist-svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" width="100%" height="${h}">` +
    bList.map((b, i) => {
      const bh = (b / max) * (h - 2);
      return `<rect class="hist-bar" x="${(i * bw + 0.7).toFixed(1)}" y="${(h - bh).toFixed(1)}" width="${(bw - 1.4).toFixed(1)}" height="${bh.toFixed(1)}" rx="1" style="fill:${color};animation-delay:${(i * 14)}ms"/>`;
    }).join('') + `</svg>`;
}

/* unified confidence band density chart SVG with dynamic zoom */
function renderConfidenceChart(c, accent) {
  const rawBins = Array.isArray(c.histBins) && c.histBins.length ? c.histBins : new Array(24).fill(1);
  const numBins = rawBins.length;

  let fIdx = 0, lIdx = numBins - 1;
  while (fIdx < numBins && rawBins[fIdx] === 0) fIdx++;
  while (lIdx >= 0 && rawBins[lIdx] === 0) lIdx--;
  if (fIdx >= lIdx) { fIdx = 0; lIdx = numBins - 1; }

  fIdx = Math.max(0, fIdx - 1);
  lIdx = Math.min(numBins - 1, lIdx + 1);

  const origStep = (c.histHi - c.histLo) / numBins;
  const chartLo = Math.floor(c.histLo + fIdx * origStep);
  const chartHi = Math.ceil(c.histLo + (lIdx + 1) * origStep);
  const bins = rawBins.slice(fIdx, lIdx + 1);
  const activeNum = bins.length;
  const max = Math.max(1, ...bins);

  const W = 600, H = 105, chartBottom = 82, chartTop = 22;
  const maxBarH = chartBottom - chartTop;
  const bw = W / activeNum;
  const span = Math.max(1, chartHi - chartLo);

  const toX = v => Math.min(W - 6, Math.max(6, ((v - chartLo) / span) * W));
  const xP10 = toX(c.p10);
  const xP50 = toX(c.p50);
  const xP90 = toX(c.p90);

  const gradId = 'confGrad_' + Math.floor(Math.random() * 1e6);

  /* Build SVG points for smooth area density curve */
  const points = [[0, chartBottom]];
  bins.forEach((b, i) => {
    const x = (i + 0.5) * bw;
    const y = chartBottom - (b / max) * maxBarH;
    points.push([x, y]);
  });
  points.push([W, chartBottom]);

  let areaD = `M 0,${chartBottom} `;
  points.forEach((p, i) => {
    if (i === 0) return;
    const prev = points[i - 1];
    const cx = (prev[0] + p[0]) / 2;
    areaD += `C ${cx.toFixed(1)},${prev[1].toFixed(1)} ${cx.toFixed(1)},${p[1].toFixed(1)} ${p[0].toFixed(1)},${p[1].toFixed(1)} `;
  });
  areaD += `Z`;

  let barsHTML = bins.map((b, i) => {
    const bh = (b / max) * maxBarH;
    const x = i * bw + 1.5;
    const w = Math.max(1, bw - 3);
    const y = chartBottom - bh;
    const binCenterVal = chartLo + (i + 0.5) * (span / activeNum);
    const inRange = binCenterVal >= c.p10 && binCenterVal <= c.p90;
    const opacity = inRange ? '0.70' : '0.18';
    return `<rect class="hist-bar" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${bh.toFixed(1)}" rx="3" fill="${accent}" opacity="${opacity}" style="animation-delay:${i * 10}ms"/>`;
  }).join('');

  const rangeHTML = `<rect x="${xP10.toFixed(1)}" y="${chartBottom.toFixed(1)}" width="${Math.max(2, xP90 - xP10).toFixed(1)}" height="6" rx="3" fill="${accent}" opacity="0.45"/>`;

  const p10Line = `<line x1="${xP10.toFixed(1)}" y1="${chartTop}" x2="${xP10.toFixed(1)}" y2="${chartBottom + 6}" stroke="${accent}" stroke-width="1.5" stroke-dasharray="3,3" opacity="0.8"/>`;
  const p50Line = `<line x1="${xP50.toFixed(1)}" y1="${chartTop - 6}" x2="${xP50.toFixed(1)}" y2="${chartBottom + 6}" stroke="var(--text)" stroke-width="2.5"/><circle cx="${xP50.toFixed(1)}" cy="${chartTop - 6}" r="4" fill="var(--text)"/>`;
  const p90Line = `<line x1="${xP90.toFixed(1)}" y1="${chartTop}" x2="${xP90.toFixed(1)}" y2="${chartBottom + 6}" stroke="${accent}" stroke-width="1.5" stroke-dasharray="3,3" opacity="0.8"/>`;

  const baseline = `<line x1="0" y1="${chartBottom.toFixed(1)}" x2="${W}" y2="${chartBottom.toFixed(1)}" stroke="var(--border)" stroke-width="1"/>`;

  const svg = `<svg class="conf-chart-svg" viewBox="0 0 ${W} ${H}" width="100%" height="100" preserveAspectRatio="none">
    <defs>
      <linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${accent}" stop-opacity="0.32"/>
        <stop offset="100%" stop-color="${accent}" stop-opacity="0.02"/>
      </linearGradient>
    </defs>
    <path d="${areaD}" fill="url(#${gradId})"/>
    ${barsHTML}
    ${rangeHTML}
    ${baseline}
    ${p10Line}
    ${p50Line}
    ${p90Line}
  </svg>`;

  return { svg, chartLo, chartHi };
}

/* ═══ S2 — FLIGHT BOARD (key: flightboard) ══════════════════ */
function boardSortedFlights() {
  const order = { RED: 0, AMBER: 1, GREEN: 2 };
  /* completed (OFF_BLOCK) flights belong to the "Completed today" strip,
     not the active risk-sorted board — see completedTodayFlights(). */
  return getFlights().filter(f => f.status !== 'OFF_BLOCK').sort((a, b) => {
    const ca = a.calculation || calculateFlightRisk(a);
    const cb = b.calculation || calculateFlightRisk(b);
    const ra = order[ca ? ca.riskLevel : 'GREEN'] ?? 2, rb = order[cb ? cb.riskLevel : 'GREEN'] ?? 2;
    if (ra !== rb) return ra - rb;
    return new Date(a.eibt) - new Date(b.eibt);
  });
}

function ackAreaHtml(f) {
  const c = f.calculation || calculateFlightRisk(f);
  if (c.riskLevel === 'GREEN')
    return `<div class="ack-area green-normal"><span class="ack-done green-done">✓ Nominal Operations · Standard Turnaround</span></div>`;
  if (f.ackStatus === 'ACKNOWLEDGED')
    return `<div class="ack-area acked"><span class="ack-done">✓ Acknowledged ${hhmm(f.ackAt)} by ${escapeHtml(f.ackBy || '—')}</span></div>`;
  const al = getAlerts().find(a => a.id === f.alertId);
  const deadline = al ? alertAckDeadline(al) : new Date(c.calculatedAt || nowISO()).getTime() + ALERT_T[c.riskLevel || 'AMBER'].esc * 60000;
  return `<div class="ack-area">
      <div class="ack-strip">
        <span class="ack-req">ACKNOWLEDGE REQUIRED</span>
        <span class="ack-countdown mono" data-deadline="${deadline}">--:--</span>
      </div>
      <button class="btn btn-primary btn-sm ack-btn" data-ack="${f.id}" type="button">Acknowledge</button>
    </div>`;
}

function flightElapsedHtml(f, c) {
  if (f.status !== 'IN_BLOCK' || !f.actualInBlock) return '';
  const info = turnaroundElapsedInfo(f.actualInBlock, c.bufferMinutes);
  return `<div class="fl-awaiting fl-elapsed" data-since="${f.actualInBlock}" data-buffer="${c.bufferMinutes}">Turnaround in progress · elapsed <span class="mono" data-fe-val>${mmss(info.elapsedMs)}</span></div>`;
}

/* the S2 card's slot 3 — always renders SOMETHING, so the presence and
   spacing of this slot never depends on which state a given flight happens
   to be in: IN_BLOCK → the elapsed readout; otherwise (SCHEDULED) → a quiet
   neutral line, so the slot is never left empty. The card intentionally
   carries no separate data-quality warning box — risk state is already
   communicated by the red/amber/green risk chip, so a second colored box
   duplicating that signal was removed. */
function flightStatusSlotHtml(f, c) {
  const elapsed = flightElapsedHtml(f, c);
  if (elapsed) return `<div class="fl-status-slot">${elapsed}</div>`;
  return `<div class="fl-status-slot"><div class="fl-awaiting">Awaiting block-on · ETA ${hhmm(f.eibt)}</div></div>`;
}

function flightCardHtml(f) {
  const c = f.calculation || calculateFlightRisk(f);
  const level = c.riskLevel || 'GREEN';
  const inBlock = f.status === 'IN_BLOCK' && f.actualInBlock;
  const metaTime = inBlock ? `Blocked on ${hhmm(f.actualInBlock)}` : `ETA ${hhmm(f.eibt)}`;
  return `<article class="fl-card r-${level}" data-flight="${f.id}" style="--accent:${riskColor(level)}">
    <div class="fl-body">
      <div class="fl-top">
        <div class="fl-id"><span class="fl-num mono">${escapeHtml(f.flightNumber)}</span>
          <span class="fl-meta">${formatStand(f.stand)} · ${escapeHtml(f.aircraftType)} · ${metaTime}</span></div>
        ${riskChip(level)}
      </div>
      ${flightStatusSlotHtml(f, c)}
      <div class="fl-nums">
        <div class="fl-num-block"><span class="nb-label">BUFFER</span><span class="nb-val mono">${c.bufferMinutes} min</span></div>
        <div class="fl-num-block"><span class="nb-label">TOBT</span><span class="nb-val mono accent">${hhmm(c.tobt)}</span></div>
      </div>
      <div class="fl-driver">Driver · <strong>${escapeHtml(c.dominantVariable || 'Heat Index')} ${escapeHtml(rawValueLabel(f, c.dominantIndex != null ? c.dominantIndex : 0))}</strong></div>
    </div>
    ${ackAreaHtml(f)}
  </article>`;
}

function completedCardHtml(f) {
  const c = f.calculation || calculateFlightRisk(f);
  const outcome = getOutcomes().find(o => o.flightId === f.id);
  const err = outcome ? outcome.error : (f.actualOffBlock ? minutesBetween(f.actualOffBlock, c.tobt) : null);
  return `<article class="fl-card completed" data-flight="${f.id}">
    <div class="fl-top">
      <div class="fl-id"><span class="fl-num mono">${escapeHtml(f.flightNumber)}</span>
        <span class="fl-meta">${formatStand(f.stand)} · ${escapeHtml(f.aircraftType)}</span></div>
      <span class="badge b-suspended"><span class="dot"></span>DEPARTED</span>
    </div>
    <div class="fl-nums">
      <div class="fl-num-block"><span class="nb-label">BLOCKED ON</span><span class="nb-val mono">${hhmm(f.actualInBlock)}</span></div>
      <div class="fl-num-block"><span class="nb-label">BLOCKED OFF</span><span class="nb-val mono">${hhmm(f.actualOffBlock)}</span></div>
    </div>
    ${err != null ? `<div class="fl-driver">Off-block variance · <span class="orc-err ${errorClass(err)}">${fmtSigned(Math.round(err))} min</span></div>` : ''}
  </article>`;
}

function completedTodayFlights() {
  return getFlights().filter(f => f.status === 'OFF_BLOCK' && isSameDay(f.actualOffBlock))
    .sort((a, b) => new Date(b.actualOffBlock) - new Date(a.actualOffBlock));
}

function renderFlightBoard(el) {
  const flights = boardSortedFlights();
  const counts = { RED: 0, AMBER: 0, GREEN: 0 };
  flights.forEach(f => {
    const c = f.calculation || calculateFlightRisk(f);
    counts[c.riskLevel || 'GREEN']++;
  });
  const completed = completedTodayFlights();
  el.innerHTML = `
    <div class="board-col">
      <div class="mod-head">
        <div><h1 class="mod-title">Flight Board</h1>
          <p class="mod-sub">${flights.length} turnarounds · sorted by risk</p></div>
        <div class="board-legend">
          <span class="lg r-RED">${counts.RED} RED</span>
          <span class="lg r-AMBER">${counts.AMBER} AMBER</span>
          <span class="lg r-GREEN">${counts.GREEN} GREEN</span>
        </div>
      </div>
      <div class="fl-list" id="fl-list">
        ${flights.map((f, i) => flightCardHtml(f)).join('')}
      </div>

      ${completed.length ? `
      <section class="card audit-card completed-section">
        <button class="audit-toggle" id="completed-toggle" type="button">
          <span>${completed.length} completed today</span><span class="au-chev">▸</span></button>
        <div class="audit-body" id="completed-body" hidden>
          <div class="fl-list" id="completed-list">${completed.map(f => completedCardHtml(f)).join('')}</div>
        </div>
      </section>` : ''}
    </div>`;
  const list = el.querySelector('#fl-list');
  [...list.children].forEach((card, i) => { card.style.animationDelay = (i * 40) + 'ms'; card.classList.add('stagger'); });

  list.onclick = e => {
    const ackBtn = e.target.closest('[data-ack]');
    if (ackBtn) { e.stopPropagation(); handleBoardAck(ackBtn.dataset.ack); return; }
    const card = e.target.closest('[data-flight]');
    if (card) openTurnaround(card.dataset.flight);
  };

  const completedToggle = el.querySelector('#completed-toggle');
  if (completedToggle) {
    completedToggle.onclick = () => {
      const body = el.querySelector('#completed-body');
      body.hidden = !body.hidden;
      completedToggle.classList.toggle('open', !body.hidden);
    };
  }

  tickBoardCountdowns();
  tickBoardElapsed();
}

/* live-refresh every in-progress turnaround's elapsed readout, matching the
   per-second style of tickBoardCountdowns() above */
function tickBoardElapsed() {
  document.querySelectorAll('.fl-elapsed[data-since]').forEach(box => {
    const info = turnaroundElapsedInfo(box.dataset.since, Number(box.dataset.buffer));
    const val = box.querySelector('[data-fe-val]'); if (val) val.textContent = mmss(info.elapsedMs);
  });
}

function handleBoardAck(flightId) {
  acknowledgeAlert(flightId, currentActor());
  const f = getFlight(flightId);
  const c = f.calculation || calculateFlightRisk(f);
  const card = document.querySelector(`.fl-card[data-flight="${flightId}"]`);
  if (card) {
    const area = card.querySelector('.ack-area');
    if (area) {
      area.classList.add('acked', 'ack-animate');
      area.innerHTML = `<span class="ack-done">✓ Acknowledged ${hhmm(f.ackAt)} by ${escapeHtml(f.ackBy)}</span>`;
    }
  }
  showToast(`${f.flightNumber} — ${c.riskLevel} alert acknowledged`, 'success');
}

/* live countdown ticker (driven by alertEngine) */
function tickBoardCountdowns() {
  const now = Date.now();
  document.querySelectorAll('.ack-countdown[data-deadline]').forEach(el => {
    let deadline = Number(el.dataset.deadline);
    let remaining = deadline - now;
    if (isNaN(remaining) || remaining < -120000) {
      deadline = now + 180000;
      el.dataset.deadline = deadline;
      remaining = 180000;
    }
    el.textContent = remaining <= 0 ? 'OVERDUE' : mmss(remaining);
    el.classList.toggle('warn', remaining <= 60000 && remaining > 30000);
    el.classList.toggle('pulse', remaining <= 30000);
    el.classList.toggle('over', remaining <= 0);
  });
}

function openTurnaround(flightId) { selectedFlightId = flightId; showModule('turnaround'); }

const AIRCRAFT_SPECS = {
  'Airbus A320': {
    seating: 180, loadPct: 88, pax: 158, mtbfProb: 0.22, gseTotal: 6, gseAvail: 5, prm: 3,
    cat: 'Narrowbody Regional', turnMinutes: 45
  },
  'Airbus A321': {
    seating: 220, loadPct: 90, pax: 198, mtbfProb: 0.25, gseTotal: 7, gseAvail: 5, prm: 4,
    cat: 'High-Density Narrowbody', turnMinutes: 50
  },
  'Boeing 737-800': {
    seating: 186, loadPct: 85, pax: 158, mtbfProb: 0.20, gseTotal: 6, gseAvail: 5, prm: 3,
    cat: 'Narrowbody International', turnMinutes: 45
  },
  'Boeing 777-200ER': {
    seating: 280, loadPct: 92, pax: 258, mtbfProb: 0.45, gseTotal: 12, gseAvail: 4, prm: 7,
    cat: 'Widebody Long-Haul', turnMinutes: 75
  },
  'Boeing 777-300ER': {
    seating: 358, loadPct: 94, pax: 336, mtbfProb: 0.48, gseTotal: 14, gseAvail: 4, prm: 9,
    cat: 'Widebody Long-Haul Heavy', turnMinutes: 90
  },
  'Boeing 787 Dreamliner': {
    seating: 290, loadPct: 89, pax: 258, mtbfProb: 0.30, gseTotal: 10, gseAvail: 8, prm: 5,
    cat: 'Composite Widebody', turnMinutes: 65
  },
  'Airbus A330-300': {
    seating: 290, loadPct: 88, pax: 255, mtbfProb: 0.35, gseTotal: 10, gseAvail: 7, prm: 6,
    cat: 'Widebody Medium-Haul', turnMinutes: 70
  },
  'Boeing 747-400 (Hajj Peak)': {
    seating: 416, loadPct: 96, pax: 400, mtbfProb: 0.58, gseTotal: 16, gseAvail: 3, prm: 14,
    cat: 'Super Heavy Hajj Charter', turnMinutes: 105
  }
};

/* ═══════════════════════════════════════════════════════════
   LOADSHEET REFERENCE DATA — per-aircraft-type constants only.
   Not user-editable from this module; the numbers below are internally
   consistent (MZFW < MLW < MTOW, envelopes narrow with weight, bigger
   aircraft get smaller per-unit index effects) but are NOT real certified
   Airbus/Boeing weight-and-balance figures — this is a demo dataset.
   ═══════════════════════════════════════════════════════════ */

/* standard IATA per-passenger weights used to convert headcount → kg */
const LS_STD_PAX_WEIGHT_KG = 84;
const LS_STD_INFANT_WEIGHT_KG = 10;

/* CG envelope: a 6-point banana polygon that narrows as weight rises from
   a low reference weight (55% of MZFW) up to MTOW — same shape recipe for
   every type, scaled by that type's own MZFW/MTOW so each envelope stays
   proportioned to its aircraft. mac units = %MAC (arbitrary but consistent
   scale calibrated by macIndexRange below), weightKg = kg. */
function buildLsEnvelope(mzfw, mtow) {
  const wLow = Math.round(mzfw * 0.55);
  return [
    { mac: 14, weightKg: wLow }, { mac: 17, weightKg: mzfw }, { mac: 21, weightKg: mtow },
    { mac: 28, weightKg: mtow }, { mac: 31, weightKg: mzfw }, { mac: 34, weightKg: wLow }
  ];
}

/* Dry-Operating-Weight index formula constant K, derived (not hand-typed
   per type) so that a typical DOW loading centres on a stylised baseline
   index of 55 with H-arm fixed at 1000 (an abstract reference datum in cm,
   identical for every type) — only K and each type's own DOW move the
   live-computed result away from that baseline once real data is entered. */
function lsIndexConstant(dow, hArm, baselineIndex) {
  return hArm - (baselineIndex - 100) * 2500 / dow;
}

const AIRCRAFT_LS_REF = {};
(function buildAircraftLsRef() {
  const DEF_HARM = 1000;
  const defs = [
    {
      type: 'Airbus A320', mzfw: 62500, mtow: 78000, mlw: 66000,
      dowDefault: { basicWeight: 42000, crewWeight: 600, pantryWeight: 700 },
      fuelDefault: { takeoffFuel: 8000, tripFuel: 6000 },
      fuelIndexPer1000: 0.045, pitchTrim: { neutralMac: 25, degPerMacUnit: 0.45 },
      basicIndexCorrection: { plus100: { E: -0.35, F: -0.18, G: 0.16, H: 0.38 }, minus100: { E: 0.35, F: 0.18, G: -0.16, H: -0.38 } },
      cabinZones: [
        { code: 'OA', label: 'Cabin OA (Fwd)', rowRange: '1-6', seatCount: 36, indexPerPax: -0.028 },
        { code: 'OB', label: 'Cabin OB (Mid)', rowRange: '7-18', seatCount: 72, indexPerPax: 0.008 },
        { code: 'OC', label: 'Cabin OC (Aft)', rowRange: '19-30', seatCount: 72, indexPerPax: 0.045 }
      ],
      cargoHolds: [
        { code: '1', label: 'Cargo 1 (Fwd)', capacityKg: 2000, indexPerKg: -0.0028 },
        { code: '2', label: 'Cargo 2 (Aft)', capacityKg: 2300, indexPerKg: 0.0032 }
      ]
    },
    {
      type: 'Airbus A321', mzfw: 68000, mtow: 89000, mlw: 77800,
      dowDefault: { basicWeight: 45500, crewWeight: 700, pantryWeight: 800 },
      fuelDefault: { takeoffFuel: 9500, tripFuel: 7200 },
      fuelIndexPer1000: 0.040, pitchTrim: { neutralMac: 25, degPerMacUnit: 0.42 },
      basicIndexCorrection: { plus100: { E: -0.32, F: -0.16, G: 0.15, H: 0.34 }, minus100: { E: 0.32, F: 0.16, G: -0.15, H: -0.34 } },
      cabinZones: [
        { code: 'OA', label: 'Cabin OA (Fwd)', rowRange: '1-7', seatCount: 42, indexPerPax: -0.026 },
        { code: 'OB', label: 'Cabin OB (Mid)', rowRange: '8-21', seatCount: 84, indexPerPax: 0.007 },
        { code: 'OC', label: 'Cabin OC (Aft)', rowRange: '22-36', seatCount: 94, indexPerPax: 0.041 }
      ],
      cargoHolds: [
        { code: '1', label: 'Cargo 1 (Fwd)', capacityKg: 2400, indexPerKg: -0.0026 },
        { code: '2', label: 'Cargo 2 (Aft)', capacityKg: 2600, indexPerKg: 0.0030 }
      ]
    },
    {
      type: 'Boeing 737-800', mzfw: 60000, mtow: 79000, mlw: 66300,
      dowDefault: { basicWeight: 41000, crewWeight: 600, pantryWeight: 650 },
      fuelDefault: { takeoffFuel: 8200, tripFuel: 6100 },
      fuelIndexPer1000: 0.048, pitchTrim: { neutralMac: 25, degPerMacUnit: 0.47 },
      basicIndexCorrection: { plus100: { E: -0.36, F: -0.19, G: 0.17, H: 0.40 }, minus100: { E: 0.36, F: 0.19, G: -0.17, H: -0.40 } },
      cabinZones: [
        { code: 'OA', label: 'Cabin OA (Fwd)', rowRange: '1-6', seatCount: 36, indexPerPax: -0.030 },
        { code: 'OB', label: 'Cabin OB (Mid)', rowRange: '7-19', seatCount: 78, indexPerPax: 0.009 },
        { code: 'OC', label: 'Cabin OC (Aft)', rowRange: '20-31', seatCount: 72, indexPerPax: 0.044 }
      ],
      cargoHolds: [
        { code: '1', label: 'Cargo 1 (Fwd)', capacityKg: 2100, indexPerKg: -0.0030 },
        { code: '2', label: 'Cargo 2 (Aft)', capacityKg: 2300, indexPerKg: 0.0034 }
      ]
    },
    {
      type: 'Boeing 777-200ER', mzfw: 195000, mtow: 297500, mlw: 213000,
      dowDefault: { basicWeight: 138000, crewWeight: 1200, pantryWeight: 3000 },
      fuelDefault: { takeoffFuel: 45000, tripFuel: 38000 },
      fuelIndexPer1000: 0.015, pitchTrim: { neutralMac: 25, degPerMacUnit: 0.26 },
      basicIndexCorrection: { plus100: { E: -0.11, F: -0.06, G: 0.05, H: 0.12 }, minus100: { E: 0.11, F: 0.06, G: -0.05, H: -0.12 } },
      cabinZones: [
        { code: 'OA', label: 'Cabin OA (Fwd)', rowRange: '1-10', seatCount: 60, indexPerPax: -0.010 },
        { code: 'OB', label: 'Cabin OB (Mid)', rowRange: '11-30', seatCount: 150, indexPerPax: 0.003 },
        { code: 'OC', label: 'Cabin OC (Aft)', rowRange: '31-40', seatCount: 70, indexPerPax: 0.014 }
      ],
      cargoHolds: [
        { code: '1', label: 'Cargo 1 (Fwd)', capacityKg: 5000, indexPerKg: -0.0012 },
        { code: '2', label: 'Cargo 2 (Fwd)', capacityKg: 4500, indexPerKg: -0.0007 },
        { code: '3', label: 'Cargo 3 (Aft)', capacityKg: 4800, indexPerKg: 0.0006 },
        { code: '4', label: 'Cargo 4 (Aft)', capacityKg: 4200, indexPerKg: 0.0010 },
        { code: '5', label: 'Cargo 5 (Bulk Aft)', capacityKg: 1500, indexPerKg: 0.0016 }
      ]
    },
    {
      type: 'Boeing 777-300ER', mzfw: 237500, mtow: 351500, mlw: 251000,
      dowDefault: { basicWeight: 168000, crewWeight: 1400, pantryWeight: 3500 },
      fuelDefault: { takeoffFuel: 52000, tripFuel: 44000 },
      fuelIndexPer1000: 0.013, pitchTrim: { neutralMac: 25, degPerMacUnit: 0.22 },
      basicIndexCorrection: { plus100: { E: -0.09, F: -0.05, G: 0.05, H: 0.10 }, minus100: { E: 0.09, F: 0.05, G: -0.05, H: -0.10 } },
      cabinZones: [
        { code: 'OA', label: 'Cabin OA (Fwd)', rowRange: '1-12', seatCount: 80, indexPerPax: -0.008 },
        { code: 'OB', label: 'Cabin OB (Mid)', rowRange: '13-38', seatCount: 190, indexPerPax: 0.002 },
        { code: 'OC', label: 'Cabin OC (Aft)', rowRange: '39-50', seatCount: 88, indexPerPax: 0.011 }
      ],
      cargoHolds: [
        { code: '1', label: 'Cargo 1 (Fwd)', capacityKg: 6000, indexPerKg: -0.0009 },
        { code: '2', label: 'Cargo 2 (Fwd)', capacityKg: 5500, indexPerKg: -0.0005 },
        { code: '3', label: 'Cargo 3 (Aft)', capacityKg: 5800, indexPerKg: 0.0005 },
        { code: '4', label: 'Cargo 4 (Aft)', capacityKg: 5000, indexPerKg: 0.0008 },
        { code: '5', label: 'Cargo 5 (Bulk Aft)', capacityKg: 1800, indexPerKg: 0.0013 }
      ]
    },
    {
      type: 'Boeing 787 Dreamliner', mzfw: 161000, mtow: 227900, mlw: 172000,
      dowDefault: { basicWeight: 120000, crewWeight: 1100, pantryWeight: 2500 },
      fuelDefault: { takeoffFuel: 35000, tripFuel: 29000 },
      fuelIndexPer1000: 0.017, pitchTrim: { neutralMac: 25, degPerMacUnit: 0.30 },
      basicIndexCorrection: { plus100: { E: -0.13, F: -0.07, G: 0.06, H: 0.14 }, minus100: { E: 0.13, F: 0.07, G: -0.06, H: -0.14 } },
      cabinZones: [
        { code: 'OA', label: 'Cabin OA (Fwd)', rowRange: '1-9', seatCount: 60, indexPerPax: -0.012 },
        { code: 'OB', label: 'Cabin OB (Mid)', rowRange: '10-27', seatCount: 160, indexPerPax: 0.004 },
        { code: 'OC', label: 'Cabin OC (Aft)', rowRange: '28-36', seatCount: 70, indexPerPax: 0.016 }
      ],
      cargoHolds: [
        { code: '1', label: 'Cargo 1 (Fwd)', capacityKg: 4200, indexPerKg: -0.0011 },
        { code: '2', label: 'Cargo 2 (Fwd)', capacityKg: 4000, indexPerKg: -0.0004 },
        { code: '3', label: 'Cargo 3 (Aft)', capacityKg: 4300, indexPerKg: 0.0006 },
        { code: '4', label: 'Cargo 4 (Bulk Aft)', capacityKg: 1600, indexPerKg: 0.0014 }
      ]
    },
    {
      type: 'Airbus A330-300', mzfw: 170000, mtow: 242000, mlw: 187000,
      dowDefault: { basicWeight: 122000, crewWeight: 1100, pantryWeight: 2600 },
      fuelDefault: { takeoffFuel: 38000, tripFuel: 31000 },
      fuelIndexPer1000: 0.016, pitchTrim: { neutralMac: 25, degPerMacUnit: 0.31 },
      basicIndexCorrection: { plus100: { E: -0.12, F: -0.06, G: 0.06, H: 0.13 }, minus100: { E: 0.12, F: 0.06, G: -0.06, H: -0.13 } },
      cabinZones: [
        { code: 'OA', label: 'Cabin OA (Fwd)', rowRange: '1-9', seatCount: 58, indexPerPax: -0.011 },
        { code: 'OB', label: 'Cabin OB (Mid)', rowRange: '10-28', seatCount: 162, indexPerPax: 0.004 },
        { code: 'OC', label: 'Cabin OC (Aft)', rowRange: '29-38', seatCount: 70, indexPerPax: 0.015 }
      ],
      cargoHolds: [
        { code: '1', label: 'Cargo 1 (Fwd)', capacityKg: 4300, indexPerKg: -0.0010 },
        { code: '2', label: 'Cargo 2 (Fwd)', capacityKg: 4100, indexPerKg: -0.0004 },
        { code: '3', label: 'Cargo 3 (Aft)', capacityKg: 4400, indexPerKg: 0.0006 },
        { code: '4', label: 'Cargo 4 (Bulk Aft)', capacityKg: 1700, indexPerKg: 0.0013 }
      ]
    },
    {
      type: 'Boeing 747-400 (Hajj Peak)', mzfw: 242000, mtow: 396890, mlw: 285760,
      dowDefault: { basicWeight: 180000, crewWeight: 1800, pantryWeight: 4500 },
      fuelDefault: { takeoffFuel: 60000, tripFuel: 50000 },
      fuelIndexPer1000: 0.010, pitchTrim: { neutralMac: 25, degPerMacUnit: 0.18 },
      basicIndexCorrection: { plus100: { E: -0.08, F: -0.04, G: 0.04, H: 0.09 }, minus100: { E: 0.08, F: 0.04, G: -0.04, H: -0.09 } },
      cabinZones: [
        { code: 'OA', label: 'Cabin OA (Fwd)', rowRange: '1-14', seatCount: 90, indexPerPax: -0.007 },
        { code: 'OB', label: 'Cabin OB (Mid)', rowRange: '15-45', seatCount: 230, indexPerPax: 0.002 },
        { code: 'OC', label: 'Cabin OC (Aft)', rowRange: '46-60', seatCount: 96, indexPerPax: 0.010 }
      ],
      cargoHolds: [
        { code: '1', label: 'Cargo 1 (Fwd)', capacityKg: 7000, indexPerKg: -0.0007 },
        { code: '2', label: 'Cargo 2 (Fwd)', capacityKg: 6500, indexPerKg: -0.0004 },
        { code: '3', label: 'Cargo 3 (Aft)', capacityKg: 6800, indexPerKg: 0.0004 },
        { code: '4', label: 'Cargo 4 (Aft)', capacityKg: 6000, indexPerKg: 0.0006 },
        { code: '5', label: 'Cargo 5 (Bulk Aft)', capacityKg: 2200, indexPerKg: 0.0010 }
      ]
    }
  ];
  defs.forEach(d => {
    const dow = d.dowDefault.basicWeight + d.dowDefault.crewWeight + d.dowDefault.pantryWeight;
    AIRCRAFT_LS_REF[d.type] = {
      mzfw: d.mzfw, mtow: d.mtow, mlw: d.mlw,
      dowHArmDefault: DEF_HARM,
      indexConstant: +lsIndexConstant(dow, DEF_HARM, 55).toFixed(2),
      dowDefault: d.dowDefault, fuelDefault: d.fuelDefault,
      fuelIndexPer1000: d.fuelIndexPer1000,
      macIndexRange: { idxLo: 20, idxHi: 100, macLo: 10, macHi: 38 },
      pitchTrim: d.pitchTrim,
      basicIndexCorrection: d.basicIndexCorrection,
      cabinZones: d.cabinZones, cargoHolds: d.cargoHolds,
      envelope: buildLsEnvelope(d.mzfw, d.mtow)
    };
  });
})();
function lsRefFor(acType) { return AIRCRAFT_LS_REF[acType] || AIRCRAFT_LS_REF['Airbus A320']; }

/* ═══════════════════════════════════════════════════════════
   LOADSHEET CALCULATION ENGINE — pure functions, no DOM access.
   Mirrors ENGINE's discipline: every figure below is derived live from
   whatever is currently stored on the loadsheet record; nothing here is
   ever a hardcoded output.
   ═══════════════════════════════════════════════════════════ */
function lsSum(arr) { return (arr || []).reduce((a, b) => a + (Number(b) || 0), 0); }

function computeWeightTotals(ls) {
  const wb = ls.weightBuildup;
  const dryOperatingWeight = (Number(wb.basicWeight) || 0) + (Number(wb.crewWeight) || 0) + (Number(wb.pantryWeight) || 0);
  const takeoffFuel = Number(wb.takeoffFuel) || 0, tripFuel = Number(wb.tripFuel) || 0;
  const operatingWeight = dryOperatingWeight + takeoffFuel;

  const a = (Number(wb.maxZeroFuelWeight) || 0) - dryOperatingWeight;
  const b = (Number(wb.maxTakeoffWeight) || 0) - dryOperatingWeight - takeoffFuel;
  const c = (Number(wb.maxLandingWeight) || 0) - dryOperatingWeight - (takeoffFuel - tripFuel);
  const constraints = { a, b, c };
  const bindingKey = a <= b && a <= c ? 'a' : (b <= c ? 'b' : 'c');
  const bindingLabel = { a: 'Max Zero Fuel Weight', b: 'Max Take-off Weight', c: 'Max Landing Weight' }[bindingKey];
  const minAbc = Math.min(a, b, c);
  /* "Allowed Weight for Takeoff" is a genuine takeoff-weight-scale ceiling
     (matches the paper form's box, and the Maximum Weights fields above
     it) — a/b/c above are each already net of DOW+fuel, so operating
     weight is added back once here, then subtracted once below; the two
     cancel to leave allowedTrafficLoad = min(a,b,c) exactly. */
  const allowedWeightForTakeoff = minAbc + operatingWeight;
  const allowedTrafficLoad = allowedWeightForTakeoff - operatingWeight;

  const destinations = ls.destinations || [];
  let totalPassengerWeight = 0, totalPassengers = 0, cabBagSum = 0, distSum = 0;
  destinations.forEach(d => {
    const p = d.pax || {};
    const adults = (Number(p.male) || 0) + (Number(p.female) || 0) + (Number(p.child) || 0);
    const infants = Number(p.infant) || 0;
    totalPassengerWeight += adults * LS_STD_PAX_WEIGHT_KG + infants * LS_STD_INFANT_WEIGHT_KG;
    totalPassengers += adults + infants;
    cabBagSum += Number(d.cabBag) || 0;
    distSum += lsSum(d.distributionWeights);
  });
  const totalTrafficLoad = totalPassengerWeight + cabBagSum + distSum;
  const lmcTotal = lsSum((ls.lastMinuteChanges || []).map(x => x.weightDelta));

  const zeroFuelWeight = dryOperatingWeight + totalTrafficLoad + lmcTotal;
  const underloadBeforeLMC = allowedTrafficLoad - totalTrafficLoad;
  const takeoffWeight = zeroFuelWeight + takeoffFuel;
  const landingWeight = takeoffWeight - tripFuel;

  const exceedances = [];
  if (totalTrafficLoad + lmcTotal > allowedTrafficLoad) exceedances.push({ field: 'totalTrafficLoad', message: `Traffic load exceeds Allowed Traffic Load by ${Math.round(totalTrafficLoad + lmcTotal - allowedTrafficLoad)} kg` });
  if (zeroFuelWeight > (Number(wb.maxZeroFuelWeight) || 0)) exceedances.push({ field: 'zeroFuelWeight', message: `Zero Fuel Weight exceeds MZFW by ${Math.round(zeroFuelWeight - wb.maxZeroFuelWeight)} kg` });
  if (takeoffWeight > (Number(wb.maxTakeoffWeight) || 0)) exceedances.push({ field: 'takeoffWeight', message: `Take-off Weight exceeds MTOW by ${Math.round(takeoffWeight - wb.maxTakeoffWeight)} kg` });
  if (landingWeight > (Number(wb.maxLandingWeight) || 0)) exceedances.push({ field: 'landingWeight', message: `Landing Weight exceeds MLW by ${Math.round(landingWeight - wb.maxLandingWeight)} kg` });

  return {
    dryOperatingWeight, operatingWeight, allowedWeightForTakeoff, allowedTrafficLoad,
    binding: bindingKey, bindingLabel, constraints,
    totalPassengerWeight, totalPassengers, totalTrafficLoad, lmcTotal,
    zeroFuelWeight, underloadBeforeLMC, takeoffWeight, landingWeight,
    exceedances, valid: exceedances.length === 0
  };
}

/* physical hold/zone view derived live from Tab 1's own entered data — the
   6 numbered distribution-weight columns map onto this type's cargo holds
   in order, any columns beyond the hold count (or cab baggage) fold into
   the last (aft-most) hold; cabin zone pax/weight split proportionally to
   each zone's share of total seating, using the exact same passenger
   weight total Tab 1 already computed (no independent re-derivation) */
function deriveLsZones(ls, ref, weightTotals) {
  const destinations = ls.destinations || [];
  const distTotals = new Array(6).fill(0);
  destinations.forEach(d => (d.distributionWeights || []).forEach((w, i) => { distTotals[i] += Number(w) || 0; }));
  const cabBagSum = destinations.reduce((a, d) => a + (Number(d.cabBag) || 0), 0);

  const holds = ref.cargoHolds;
  const holdWeights = holds.map(() => 0);
  distTotals.forEach((w, i) => { const idx = Math.min(i, holds.length - 1); holdWeights[idx] += w; });
  holdWeights[holds.length - 1] += cabBagSum;

  const totalSeats = ref.cabinZones.reduce((a, z) => a + z.seatCount, 0) || 1;
  const totalPax = weightTotals.totalPassengers;
  const totalPaxWeight = weightTotals.totalPassengerWeight;
  let paxAssigned = 0;
  const cabinRows = ref.cabinZones.map((z, i) => {
    const isLast = i === ref.cabinZones.length - 1;
    const share = z.seatCount / totalSeats;
    const paxCount = isLast ? Math.max(0, totalPax - paxAssigned) : Math.round(totalPax * share);
    paxAssigned += paxCount;
    const weightKg = +(totalPaxWeight * share).toFixed(1);
    return { code: z.code, label: z.label, kind: 'CABIN', capacityKg: null, paxCount, weightKg, indexUnit: +(paxCount * z.indexPerPax).toFixed(2) };
  });
  const cargoRows = holds.map((h, i) => ({
    code: h.code, label: h.label, kind: 'CARGO', capacityKg: h.capacityKg, paxCount: null,
    weightKg: +holdWeights[i].toFixed(1), indexUnit: +(holdWeights[i] * h.indexPerKg).toFixed(2)
  }));
  return [...cargoRows, ...cabinRows];
}

/* linear point-in-polygon (ray casting) — used to test whether a
   (%MAC, weightKg) point sits inside the aircraft's certified-shaped
   envelope polygon */
function lsPointInPolygon(mac, weightKg, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].mac, yi = polygon[i].weightKg;
    const xj = polygon[j].mac, yj = polygon[j].weightKg;
    const intersects = ((yi > weightKg) !== (yj > weightKg)) &&
      (mac < (xj - xi) * (weightKg - yi) / (yj - yi) + xi);
    if (intersects) inside = !inside;
  }
  return inside;
}

function computeLoadAndTrim(ls, ref) {
  const wt = computeWeightTotals(ls);
  const lt = ls.loadAndTrim || {};
  const hArm = Number(lt.dryOperatingWeightHArm) || ref.dowHArmDefault;
  const dryOperatingWeightIndex = ((hArm - ref.indexConstant) * wt.dryOperatingWeight / 2500) + 100;

  const dev = lt.weightDeviation || { E: 0, F: 0, G: 0, H: 0 };
  let deviationCorrection = 0;
  ['E', 'F', 'G', 'H'].forEach(zone => {
    const d = Number(dev[zone]) || 0;
    const table = d >= 0 ? ref.basicIndexCorrection.plus100 : ref.basicIndexCorrection.minus100;
    deviationCorrection += (d / 100) * table[zone];
  });
  const correctedIndex = dryOperatingWeightIndex + deviationCorrection;

  const zones = deriveLsZones(ls, ref, wt);
  const deadLoadIndex = zones.reduce((a, z) => a + z.indexUnit, 0);
  const loadedIndexZFW = correctedIndex + deadLoadIndex;

  const takeoffFuel = Number(ls.weightBuildup.takeoffFuel) || 0;
  const fuelIndex = (takeoffFuel / 1000) * ref.fuelIndexPer1000;
  const loadedIndexTOW = loadedIndexZFW + fuelIndex;

  const { idxLo, idxHi, macLo, macHi } = ref.macIndexRange;
  const idxToMac = idx => macLo + (idx - idxLo) / (idxHi - idxLo) * (macHi - macLo);
  const cgPercentMacZFW = +idxToMac(loadedIndexZFW).toFixed(2);
  const cgPercentMacTakeoff = +idxToMac(loadedIndexTOW).toFixed(2);

  const zfwInEnvelope = lsPointInPolygon(cgPercentMacZFW, wt.zeroFuelWeight, ref.envelope);
  const towInEnvelope = lsPointInPolygon(cgPercentMacTakeoff, wt.takeoffWeight, ref.envelope);

  const neutral = ref.pitchTrim.neutralMac;
  const diff = cgPercentMacTakeoff - neutral;
  const pitchTrimDegrees = +Math.abs(diff * ref.pitchTrim.degPerMacUnit).toFixed(2);
  const pitchTrimDirection = diff > 0.1 ? 'UP' : diff < -0.1 ? 'DOWN' : 'CONSTANT';

  return {
    dryOperatingWeightHArm: hArm, dryOperatingWeightIndex: +dryOperatingWeightIndex.toFixed(2),
    weightDeviation: dev, deviationCorrection: +deviationCorrection.toFixed(2), correctedIndex: +correctedIndex.toFixed(2),
    zones, deadLoadIndex: +deadLoadIndex.toFixed(2), loadedIndexZFW: +loadedIndexZFW.toFixed(2),
    fuelIndex: +fuelIndex.toFixed(2), loadedIndexTOW: +loadedIndexTOW.toFixed(2),
    cgPercentMacZFW, cgPercentMacTakeoff, zfwInEnvelope, towInEnvelope,
    pitchTrimDegrees, pitchTrimDirection
  };
}

/* combined validity check driving Approve-blocking (Part D) */
function lsValidate(ls, ref) {
  const wt = computeWeightTotals(ls);
  const lat = computeLoadAndTrim(ls, ref);
  const issues = wt.exceedances.map(x => x.message);
  if (!lat.zfwInEnvelope) issues.push(`Zero Fuel Weight CG (${lat.cgPercentMacZFW}% MAC) falls outside the certified envelope`);
  if (!lat.towInEnvelope) issues.push(`Take-off CG (${lat.cgPercentMacTakeoff}% MAC) falls outside the certified envelope`);
  return { ok: issues.length === 0, issues, weightTotals: wt, loadAndTrim: lat };
}

/* ═══ S3 — TURNAROUND DETAIL (key: turnaround) ══════════════ */
function renderTurnaround(el) {
  let f = selectedFlightId ? getFlight(selectedFlightId) : null;
  if (!f) { f = boardSortedFlights()[0]; selectedFlightId = f ? f.id : null; }
  if (!f) { el.innerHTML = emptyState('No flights', 'There are no turnarounds to inspect yet.'); return; }
  if (!f.calculation || !f.calculation.shares || !f.calculation.histBins || !f.calculation.normalisedVector) {
    f.calculation = calculateFlightRisk(f);
    updateFlight(f.id, { calculation: f.calculation });
  }
  const c = f.calculation;
  const level = c.riskLevel || 'GREEN', accent = riskColor(level);
  const spec = AIRCRAFT_SPECS[f.aircraftType] || AIRCRAFT_SPECS['Airbus A320'];

  /* gauge geometry */
  const R = 62, CIRC = 2 * Math.PI * R;
  const histHi = c.histHi || 50, histLo = c.histLo || 25;
  const gfrac = Math.min(1, c.bufferMinutes / histHi);
  /* confidence band scaled to [histLo, histHi] */
  const span = histHi - histLo;
  const pos = v => span > 0 ? ((v - histLo) / span) * 100 : 50;

  /* contribution rows sorted desc by share */
  const rows = ENGINE.VAR_NAMES.map((name, idx) => ({
    idx, name, share: c.shares[idx], norm: c.normalisedVector[idx], raw: rawValueLabel(f, idx)
  })).sort((a, b) => b.share - a.share);

  const actions = lookupActions(level, c.dominantVariable);
  const ticks = f.actionTicks || [];
  const confChart = renderConfidenceChart(c, accent);

  /* live elapsed-vs-buffer readout — sits inside the gauge card so the
     prediction and reality are directly next to each other (Part C) */
  let gaugeElapsedHtml = '';
  let gaugeOverBuffer = false;
  if (f.status === 'IN_BLOCK' && f.actualInBlock) {
    const info = turnaroundElapsedInfo(f.actualInBlock, c.bufferMinutes);
    gaugeOverBuffer = info.state === 'over';
    gaugeElapsedHtml = `<div class="gauge-elapsed ge-${info.state}" data-since="${f.actualInBlock}" data-buffer="${c.bufferMinutes}">
      <span class="ge-label">ELAPSED SINCE BLOCK-ON</span>
      <span class="ge-time mono" data-ge-val>${mmss(info.elapsedMs)}</span>
      <span class="ge-note" data-ge-note>${info.state === 'over' ? `Over buffer by ${info.overBy} min` : info.state === 'approaching' ? 'Approaching buffer' : 'Within buffer'}</span>
    </div>`;
  } else if (f.status === 'OFF_BLOCK' && f.actualInBlock && f.actualOffBlock) {
    const totalMin = minutesBetween(f.actualOffBlock, f.actualInBlock);
    const state = totalMin > c.bufferMinutes ? 'over' : (totalMin >= c.bufferMinutes * 0.85 ? 'approaching' : 'under');
    gaugeElapsedHtml = `<div class="gauge-elapsed ge-${state}">
      <span class="ge-label">ACTUAL TURNAROUND</span>
      <span class="ge-time mono">${mmss(totalMin * 60000)}</span>
      <span class="ge-note">${state === 'over' ? `Exceeded buffer by ${Math.round(totalMin - c.bufferMinutes)} min` : 'Completed within buffer'}</span>
    </div>`;
  }

  el.innerHTML = `
    <div class="turn-wrap">
      <!-- 1 HEADER WITH FLIGHT SELECTOR (mirrors the Flight Board) -->
      <div class="turn-head">
        <div class="th-id"><span class="fl-num mono">${escapeHtml(f.flightNumber)}</span>
          <span class="fl-meta">${formatStand(f.stand)} · ${escapeHtml(f.aircraftType)} · EIBT ${hhmm(f.eibt)} · STD ${hhmm(f.std)}</span></div>
        <div class="ac-selector-box">
          <label for="turn-ac-select" class="ac-sel-lbl">✈ Flight:</label>
          <select id="turn-ac-select" class="ac-sel-dropdown mono">
            ${boardSortedFlights().map(bf => `
              <option value="${bf.id}" ${bf.id === f.id ? 'selected' : ''}>${escapeHtml(bf.flightNumber)} · ${escapeHtml(bf.aircraftType)} · ${bf.calculation.riskLevel}</option>
            `).join('')}
          </select>
        </div>
        ${riskChip(level)}
      </div>

      <!-- AIRCRAFT OPERATIONAL SPECS BANNER -->
      <div class="ac-spec-banner">
        <div class="asb-item"><span class="asb-k">MODEL CATEGORY</span><span class="asb-v">${escapeHtml(spec.cat)}</span></div>
        <div class="asb-item"><span class="asb-k">SEATING CAPACITY</span><span class="asb-v mono">${spec.seating} seats</span></div>
        <div class="asb-item"><span class="asb-k">TARGET TURNAROUND</span><span class="asb-v mono">${spec.turnMinutes} min</span></div>
        <div class="asb-item"><span class="asb-k">GSE REQ FLEET</span><span class="asb-v mono">${spec.gseTotal} units</span></div>
      </div>

      <div class="turn-grid">
        <!-- 2 BUFFER GAUGE -->
        <section class="card gauge-card${gaugeOverBuffer ? ' over-buffer' : ''}">
          <h3 class="card-h">Recommended buffer</h3>
          <div class="gauge">
            <svg viewBox="0 0 160 160">
              <circle cx="80" cy="80" r="${R}" fill="none" stroke="var(--surface-alt)" stroke-width="12"/>
              <circle class="gauge-fill" cx="80" cy="80" r="${R}" fill="none" stroke="${accent}" stroke-width="12" stroke-linecap="round"
                transform="rotate(-90 80 80)" stroke-dasharray="${CIRC.toFixed(1)}" stroke-dashoffset="${CIRC.toFixed(1)}"
                data-target="${(CIRC * (1 - gfrac)).toFixed(1)}"/>
            </svg>
            <div class="gauge-center"><span class="gauge-num mono">${c.bufferMinutes}</span><span class="gauge-unit">min</span></div>
          </div>
          <p class="gauge-note">Base ${getActiveWeightVersion().params.baseBuffer} + risk allowance</p>
          ${gaugeElapsedHtml}
        </section>

        <!-- 3 TOBT -->
        <section class="card tobt-card">
          <h3 class="card-h">Target off-block time</h3>
          <div class="tobt-big mono">${hhmm(c.tobt)}</div>
          <p class="tobt-math mono">EIBT ${hhmm(f.eibt)} + ${c.bufferMinutes} min buffer = TOBT ${hhmm(c.tobt)}</p>
        </section>

        <!-- 4 CONFIDENCE BAND -->
        <section class="card band-card">
          <div class="band-h-row">
            <h3 class="card-h">Confidence band</h3>
            <span class="card-h-tag mono">1,000 SIMULATED DRAWS</span>
          </div>

          <div class="conf-chart-wrap">
            ${confChart.svg}
            <div class="conf-axis mono">
              <span>${confChart.chartLo} min</span>
              <span class="ca-mid">P50 Expected ${Math.round(c.p50)} min</span>
              <span>${confChart.chartHi} min</span>
            </div>
          </div>

          <div class="conf-stats">
            <div class="cs-item">
              <span class="cs-label">Likely <small>(P10)</small></span>
              <span class="cs-val mono">${Math.round(c.p10)} <span class="cs-unit">min</span></span>
            </div>
            <div class="cs-item cs-primary">
              <span class="cs-label">Expected <small>(P50)</small></span>
              <span class="cs-val mono">${Math.round(c.p50)} <span class="cs-unit">min</span></span>
            </div>
            <div class="cs-item">
              <span class="cs-label">Worst Case <small>(P90)</small></span>
              <span class="cs-val mono">${Math.round(c.p90)} <span class="cs-unit">min</span></span>
            </div>
          </div>

          <div class="conf-plain">
            <span class="cp-icon">💡</span>
            <span>9 times out of 10, the turnaround finishes within <strong>${Math.round(c.p90)} minutes</strong>.</span>
          </div>
        </section>

        <!-- 5 WHAT'S DRIVING THIS -->
        <section class="card drive-card">
          <h3 class="card-h">What's driving this</h3>
          <div class="contrib-rows">
            ${rows.map(r => `
              <div class="contrib-row ${r.idx === c.dominantIndex ? 'dominant' : ''}">
                <div class="cr-top"><span class="cr-name">${escapeHtml(r.name)}${r.idx === c.dominantIndex ? ' <span class="cr-tag">DRIVER</span>' : ''}</span>
                  <span class="cr-share mono">${(r.share * 100).toFixed(1)}%</span></div>
                <div class="cr-bar"><span class="cr-fill" style="width:${(r.share * 100).toFixed(1)}%;--accent:${r.idx === c.dominantIndex ? accent : 'var(--grey)'}"></span></div>
                <div class="cr-meta mono">raw ${escapeHtml(r.raw)} · norm ${r.norm.toFixed(2)}</div>
              </div>`).join('')}
          </div>
        </section>

        <!-- 6 RECOMMENDED ACTIONS -->
        <section class="card action-card">
          <h3 class="card-h">Recommended actions <span class="card-h-tag mono" id="action-progress-tag">${ticks.length}/${actions.length} done</span></h3>
          <div class="action-list" id="action-list">
            ${actions.map((a, i) => `<label class="action-item ${ticks.includes(i) ? 'ticked' : ''}">
              <input type="checkbox" data-act="${i}" ${ticks.includes(i) ? 'checked' : ''}/>
              <span class="ai-box"></span><span class="ai-text">${escapeHtml(a)}</span></label>`).join('')}
          </div>
          <div class="action-foot">
            <div class="af-bar"><span class="af-fill" id="action-fill" style="width:${(actions.length ? (ticks.length / actions.length * 100) : 0)}%"></span></div>
            <span class="af-text mono" id="action-foot-text">${ticks.length === actions.length && actions.length ? '✓ All actions completed' : `${actions.length - ticks.length} remaining`}</span>
          </div>
        </section>

        <!-- 7 INPUTS & PROVENANCE -->
        <section class="card prov-card">
          <h3 class="card-h">Inputs &amp; provenance${(getLoadsheetByFlight(f.id) && hasPermission('loadsheet')) ? `<button class="btn btn-ghost btn-sm" id="turn-view-loadsheet" type="button" style="margin-left:auto">View Loadsheet</button>` : ''}</h3>
          <table class="prov-tbl">
            <thead><tr><th>Variable</th><th>Value</th><th>Source</th><th>Time</th><th>Quality</th></tr></thead>
            <tbody>
              ${ENGINE.VAR_NAMES.map((name, idx) => {
    const p = provFor(f, idx);
    return `<tr class="${p.quality === 'STALE' ? 'stale' : ''}">
                  <td>${escapeHtml(name)}</td><td class="mono">${escapeHtml(rawValueLabel(f, idx))}</td>
                  <td>${escapeHtml(p.source)}</td><td class="mono">${p.timestamp ? hhmm(p.timestamp) : '—'}</td>
                  <td>${qualityFlag(p.quality)}</td></tr>`;
  }).join('')}
            </tbody>
          </table>
          ${provFor(f, 3).quality === 'MEASURED' ? `<p class="prov-note">✓ Load factor confirmed via loadsheet.</p>` : ''}
        </section>
      </div>

      <!-- 8 ACKNOWLEDGE -->
      ${level !== 'GREEN' && f.ackStatus !== 'ACKNOWLEDGED'
      ? `<button class="btn btn-primary btn-full turn-ack" id="turn-ack" type="button">Acknowledge ${level} alert</button>`
      : level !== 'GREEN' ? `<div class="turn-acked">✓ Acknowledged ${hhmm(f.ackAt)} by ${escapeHtml(f.ackBy || '—')}</div>` : ''}

      <!-- 9 AUDIT PANEL -->
      <section class="card audit-card">
        <button class="audit-toggle" id="audit-toggle" type="button">
          <span>Audit &amp; reproducibility</span><span class="au-chev">▸</span></button>
        <div class="audit-body" id="audit-body" hidden>
          <div class="au-grid mono">
            <div><span class="au-k">Seed</span><span class="au-v">${c.seed}</span></div>
            <div><span class="au-k">Weight version</span><span class="au-v">${escapeHtml(c.weightVersionId)}</span></div>
            <div><span class="au-k">Compute time</span><span class="au-v">${c.computeMs} ms</span></div>
            <div><span class="au-k">Calculated</span><span class="au-v">${fmtDateTime(c.calculatedAt)}</span></div>
          </div>
          <button class="btn btn-ghost btn-sm" id="verify-btn" type="button">Verify reproducibility</button>
          <div class="verify-result" id="verify-result" hidden></div>
        </div>
      </section>
    </div>`;

  /* animate gauge */
  const gf = el.querySelector('.gauge-fill');
  requestAnimationFrame(() => { gf.style.transition = 'stroke-dashoffset 1s var(--ease)'; gf.style.strokeDashoffset = gf.dataset.target; });

  tickTurnaroundElapsed();

  /* flight selector — switches the ENTIRE Turnaround Detail (header,
     stand, EIBT/STD, aircraft, gauge, band, drivers, provenance …) to the
     chosen board flight, in place, without reloading the page. */
  const acSelect = el.querySelector('#turn-ac-select');
  if(acSelect){
    acSelect.onchange = e => {
      const nextId = e.target.value;
      if(!nextId || nextId === selectedFlightId) return;
      selectedFlightId = nextId;
      const nf = getFlight(nextId);
      renderTurnaround(el);
      if(nf) showToast(`Now viewing ${nf.flightNumber} · ${nf.aircraftType} · ${nf.calculation.riskLevel}`, 'success');
    };
  }

  const turnBackBtn = el.querySelector('#turn-back');
  if (turnBackBtn) turnBackBtn.onclick = () => showModule('flightboard');
  const backAck = el.querySelector('#turn-ack');
  if (backAck) backAck.onclick = () => { acknowledgeAlert(f.id, currentActor()); showToast(`${f.flightNumber} acknowledged`, 'success'); showModule('turnaround'); };

  /* action ticks persist */
  el.querySelector('#action-list').onchange = e => {
    const cb = e.target.closest('[data-act]'); if (!cb) return;
    const idx = Number(cb.dataset.act);
    let t = (getFlight(f.id).actionTicks || []).slice();
    if (cb.checked) { if (!t.includes(idx)) t.push(idx); } else t = t.filter(x => x !== idx);
    updateFlight(f.id, { actionTicks: t });
    cb.closest('.action-item').classList.toggle('ticked', cb.checked);
    const tag = el.querySelector('#action-progress-tag');
    const fill = el.querySelector('#action-fill');
    const footText = el.querySelector('#action-foot-text');
    if (tag) tag.textContent = `${t.length}/${actions.length} done`;
    if (fill) fill.style.width = (actions.length ? (t.length / actions.length * 100) : 0) + '%';
    if (footText) footText.textContent = t.length === actions.length && actions.length ? '✓ All actions completed' : `${actions.length - t.length} remaining`;
  };

  const viewLsBtn = el.querySelector('#turn-view-loadsheet');
  if (viewLsBtn) viewLsBtn.onclick = () => { loadsheetSelectedFlightId = f.id; showModule('loadsheet'); };

  /* audit toggle + verify */
  const toggle = el.querySelector('#audit-toggle'), body = el.querySelector('#audit-body');
  toggle.onclick = () => { body.hidden = !body.hidden; toggle.classList.toggle('open', !body.hidden); };
  el.querySelector('#verify-btn').onclick = () => {
    const stored = getFlight(f.id).calculation;
    const re = calculateFlightRisk(getFlight(f.id), stored.weightVersionId, stored.calculatedAt);
    const match = re.seed === stored.seed && re.p10 === stored.p10 && re.p50 === stored.p50 &&
      re.p90 === stored.p90 && re.mean === stored.mean && re.std === stored.std && re.bufferMinutes === stored.bufferMinutes;
    const rr = el.querySelector('#verify-result'); rr.hidden = false;
    rr.className = 'verify-result ' + (match ? 'ok' : 'fail');
    rr.innerHTML = match
      ? `<strong>✓ Exact match.</strong> Re-running the engine from the stored inputs, seed ${stored.seed} and weight version reproduced P10/P50/P90 = ${Math.round(re.p10)}/${Math.round(re.p50)}/${Math.round(re.p90)} to full precision.`
      : `<strong>✗ Mismatch.</strong> The re-run did not reproduce the stored result.`;
    logActivity({ action: 'verified reproducibility', target: f.flightNumber, category: 'audit', severity: match ? 'info' : 'danger' });
  };
}

/* live-refresh the gauge-card elapsed readout, matching tickBoardElapsed() */
function tickTurnaroundElapsed() {
  const box = document.querySelector('.gauge-elapsed[data-since]'); if (!box) return;
  const info = turnaroundElapsedInfo(box.dataset.since, Number(box.dataset.buffer));
  box.className = 'gauge-elapsed ge-' + info.state;
  const val = box.querySelector('[data-ge-val]'); if (val) val.textContent = mmss(info.elapsedMs);
  const note = box.querySelector('[data-ge-note]');
  if (note) note.textContent = info.state === 'over' ? `Over buffer by ${info.overBy} min` : info.state === 'approaching' ? 'Approaching buffer' : 'Within buffer';
  const card = box.closest('.gauge-card'); if (card) card.classList.toggle('over-buffer', info.state === 'over');
}

function emptyState(title, msg, iconPath) {
  const p = iconPath || '<circle cx="12" cy="12" r="9"/><path d="M9 12 h6"/>';
  return `<div class="empty"><div class="empty-ico"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${p}</svg></div>
    <h4>${escapeHtml(title)}</h4><p>${escapeHtml(msg)}</p></div>`;
}

/* ═══ shared: visible recalculation sequence (S4 & S7) ══════
   Steps through pending flights ~150ms each, applies `mutate(flight)`
   before recomputing, then resolves with the list of changes. */
function recalcSequence(hostEl, mutate) {
  return new Promise(resolve => {
    const flights = getFlights().filter(f => f.status !== 'OFF_BLOCK');
    hostEl.innerHTML = `<div class="recalc-box">
        <div class="recalc-head"><span class="spinner" style="border-color:rgba(37,99,235,.25);border-top-color:var(--primary)"></span>
          <span>Recalculating pending flights…</span></div>
        <div class="recalc-now mono" id="recalc-now">—</div>
        <div class="recalc-track"><span class="recalc-fill" id="recalc-fill"></span></div>
      </div>`;
    const changes = []; let i = 0;
    const store = getFlights();
    function step() {
      if (i >= flights.length) { saveFlights(store); resolve(changes); return; }
      const f = flights[i];
      const target = store.find(x => x.id === f.id);
      const old = { risk: target.calculation.riskLevel, buffer: target.calculation.bufferMinutes };
      if (mutate) mutate(target);
      target.calculation = calculateFlightRisk(target);
      if (old.risk !== target.calculation.riskLevel || old.buffer !== target.calculation.bufferMinutes) {
        changes.push({
          id: target.id, flightNumber: target.flightNumber, oldRisk: old.risk, newRisk: target.calculation.riskLevel,
          oldBuffer: old.buffer, newBuffer: target.calculation.bufferMinutes
        });
        /* worsened to RED → raise a fresh alert */
        if (target.calculation.riskLevel === 'RED' && old.risk !== 'RED') {
          const alerts = getAlerts();
          const al = makeAlertRecord(target); al.createdAt = nowISO();
          target.alertId = al.id; target.ackStatus = 'REQUIRED'; target.ackAt = null; target.ackBy = null;
          alerts.push(al); saveAlerts(alerts);
        }
      }
      const now = document.getElementById('recalc-now'); if (now) now.textContent = f.flightNumber;
      const fill = document.getElementById('recalc-fill'); if (fill) fill.style.width = ((i + 1) / flights.length * 100) + '%';
      i++;
      setTimeout(step, 150);
    }
    step();
  });
}

function changeSummaryHtml(changes, total) {
  const moved = changes.length;
  return `<div class="recalc-summary">
    <div class="rs-head"><strong>${total} flights recalculated</strong> · ${moved} risk level${moved === 1 ? '' : 's'} changed</div>
    ${moved ? `<div class="rs-list">${changes.map(ch => `
      <div class="rs-row">
        <span class="mono rs-fl">${escapeHtml(ch.flightNumber)}</span>
        <span class="rs-move">${riskChip(ch.oldRisk)} → ${riskChip(ch.newRisk)}</span>
        <span class="mono rs-buf">${ch.oldBuffer} → ${ch.newBuffer} min</span>
      </div>`).join('')}</div>` : `<p class="rs-none">No risk levels changed.</p>`}
  </div>`;
}

let gseCatFilter = 'ALL';

/* ═══ S4 — GSE ENTRY (key: gse) ═════════════════════════════ */
function renderGseEntry(el) {
  const fleet = getGse();
  const byType = {};
  fleet.forEach(u => {
    (byType[u.typeCode] = byType[u.typeCode] || { code: u.typeCode, name: u.type, category: u.category || 'POWERED', ghaId: ghaOf(u), total: 0, avail: 0 });
  });
  fleet.forEach(u => {
    byType[u.typeCode].total++;
    if (u.status === 'SERVICEABLE') byType[u.typeCode].avail++;
  });
  const types = Object.values(byType);
  const s = getSession();

  /* operating Ground Handling Agents across the fleet */
  const ghas = getGhas();
  const ghaGroups = {};
  ghas.forEach(g => ghaGroups[g.id] = { total: 0, svc: 0 });
  fleet.filter(u => u.status !== 'RETIRED').forEach(u => { const id = ghaOf(u); if (!id) return; (ghaGroups[id] = ghaGroups[id] || { total: 0, svc: 0 }); ghaGroups[id].total++; if (u.status === 'SERVICEABLE') ghaGroups[id].svc++; });

  const poweredCount = types.filter(t => t.category === 'POWERED').length;
  const nonPoweredCount = types.filter(t => t.category === 'NON_POWERED').length;
  const infraCount = types.filter(t => t.category === 'INFRASTRUCTURE').length;

  const filteredTypes = types.filter(t => {
    if (gseCatFilter === 'ALL') return true;
    return t.category === gseCatFilter;
  });

  const activeTypes = gseCatFilter === 'ALL' ? types : filteredTypes;
  let summaryAvail = 0, summaryTotal = 0;
  activeTypes.forEach(t => { summaryAvail += t.avail; summaryTotal += t.total; });
  const summaryRatio = summaryTotal ? summaryAvail / summaryTotal : 0;
  const summaryPct = Math.round(summaryRatio * 100);
  const barColor = summaryRatio >= 0.7 ? 'var(--green)' : summaryRatio >= 0.45 ? 'var(--amber)' : 'var(--red)';
  const badgeColor = summaryRatio >= 0.7 ? '#15803D' : summaryRatio >= 0.45 ? '#92400E' : '#991B1B';
  const badgeBg = summaryRatio >= 0.7 ? 'var(--green-lite)' : summaryRatio >= 0.45 ? 'var(--amber-lite)' : 'var(--red-lite)';
  const catLabel = gseCatFilter === 'ALL' ? 'Total Fleet Availability' : (gseCatFilter === 'POWERED' ? 'Powered GSE Availability' : (gseCatFilter === 'NON_POWERED' ? 'Non-Powered Availability' : 'Infrastructure Availability'));

  el.innerHTML = `
    <div class="gse-wrap">
      <div class="mod-head">
        <div>
          <h1 class="mod-title">GSE Availability Entry</h1>
          <p class="mod-sub">Shift A · ${fmtDate(nowISO())} · ${escapeHtml(s ? s.name : 'Supervisor')}</p>
        </div>
      </div>

      <!-- FLEET READINESS SUMMARY CARD -->
      <div class="gse-summary-card card">
        <div class="gsc-top">
          <div class="gsc-left">
            <span class="gsc-lbl">${catLabel}</span>
            <span class="gsc-num mono" id="gt-val-num">${summaryAvail} / ${summaryTotal}</span>
          </div>
          <div class="gsc-right">
            <span class="gsc-pct mono" id="gt-pct-text" style="color:${badgeColor}; background:${badgeBg}">${summaryPct}% Readiness</span>
          </div>
        </div>
        <div class="gt-bar">
          <span class="gt-fill" id="gt-fill" style="width:${summaryPct}%; background:${barColor}"></span>
        </div>
      </div>

      <!-- GROUND HANDLING AGENTS (MUX) -->
      <div class="gha-section">
        <div class="gha-head"><h3 class="card-h" style="margin:0">Ground Handling Agents · Multan (MUX)</h3>
          <span class="gha-sub mono">${ghas.filter(g => ghaGroups[g.id] && ghaGroups[g.id].total).length} agents operating this fleet</span></div>
        <div class="gha-grid">
          ${ghas.filter(g => ghaGroups[g.id] && ghaGroups[g.id].total).map((g, i) => { const grp = ghaGroups[g.id]; const color = ghaColorFor(g.id);
            const pct = grp.total ? Math.round(grp.svc / grp.total * 100) : 0;
            return `<div class="gha-card card-stagger" data-open-gha="${g.id}" style="--gha:${color};animation-delay:${i * 40}ms">
              <div class="ghc-top"><span class="ghc-name">${escapeHtml(g.name)}</span><span class="gha-badge" style="--gha:${color}">${escapeHtml(g.code)}</span></div>
              <div class="ghc-role">${escapeHtml(ghaOwnershipLabel(g.ownership))}</div>
              <div class="ghc-carriers">${escapeHtml(ghaAirlinesLabel(g))}</div>
              <div class="ghc-foot"><span class="mono ghc-units">${grp.total} units</span><span class="ghc-bar"><span style="width:${pct}%"></span></span><span class="mono ghc-pct">${pct}% svc</span></div>
            </div>`; }).join('')}
        </div>
      </div>

      <!-- CATEGORY TABS -->
      <div class="gse-cat-tabs" id="gse-cat-tabs">
        <button type="button" class="gct-tab ${gseCatFilter === 'ALL' ? 'active' : ''}" data-cat="ALL">All Fleet (${types.length})</button>
        <button type="button" class="gct-tab ${gseCatFilter === 'POWERED' ? 'active' : ''}" data-cat="POWERED">⚡ Powered GSE (${poweredCount})</button>
        <button type="button" class="gct-tab ${gseCatFilter === 'NON_POWERED' ? 'active' : ''}" data-cat="NON_POWERED">📦 Non-Powered (${nonPoweredCount})</button>
        <button type="button" class="gct-tab ${gseCatFilter === 'INFRASTRUCTURE' ? 'active' : ''}" data-cat="INFRASTRUCTURE">🏗 Infrastructure (${infraCount})</button>
      </div>

      <!-- GSE EQUIPMENT GRID -->
      <div class="gse-rows" id="gse-rows">
        ${filteredTypes.map(t => `
          <div class="gse-row card" data-code="${t.code}">
            <div class="gr-top">
              <div class="gr-left">
                <span class="gr-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${ICONS.gse}</svg></span>
                <span class="gr-name">${escapeHtml(t.name)} ${ghaBadge(t.ghaId)}${suitabilityInfoTitle(t.code) ? `<span class="gr-suit-info" title="${escapeHtml(suitabilityInfoTitle(t.code))}"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><line x1="12" y1="11" x2="12" y2="16.5"/><circle cx="12" cy="7.7" r="1.1" fill="currentColor" stroke="none"/></svg></span>` : ''}</span>
              </div>
              <span class="gr-badge mono" data-badge>${t.avail} / ${t.total}</span>
            </div>

            <div class="gr-control">
              <button class="stepper btn-sub" data-step="-1" data-code="${t.code}" type="button">−</button>
              <div class="gr-count mono"><span class="gr-avail" data-avail>${t.avail}</span> <span class="gr-slash">/</span> ${t.total}</div>
              <button class="stepper btn-add" data-step="1" data-code="${t.code}" type="button">+</button>
            </div>

            <div class="gr-bar"><span class="gr-fill" data-fill></span></div>
            <div class="gr-err" data-err hidden></div>
          </div>`).join('')}
      </div>

      <!-- FOOTER CARD -->
      <div class="card gse-footer-card">
        <div class="gse-footer-row">
          <div class="field gse-notes-field">
            <label for="gse-notes">Shift Notes / Remarks (optional)</label>
            <div class="input-wrap">
              <input type="text" id="gse-notes" placeholder="Serviceability remarks, standby arrangements…" autocomplete="off" />
            </div>
          </div>
          <div class="gse-submit-action">
            <button class="btn btn-primary" id="gse-submit" type="button">Submit Shift Availability</button>
          </div>
        </div>
      </div>
      <div id="gse-result" class="gse-result"></div>
    </div>`;

  const state = {}; types.forEach(t => state[t.code] = { total: t.total, avail: t.avail });

  function paint() {
    let sa = 0, st = 0;
    activeTypes.forEach(t => {
      const s2 = state[t.code]; sa += s2.avail; st += s2.total;
      const row = el.querySelector(`.gse-row[data-code="${t.code}"]`);
      if (row) {
        const availEl = row.querySelector('[data-avail]'); if (availEl) availEl.textContent = s2.avail;
        const badge = row.querySelector('[data-badge]'); if (badge) badge.textContent = `${s2.avail} / ${s2.total}`;
        const ratio = s2.total ? s2.avail / s2.total : 0;
        const fill = row.querySelector('[data-fill]');
        if (fill) {
          fill.style.width = (ratio * 100) + '%';
          fill.style.background = ratio >= 0.7 ? 'var(--green)' : ratio >= 0.45 ? 'var(--amber)' : 'var(--red)';
        }
      }
    });
    const ratio = st ? sa / st : 0;
    const pct = Math.round(ratio * 100);
    const numEl = el.querySelector('#gt-val-num'); if (numEl) numEl.textContent = `${sa} / ${st}`;
    const pctEl = el.querySelector('#gt-pct-text');
    if (pctEl) {
      pctEl.textContent = `${pct}% Readiness`;
      pctEl.style.color = ratio >= 0.7 ? '#15803D' : ratio >= 0.45 ? '#92400E' : '#991B1B';
      pctEl.style.background = ratio >= 0.7 ? 'var(--green-lite)' : ratio >= 0.45 ? 'var(--amber-lite)' : 'var(--red-lite)';
    }
    const gf = el.querySelector('#gt-fill');
    if (gf) {
      gf.style.width = (pct) + '%';
      gf.style.background = ratio >= 0.7 ? 'var(--green)' : ratio >= 0.45 ? 'var(--amber)' : 'var(--red)';
    }
  }
  const catTabs = el.querySelector('#gse-cat-tabs');
  if (catTabs) {
    catTabs.onclick = e => {
      const btn = e.target.closest('[data-cat]');
      if (!btn) return;
      gseCatFilter = btn.dataset.cat;
      renderGseEntry(el);
    };
  }
  const ghaGridEl = el.querySelector('.gha-grid');
  if (ghaGridEl && hasPermission('gha')) {
    ghaGridEl.onclick = e => { const card = e.target.closest('[data-open-gha]'); if (card) openGhaDetail(card.dataset.openGha); };
  }

  el.querySelector('#gse-rows').onclick = e => {
    const btn = e.target.closest('[data-step]'); if (!btn) return;
    const code = btn.dataset.code, dir = Number(btn.dataset.step), st = state[code];
    const next = st.avail + dir;
    const row = el.querySelector(`.gse-row[data-code="${code}"]`);
    const err = row.querySelector('[data-err]');
    if (next < 0 || next > st.total) {
      err.hidden = false; err.textContent = next < 0 ? 'Available cannot go below zero.' : 'Available cannot exceed the total units.';
      row.classList.add('shake'); setTimeout(() => row.classList.remove('shake'), 320);
      return;
    }
    err.hidden = true; st.avail = next; paint();
  };

  el.querySelector('#gse-submit').onclick = async () => {
    const sa = types.reduce((a, t) => a + state[t.code].avail, 0);
    const stt = types.reduce((a, t) => a + state[t.code].total, 0);
    const notes = el.querySelector('#gse-notes').value.trim();
    const result = el.querySelector('#gse-result');
    el.querySelector('#gse-submit').disabled = true;

    const total = getFlights().filter(f => f.status !== 'OFF_BLOCK').length;
    const changes = await recalcSequence(result, f => { f.rawInputs.gseAvailable = Math.min(sa, stt); f.rawInputs.gseTotal = stt; });

    /* persist a shift submission record */
    const shifts = getGseShifts();
    shifts.unshift({
      id: uid('gs'), submittedAt: nowISO(), submittedBy: s ? s.name : 'Supervisor',
      shift: 'A', available: sa, total: stt, notes, perType: types.map(t => ({ code: t.code, avail: state[t.code].avail, total: state[t.code].total }))
    });
    lsSet(GSE_SHIFT_KEY, shifts);
    logActivity({ action: `submitted GSE availability ${sa}/${stt}`, target: 'Shift A', category: 'gse', severity: 'info' });

    result.innerHTML = changeSummaryHtml(changes, total);
    const newReds = changes.filter(ch => ch.newRisk === 'RED' && ch.oldRisk !== 'RED').length;
    showToast(`${total} flights recalculated${newReds ? ` · ${newReds} new RED alert${newReds > 1 ? 's' : ''}` : ''}`, newReds ? 'notice' : 'success');
    updateAlertBadge();
    el.querySelector('#gse-submit').disabled = false;
  };
}

/* ═══ S5 — OFF-BLOCK LOGGING (key: offblock) ════════════════ */
function isoWithTime(baseIso, hhmmStr) {
  const d = new Date(baseIso); const [h, m] = hhmmStr.split(':').map(Number);
  d.setHours(h, m, 0, 0); return d.toISOString();
}
const DELAY_REASONS = ['Late inbound aircraft', 'GSE unavailable', 'Crew shortage', 'Baggage handling', 'PRM assistance', 'Fuelling delay', 'ATC/slot', 'Weather', 'Other'];

/* ── Block-On / Block-Off tab state (sibling of gseCatFilter/equipFilter) ── */
let blockTab = null;   // 'blockon' | 'blockoff' — lazily defaulted, then sticky

function defaultBlockTab() {
  const NEAR_TERM_MIN = 30;
  const near = getFlights().some(f => f.status === 'SCHEDULED' && Math.abs(minutesBetween(nowISO(), f.eibt)) <= NEAR_TERM_MIN);
  return near ? 'blockon' : 'blockoff';
}

/* "Due in 12 min" (neutral) / "Overdue by 6 min" (amber) — ticks live */
function dueLabel(eibtIso) {
  const mins = minutesBetween(nowISO(), eibtIso);   // positive once EIBT is in the past
  if (mins > 0) return { text: `Overdue by ${mins} min`, cls: 'over' };
  const due = Math.abs(mins);
  return { text: due === 0 ? 'Due now' : `Due in ${due} min`, cls: 'neutral' };
}

function tickBlockOnDue() {
  document.querySelectorAll('.bo-due[data-eibt]').forEach(elx => {
    const due = dueLabel(elx.dataset.eibt);
    elx.textContent = due.text;
    elx.classList.remove('bo-due-neutral', 'bo-due-over');
    elx.classList.add('bo-due-' + due.cls);
  });
}

function renderOffBlock(el) {
  if (!blockTab) blockTab = defaultBlockTab();

  const scheduled = getFlights().filter(f => f.status === 'SCHEDULED').sort((a, b) => new Date(a.eibt) - new Date(b.eibt));
  const pending = getFlights().filter(f => f.status === 'IN_BLOCK' && !f.actualOffBlock);
  const outcomes = getOutcomes();
  const recent = outcomes.slice(0, 8);

  const overdueCount = scheduled.filter(f => minutesBetween(nowISO(), f.eibt) > 0).length;
  const blockedOnToday = getFlights().filter(f => f.actualInBlock && isSameDay(f.actualInBlock)).length;
  const onBlockVariances = getFlights().filter(f => f.inBlockVarianceMin != null).map(f => Math.abs(f.inBlockVarianceMin));
  const avgOnBlockVar = onBlockVariances.length ? Math.round(onBlockVariances.reduce((a, b) => a + b, 0) / onBlockVariances.length) : 0;
  const recentBlockOns = getFlights().filter(f => f.actualInBlock)
    .sort((a, b) => new Date(b.actualInBlock) - new Date(a.actualInBlock)).slice(0, 8);

  const totalLogged = outcomes.length;
  const avgError = totalLogged ? Math.round(outcomes.reduce((s, o) => s + Math.abs(o.error), 0) / totalLogged) : 0;
  const onTimeRate = totalLogged ? Math.round((outcomes.filter(o => Math.abs(o.error) <= 5).length / totalLogged) * 100) : 100;

  el.innerHTML = `
    <div class="mod-wide">
      <div class="mod-head">
        <div>
          <h1 class="mod-title">Block Times</h1>
          <p class="mod-sub">${blockTab === 'blockon'
      ? `${scheduled.length} scheduled arrival${scheduled.length === 1 ? '' : 's'} awaiting block-on`
      : `${pending.length} in-block flight${pending.length === 1 ? '' : 's'} awaiting actual off-block time (AOBT) confirmation`}</p>
        </div>
      </div>

      <div class="gse-cat-tabs" id="bt-tabs">
        <button type="button" class="gct-tab ${blockTab === 'blockon' ? 'active' : ''}" data-tab="blockon">Block-On (${scheduled.length})</button>
        <button type="button" class="gct-tab ${blockTab === 'blockoff' ? 'active' : ''}" data-tab="blockoff">Block-Off (${pending.length})</button>
      </div>

      ${blockTab === 'blockon' ? `
      <!-- BLOCK-ON KPI STRIP -->
      <div class="ob-kpi-strip">
        <div class="kpi"><span class="kpi-num mono">${scheduled.length}</span><span class="kpi-lbl">Awaiting Block-On</span></div>
        <div class="kpi"><span class="kpi-num mono">${overdueCount}</span><span class="kpi-lbl">Overdue</span></div>
        <div class="kpi"><span class="kpi-num mono">${blockedOnToday}</span><span class="kpi-lbl">Blocked On Today</span></div>
        <div class="kpi"><span class="kpi-num mono">±${avgOnBlockVar} <small style="font-size:12px;font-weight:500;color:var(--text-mute)">min</small></span><span class="kpi-lbl">Avg Block-On Variance</span></div>
      </div>

      <!-- 2-COLUMN DUAL PANE -->
      <div class="ob-main-grid">
        <!-- LEFT: Scheduled Arrivals -->
        <section class="card ob-pending-card">
          <h3 class="card-h">Scheduled Arrivals (${scheduled.length})</h3>
          <div class="ob-list" id="bo-list">
            ${scheduled.length ? scheduled.map(f => {
        const due = dueLabel(f.eibt);
        return `
              <div class="ob-item card" data-flight="${f.id}">
                <div class="ob-item-top">
                  <span class="fl-num mono">${escapeHtml(f.flightNumber)}</span>
                  <span class="bo-due bo-due-${due.cls} mono" data-eibt="${f.eibt}">${due.text}</span>
                </div>
                <div class="ob-item-meta">
                  <strong>${formatStand(f.stand)}</strong> · Aircraft <strong>${escapeHtml(f.aircraftType)}</strong> · EIBT <strong class="mono">${hhmm(f.eibt)}</strong>
                </div>
                <div class="ob-item-tobt">
                  <div class="tobt-box">
                    <span class="ob-k">EXPECTED IN-BLOCK</span>
                    <span class="mono ob-v">${hhmm(f.eibt)}</span>
                  </div>
                  <button class="btn btn-primary btn-sm" data-logon="${f.id}" type="button">Log Block-On</button>
                </div>
              </div>`;
      }).join('') : emptyState('All caught up', 'No scheduled arrivals awaiting block-on.')}
          </div>
        </section>

        <!-- RIGHT: Recent Block-Ons History Log -->
        <section class="card ob-history-card">
          <h3 class="card-h">Recent Block-Ons (${recentBlockOns.length})</h3>
          ${recentBlockOns.length ? `
          <div class="table-scroll">
            <table class="prov-tbl ob-tbl">
              <thead>
                <tr>
                  <th>Flight</th>
                  <th>EIBT</th>
                  <th>Blocked On</th>
                  <th>Variance</th>
                  <th>By</th>
                </tr>
              </thead>
              <tbody>
                ${recentBlockOns.map(f => `
                <tr>
                  <td><strong class="mono">${escapeHtml(f.flightNumber)}</strong></td>
                  <td class="mono">${hhmm(f.eibt)}</td>
                  <td class="mono">${hhmm(f.actualInBlock)}</td>
                  <td><span class="orc-err ${errorClass(f.inBlockVarianceMin)} mono">${f.inBlockVarianceMin === 0 ? 'on time' : fmtSigned(f.inBlockVarianceMin) + ' min'}</span></td>
                  <td>${escapeHtml(f.inBlockLoggedBy || '—')}</td>
                </tr>`).join('')}
              </tbody>
            </table>
          </div>` : '<p class="rs-none">No block-ons logged yet.</p>'}
        </section>
      </div>` : `
      <!-- BLOCK-OFF KPI STRIP -->
      <div class="ob-kpi-strip">
        <div class="kpi">
          <span class="kpi-num mono">${pending.length}</span>
          <span class="kpi-lbl">Awaiting Confirmation</span>
        </div>
        <div class="kpi">
          <span class="kpi-num mono">${totalLogged}</span>
          <span class="kpi-lbl">Departures Logged</span>
        </div>
        <div class="kpi">
          <span class="kpi-num mono">±${avgError} <small style="font-size:12px;font-weight:500;color:var(--text-mute)">min</small></span>
          <span class="kpi-lbl">Mean Absolute Error</span>
        </div>
        <div class="kpi">
          <span class="kpi-num mono">${onTimeRate}%</span>
          <span class="kpi-lbl">Target Accuracy (±5m)</span>
        </div>
      </div>

      <!-- 2-COLUMN DUAL PANE -->
      <div class="ob-main-grid">
        <!-- LEFT: Pending Flights -->
        <section class="card ob-pending-card">
          <h3 class="card-h">Pending In-Block Flights (${pending.length})</h3>
          <div class="ob-list" id="ob-list">
            ${pending.length ? pending.map(f => {
        const c = f.calculation || calculateFlightRisk(f);
        return `
              <div class="ob-item card" data-flight="${f.id}">
                <div class="ob-item-top">
                  <span class="fl-num mono">${escapeHtml(f.flightNumber)}</span>
                  ${riskChip(c.riskLevel)}
                </div>
                <div class="ob-item-meta">
                  <strong>${formatStand(f.stand)}</strong> · Aircraft <strong>${escapeHtml(f.aircraftType)}</strong> · EIBT <strong class="mono">${hhmm(f.eibt)}</strong>
                </div>
                <div class="ob-item-tobt">
                  <div class="tobt-box">
                    <span class="ob-k">TARGET OFF-BLOCK (TOBT)</span>
                    <span class="mono ob-v">${hhmm(c.tobt)}</span>
                  </div>
                  <button class="btn btn-primary btn-sm" data-log="${f.id}" type="button">Log off-block</button>
                </div>
              </div>`;
      }).join('') : emptyState('All caught up', 'No in-block flights are currently awaiting off-block confirmation.')}
          </div>
        </section>

        <!-- RIGHT: Recent Departures History Log -->
        <section class="card ob-history-card">
          <h3 class="card-h">Recent Off-Block Departures (${recent.length})</h3>
          ${recent.length ? `
          <div class="table-scroll">
            <table class="prov-tbl ob-tbl">
              <thead>
                <tr>
                  <th>Flight</th>
                  <th>Pred</th>
                  <th>Actual</th>
                  <th>Error</th>
                  <th>Supervisor</th>
                </tr>
              </thead>
              <tbody>
                ${recent.map(o => `
                <tr>
                  <td><strong class="mono">${escapeHtml(o.flightNumber)}</strong></td>
                  <td class="mono">${o.predictedBuffer}m</td>
                  <td class="mono">${o.actualBuffer}m</td>
                  <td><span class="orc-err ${errorClass(o.error)} mono">${fmtSigned(Math.round(o.error))} min</span></td>
                  <td>${escapeHtml(o.supervisor || '—')}</td>
                </tr>`).join('')}
              </tbody>
            </table>
          </div>` : '<p class="rs-none">No off-block outcomes logged yet.</p>'}
        </section>
      </div>`}
    </div>`;

  el.querySelector('#bt-tabs').onclick = e => {
    const b = e.target.closest('[data-tab]'); if (!b || b.dataset.tab === blockTab) return;
    blockTab = b.dataset.tab; renderOffBlock(el);
  };

  if (blockTab === 'blockon') {
    el.querySelector('#bo-list').onclick = e => { const b = e.target.closest('[data-logon]'); if (b) openBlockOnModal(b.dataset.logon); };
  } else {
    el.querySelector('#ob-list').onclick = e => { const b = e.target.closest('[data-log]'); if (b) openOffBlockModal(b.dataset.log); };
  }
  tickBlockOnDue();
}

/* row exits the Block-On list the same way admin table rows exit —
   .removing + rowOut — then the module re-renders onto the Block-Off side */
function animateBlockOnExit(flightId) {
  const row = document.querySelector(`.ob-item[data-flight="${flightId}"]`);
  const finish = () => { if (currentModule === 'offblock') showModule('offblock'); };
  if (row) { row.classList.add('removing'); setTimeout(finish, 350); } else finish();
}

function openBlockOnModal(flightId) {
  const f = getFlight(flightId); if (!f) return;
  const modal = openModal(`
    <div class="modal-head"><div><h3>Log Block-On</h3><p>${escapeHtml(f.flightNumber)} · ${formatStand(f.stand)} · EIBT ${hhmm(f.eibt)}</p></div>
      <button class="modal-x" data-x aria-label="Close"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6 L18 18 M18 6 L6 18"/></svg></button></div>
    <div class="field"><label for="bo-time">Actual block-on time</label>
      <div class="input-wrap"><input type="time" id="bo-time" value="${hhmm(nowISO())}"/></div></div>
    <div class="ob-error" id="bo-error" hidden></div>
    <div class="modal-foot"><button class="btn btn-ghost" data-x>Cancel</button><button class="btn btn-primary" id="bo-save">Save block-on</button></div>`);

  modal.querySelectorAll('[data-x]').forEach(b => b.onclick = closeModal);
  const timeEl = modal.querySelector('#bo-time');
  const errEl = modal.querySelector('#bo-error');

  function preview() {
    const actualIso = isoWithTime(f.eibt, timeEl.value);
    const variance = minutesBetween(actualIso, f.eibt);
    const word = variance === 0 ? 'on time' : `${Math.abs(variance)} min ${variance > 0 ? 'late' : 'early'}`;
    errEl.hidden = false;
    errEl.className = 'ob-error ' + errorClass(variance);
    errEl.innerHTML = `EIBT <strong class="mono">${hhmm(f.eibt)}</strong> → logging <strong class="mono">${hhmm(actualIso)}</strong> = <strong class="mono">${word}</strong>`;
    return { actualIso, variance, word };
  }
  preview();
  timeEl.oninput = preview;

  modal.querySelector('#bo-save').onclick = () => {
    const { actualIso, variance, word } = preview();
    const loggedBy = currentActor();
    updateFlight(f.id, { status: 'IN_BLOCK', actualInBlock: actualIso, inBlockLoggedBy: loggedBy, inBlockVarianceMin: variance });
    logActivity({ action: `logged block-on (${word})`, target: f.flightNumber, category: 'offblock', severity: Math.abs(variance) > 15 ? 'warn' : 'success' });
    closeModal();
    showToast(`${f.flightNumber} blocked on · ${word}`, Math.abs(variance) <= 5 ? 'success' : 'notice');
    updateAlertBadge();
    animateBlockOnExit(f.id);
  };
}

function openOffBlockModal(flightId) {
  const f = getFlight(flightId); if (!f) return;
  const c = f.calculation;
  const modal = openModal(`
    <div class="modal-head"><div><h3>Log off-block</h3><p>${escapeHtml(f.flightNumber)} · Stand ${f.stand} · TOBT ${hhmm(c.tobt)}</p></div>
      <button class="modal-x" data-x aria-label="Close"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6 L18 18 M18 6 L6 18"/></svg></button></div>
    <div class="field"><label for="ob-time">Actual off-block time</label>
      <div class="input-wrap"><input type="time" id="ob-time" value="${hhmm(nowISO())}"/></div></div>
    <div class="ob-error" id="ob-error" hidden></div>
    <div class="field" id="ob-reason-field" hidden><label for="ob-reason">Delay reason (required — more than 15 min past TOBT)</label>
      <div class="input-wrap"><select id="ob-reason"><option value="" selected disabled>Select reason…</option>${DELAY_REASONS.map(r => `<option value="${r}">${r}</option>`).join('')}</select></div></div>
    <div class="modal-foot"><button class="btn btn-ghost" data-x>Cancel</button><button class="btn btn-primary" id="ob-save">Save off-block</button></div>`);

  modal.querySelectorAll('[data-x]').forEach(b => b.onclick = closeModal);
  const timeEl = modal.querySelector('#ob-time');
  const errEl = modal.querySelector('#ob-error');
  const reasonField = modal.querySelector('#ob-reason-field');

  function preview() {
    const actualIso = isoWithTime(f.eibt, timeEl.value);
    const err = minutesBetween(actualIso, c.tobt);
    errEl.hidden = false;
    errEl.className = 'ob-error ' + errorClass(err);
    errEl.innerHTML = `Prediction error: <strong class="mono">${fmtSigned(err)} min</strong> vs TOBT ${hhmm(c.tobt)}`;
    reasonField.hidden = !(err > 15);
    return { actualIso, err };
  }
  preview();
  timeEl.oninput = preview;

  modal.querySelector('#ob-save').onclick = () => {
    const { actualIso, err } = preview();
    let reason = null;
    if (err > 15) {
      reason = modal.querySelector('#ob-reason').value;
      if (!reason) {
        modal.querySelector('#ob-reason-field').classList.add('shake'); setTimeout(() => modal.querySelector('#ob-reason-field').classList.remove('shake'), 320);
        showToast('A delay reason is required', 'error'); return;
      }
    }
    const actualBuffer = minutesBetween(actualIso, f.eibt);
    updateFlight(f.id, { status: 'OFF_BLOCK', actualOffBlock: actualIso, delayReasonCode: reason });
    const outcomes = getOutcomes();
    outcomes.unshift({
      id: uid('oc'), flightId: f.id, flightNumber: f.flightNumber,
      predictedBuffer: c.bufferMinutes, actualBuffer, error: err,
      normalisedVector: c.normalisedVector, weightVersionId: c.weightVersionId,
      riskLevel: c.riskLevel, dominantVariable: c.dominantVariable,
      supervisor: currentActor(), dataQuality: c.dataQuality, loggedAt: nowISO(), delayReasonCode: reason
    });
    lsSet(OUTCOMES_KEY, outcomes);
    logActivity({ action: `logged off-block (error ${fmtSigned(err)} min)`, target: f.flightNumber, category: 'offblock', severity: err > 15 ? 'warn' : 'success' });
    closeModal();
    showToast(`${f.flightNumber} off-block logged · error ${fmtSigned(err)} min`, Math.abs(err) <= 5 ? 'success' : 'notice');
    showModule('offblock');
  };
}

/* ═══ degraded mode — integration health drives input quality ═ */
function applyDegradedToFlights() {
  const integ = getIntegration();
  const flights = getFlights();
  flights.forEach(f => {
    const p = f.inputProvenance.perVariable;
    /* weather feed → heat index falls back to cached */
    if (integ.weather !== 'HEALTHY') { if (p.heatIndexC.quality === 'GOOD') { p.heatIndexC.quality = 'CACHED'; p.heatIndexC._autoW = true; } }
    else if (p.heatIndexC._autoW) { p.heatIndexC.quality = 'GOOD'; delete p.heatIndexC._autoW; }
    /* DCS feed → load factor falls back to cached */
    if (integ.dcs !== 'HEALTHY') { if (p.loadFactorPercent.quality === 'GOOD') { p.loadFactorPercent.quality = 'CACHED'; p.loadFactorPercent._autoD = true; } }
    else if (p.loadFactorPercent._autoD) { p.loadFactorPercent.quality = 'GOOD'; delete p.loadFactorPercent._autoD; }
    /* recompute keeping seed/timestamp so ONLY the data-quality flag changes */
    f.calculation = calculateFlightRisk(f, f.calculation.weightVersionId, f.calculation.calculatedAt);
  });
  saveFlights(flights);
}
function toggleIntegration(feed) {
  const integ = getIntegration();
  integ[feed] = integ[feed] === 'HEALTHY' ? 'UNHEALTHY' : 'HEALTHY';
  saveIntegration(integ);
  applyDegradedToFlights();
  renderDegradedBanner();
  logActivity({ action: `${feed} feed marked ${integ[feed]}`, target: 'Integration', category: 'integration', severity: integ[feed] === 'HEALTHY' ? 'info' : 'warn' });
  showToast(`${feed === 'weather' ? 'Weather' : 'DCS'} feed ${integ[feed] === 'HEALTHY' ? 'restored' : 'marked unhealthy'}`, integ[feed] === 'HEALTHY' ? 'success' : 'notice');
  if (currentModule === 'manager') showModule('manager');
}

/* ═══ fleet → input plumbing (used by S7 recalcs) ═══════════ */
function unitFailureProb(u) {
  const days = (Date.now() - new Date(u.lastService)) / 864e5;
  let p = (days * 8) / u.mtbfHours;   // ~8 operating hours/day
  if (u.status === 'UNSERVICEABLE') p = 1;
  else if (u.status === 'MAINTENANCE') p = Math.max(p, 0.6);
  return ENGINE.clamp(p, 0, 1);
}
function activeFleet() { return getGse().filter(u => u.status !== 'RETIRED'); }
function fleetGseRatio() { const f = activeFleet(); return { avail: f.filter(u => u.status === 'SERVICEABLE').length, total: f.length }; }
function fleetAvgFailure() {
  const f = activeFleet();
  let avg = f.length ? f.reduce((a, u) => a + unitFailureProb(u), 0) / f.length : 0.3;
  // Fleet performance adjustment: aging fleet increases aggregate failure probability
  const avgPerf = avgFleetPerfScore();
  if (avgPerf < 60) {
    const adj = ((60 - avgPerf) / 25) * 0.05; // linear 0→0.05 as score drops from 60→35
    avg = ENGINE.clamp(avg + adj, 0, 1);
  }
  return avg;
}
function applyFleetToFlight(f) { const g = fleetGseRatio(); f.rawInputs.gseAvailable = g.avail; f.rawInputs.gseTotal = g.total; f.rawInputs.mtbfFailureProb = +fleetAvgFailure().toFixed(2); }

/* donut chart (hand-built SVG) */
function donutSVG(segments, size) {
  const r = size / 2 - 10, cx = size / 2, cy = size / 2, C = 2 * Math.PI * r;
  const totalV = segments.reduce((a, s) => a + s.value, 0) || 1;
  let off = 0;
  const arcs = segments.map(s => {
    const frac = s.value / totalV, len = frac * C;
    const seg = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${s.color}" stroke-width="14"
      stroke-dasharray="${len.toFixed(1)} ${(C - len).toFixed(1)}" stroke-dashoffset="${(-off).toFixed(1)}"
      transform="rotate(-90 ${cx} ${cy})" class="donut-seg"/>`;
    off += len; return seg;
  }).join('');
  return `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">${arcs}
    <text x="${cx}" y="${cy - 2}" text-anchor="middle" class="donut-total mono">${totalV}</text>
    <text x="${cx}" y="${cy + 15}" text-anchor="middle" class="donut-lbl">flights</text></svg>`;
}

/* ═══ S6 — MANAGER DASHBOARD (key: manager) ═════════════════ */
function renderManager(el) {
  const user = currentUser();
  const isRep = user && user.role === 'AIRLINE_REP';
  /* AIRLINE_REP scoping — filter at the DATA layer, before rendering */
  let flights = getFlights();
  if (isRep) flights = flights.filter(f => f.airline === (user.airline || ''));

  const counts = { RED: 0, AMBER: 0, GREEN: 0 };
  flights.forEach(f => counts[f.calculation.riskLevel]++);
  const avgBuffer = flights.length ? Math.round(flights.reduce((a, f) => a + f.calculation.bufferMinutes, 0) / flights.length) : 0;

  const alerts = getAlerts().filter(a => !isRep || flights.some(f => f.id === a.flightId));
  const acked = alerts.filter(a => a.stage === 'ACKNOWLEDGED').length;
  const escalated = alerts.filter(a => a.stage === 'ESCALATED' || a.stage === 'UNACK_CRITICAL').length;
  const ghaWarnings = hasPermission('gha') ? ghasBelowMinimum() : [];
  const certCounts = hasPermission('gha') ? (() => {
    const activeGhas = getGhas().filter(g => g.status === 'ACTIVE');
    let certified = 0, atRisk = 0;
    activeGhas.forEach(g => {
      const cert = currentGhoCertificate(g.id);
      if (cert && cert.status === 'ISSUED') certified++; else if (cert && cert.status === 'AT_RISK') atRisk++;
    });
    return { certified, atRisk, notCertified: activeGhas.length - certified - atRisk };
  })() : null;

  const weekAgo = Date.now() - 7 * 864e5;
  const recentOc = getOutcomes().filter(o => new Date(o.loggedAt) >= weekAgo && o.dataQuality === 'GOOD');
  const mae7 = recentOc.length ? +(recentOc.reduce((a, o) => a + Math.abs(o.error), 0) / recentOc.length).toFixed(1) : 0;
  const otpOc = getOutcomes().filter(o => new Date(o.loggedAt) >= weekAgo);
  const otp = otpOc.length ? Math.round(otpOc.filter(o => o.error <= 5).length / otpOc.length * 100) : 0;

  const integ = getIntegration();
  const fleet = activeFleet();
  const gseByType = {};
  fleet.forEach(u => {
    const t = gseByType[u.typeCode] = gseByType[u.typeCode] || { name: u.type, total: 0, svc: 0, uns: 0 };
    t.total++; if (u.status === 'SERVICEABLE') t.svc++; if (u.status === 'UNSERVICEABLE') t.uns++;
  });
  /* category-level readiness (keeps the summary compact) */
  const catGroups = { POWERED: { total: 0, svc: 0 }, NON_POWERED: { total: 0, svc: 0 }, INFRASTRUCTURE: { total: 0, svc: 0 } };
  fleet.forEach(u => { const c = catGroups[u.category] ? u.category : 'POWERED'; catGroups[c].total++; if (u.status === 'SERVICEABLE') catGroups[c].svc++; });
  const fleetUns = fleet.filter(u => u.status === 'UNSERVICEABLE').length;
  const fleetSvcPct = fleet.length ? Math.round(fleet.filter(u => u.status === 'SERVICEABLE').length / fleet.length * 100) : 0;

  const outstanding = alerts.filter(a => a.stage !== 'ACKNOWLEDGED');

  /* Part C — lifecycle status distribution + any turnaround running over buffer */
  const statusCounts = { SCHEDULED: 0, IN_BLOCK: 0, OFF_BLOCK: 0 };
  flights.forEach(f => { if (statusCounts[f.status] !== undefined) statusCounts[f.status]++; });
  const overBufferFlights = flights.filter(f => f.status === 'IN_BLOCK' && f.actualInBlock
    && turnaroundElapsedInfo(f.actualInBlock, f.calculation.bufferMinutes).state === 'over');

  el.innerHTML = `
    <div class="mod-wide">
      <div class="mod-head">
        <div><h1 class="mod-title">Manager Dashboard</h1>
          <p class="mod-sub">Shift A situational awareness${isRep ? ` · <span class="rep-scope">${escapeHtml(user.airline)} flights only · read-only</span>` : ''}</p></div>
      </div>

      <!-- KPI STRIP -->
      <div class="kpi-strip">
        <div class="kpi"><span class="kpi-num mono" data-count="${flights.length}">0</span><span class="kpi-lbl">Flights today</span></div>
        <div class="kpi"><span class="kpi-num mono" data-count="${otp}" data-suffix="%">0</span><span class="kpi-lbl">On-time perf.</span></div>
        <div class="kpi"><span class="kpi-num mono" data-count="${avgBuffer}" data-suffix=" min">0</span><span class="kpi-lbl">Avg buffer</span></div>
        <div class="kpi"><span class="kpi-num mono">${acked}<span class="kpi-sep">/</span>${escalated}</span><span class="kpi-lbl">Ack / escalated</span></div>
        <div class="kpi"><span class="kpi-num mono" data-count="${mae7}" data-suffix=" min" data-dec="1">0</span><span class="kpi-lbl">MAE · 7 days</span></div>
        ${certCounts ? `<div class="kpi kpi-clickable" id="kpi-gho" title="View GHO Registry">
          <span class="kpi-num mono">${certCounts.certified}<span class="kpi-sep">/</span>${certCounts.atRisk}<span class="kpi-sep">/</span>${certCounts.notCertified}</span>
          <span class="kpi-lbl">Certified / At risk / Not certified</span>
        </div>` : ''}
      </div>

      <!-- ESCALATED / UNACK PANEL -->
      <section class="card esc-panel ${outstanding.length ? 'has' : ''}" id="esc-panel">
        <h3 class="card-h">Escalated &amp; unacknowledged</h3>
        <div id="esc-body">${escBodyHtml(outstanding)}</div>
        <p class="esc-note mono">Demo timers compressed · stages (SMS → escalation → critical) preserved</p>
      </section>

      <!-- TURNAROUND STATUS PANEL (Part C — reuses .esc-panel/.esc-row) -->
      <section class="card esc-panel ${overBufferFlights.length ? 'has' : ''}" id="status-panel">
        <h3 class="card-h">Turnaround status</h3>
        <div class="status-counts mono">
          <span><strong>${statusCounts.SCHEDULED}</strong> Scheduled</span>
          <span><strong>${statusCounts.IN_BLOCK}</strong> In-block</span>
          <span><strong>${statusCounts.OFF_BLOCK}</strong> Off-block</span>
        </div>
        <div id="status-body">${overBufferFlights.length ? overBufferFlights.map(f => {
          const info = turnaroundElapsedInfo(f.actualInBlock, f.calculation.bufferMinutes);
          return `<div class="esc-row r-RED">
            <span class="esc-fl mono">${escapeHtml(f.flightNumber)}</span>
            <span class="esc-stage stage-ESCALATED">OVER BUFFER</span>
            <span class="esc-time mono" data-mgr-elapsed data-since="${f.actualInBlock}">${mmss(info.elapsedMs)}</span>
            <span class="esc-lbl">elapsed · over by ${info.overBy} min</span></div>`;
        }).join('') : '<div class="esc-empty">✓ All in-block turnarounds within buffer.</div>'}</div>
      </section>

      ${hasPermission('gha') ? `
      <!-- GHA PERFORMANCE PANEL (reuses .esc-panel/.esc-row) -->
      <section class="card esc-panel ${ghaWarnings.length ? 'has' : ''}" id="gha-warn-panel">
        <h3 class="card-h">GHA performance</h3>
        <div id="gha-warn-body">${ghaWarnings.length ? ghaWarnings.map(w => ghaWarningLineHtml(w)).join('') : '<div class="esc-empty">✓ All ground handling agents at or above minimum performance.</div>'}</div>
      </section>` : ''}

      <div class="mgr-grid">
        <!-- RISK DISTRIBUTION -->
        <section class="card"><h3 class="card-h">Risk distribution</h3>
          <div class="donut-wrap">${donutSVG([{ value: counts.RED, color: 'var(--red)' }, { value: counts.AMBER, color: 'var(--amber)' }, { value: counts.GREEN, color: 'var(--green)' }], 150)}
            <div class="donut-legend">
              <span><i style="background:var(--red)"></i>RED ${counts.RED}</span>
              <span><i style="background:var(--amber)"></i>AMBER ${counts.AMBER}</span>
              <span><i style="background:var(--green)"></i>GREEN ${counts.GREEN}</span>
            </div></div>
        </section>

        <!-- BUFFER TIMELINE -->
        <section class="card"><h3 class="card-h">Buffer across today (EIBT order)</h3>
          <div class="timeline-wrap">${bufferTimelineSVG(flights)}</div>
        </section>
      </div>

      <!-- FLIGHT TABLE -->
      <section class="card"><h3 class="card-h">Flights</h3>
        <div class="table-scroll"><table class="mgr-tbl">
          <thead><tr><th>Flight</th><th>Stand</th><th>EIBT</th><th>Buffer</th><th>TOBT</th><th>Risk</th><th>Turnaround</th><th>Ack</th></tr></thead>
          <tbody>${flights.slice().sort((a, b) => new Date(a.eibt) - new Date(b.eibt)).map(f => {
            let turnCell = '<span class="mono" style="color:var(--text-mute)">Scheduled</span>';
            if (f.status === 'IN_BLOCK' && f.actualInBlock) {
              const info = turnaroundElapsedInfo(f.actualInBlock, f.calculation.bufferMinutes);
              const cls = info.state === 'over' ? 'bad' : info.state === 'approaching' ? 'warn' : 'good';
              turnCell = `<span class="orc-err ${cls} mono"><span data-mgr-elapsed data-since="${f.actualInBlock}">${mmss(info.elapsedMs)}</span> elapsed</span>`;
            } else if (f.status === 'OFF_BLOCK') {
              turnCell = `<span class="mono" style="color:var(--text-mute)">Departed ${hhmm(f.actualOffBlock)}</span>`;
            }
            return `
            <tr><td class="mono">${escapeHtml(f.flightNumber)}</td><td>${f.stand}</td><td class="mono">${hhmm(f.eibt)}</td>
              <td class="mono">${f.calculation.bufferMinutes} min</td><td class="mono">${hhmm(f.calculation.tobt)}</td>
              <td>${riskChip(f.calculation.riskLevel)}</td>
              <td>${turnCell}</td>
              <td>${f.calculation.riskLevel === 'GREEN' ? '—' : f.ackStatus === 'ACKNOWLEDGED' ? '<span class="ack-yes">✓ Ack</span>' : '<span class="ack-no">Pending</span>'}</td></tr>`;
          }).join('')}
          </tbody></table></div>
      </section>

      <!-- BALANCED ROW: fleet readiness (by category) + integration health -->
      <div class="mgr-grid">
        <!-- GSE FLEET READINESS -->
        <section class="card"><h3 class="card-h">GSE fleet readiness</h3>
          <div class="gse-readiness">
            <div class="gro"><span class="gro-pct mono" style="color:${fleetSvcPct >= 70 ? 'var(--green)' : fleetSvcPct >= 45 ? 'var(--amber)' : 'var(--red)'}">${fleetSvcPct}%</span>
              <span class="gro-lbl">serviceable · ${fleet.length} units${fleetUns ? ` · <strong>${fleetUns} U/S</strong>` : ''}</span></div>
            <div class="gr-cats">
              ${[['POWERED', '⚡ Powered'], ['NON_POWERED', '📦 Non-powered'], ['INFRASTRUCTURE', '🏗 Infrastructure']].map(([k, label]) => {
                const g = catGroups[k] || { total: 0, svc: 0 }; const pct = g.total ? Math.round(g.svc / g.total * 100) : 0;
                return `<div class="grc-row"><span class="grc-lbl">${label}</span>
                  <span class="grc-bar"><span style="width:${pct}%;background:${pct >= 70 ? 'var(--green)' : pct >= 45 ? 'var(--amber)' : 'var(--red)'}"></span></span>
                  <span class="mono grc-val">${g.svc}/${g.total}</span></div>`; }).join('')}
            </div>
          </div>
        </section>

        <!-- INTEGRATION HEALTH -->
        <section class="card"><h3 class="card-h">Integration health</h3>
          <div class="integ-rows">
            <div class="integ-row"><span class="integ-dot ${integ.weather === 'HEALTHY' ? 'ok' : 'down'}"></span>
              <span class="integ-name">Weather feed</span><span class="integ-status">${integ.weather}</span>
              ${isRep ? '' : `<button class="btn btn-ghost btn-xs" data-feed="weather" type="button">${integ.weather === 'HEALTHY' ? 'Mark unhealthy' : 'Restore'}</button>`}</div>
            <div class="integ-row"><span class="integ-dot ${integ.dcs === 'HEALTHY' ? 'ok' : 'down'}"></span>
              <span class="integ-name">DCS feed</span><span class="integ-status">${integ.dcs}</span>
              ${isRep ? '' : `<button class="btn btn-ghost btn-xs" data-feed="dcs" type="button">${integ.dcs === 'HEALTHY' ? 'Mark unhealthy' : 'Restore'}</button>`}</div>
          </div>
        </section>
      </div>

      <!-- GSE AVAILABILITY BY TYPE (full width, multi-column) -->
      <section class="card"><h3 class="card-h">GSE availability by type <span class="card-h-tag mono">${Object.keys(gseByType).length} types</span></h3>
        <div class="gse-type-grid">${Object.values(gseByType).map(t => { const pct = t.total ? t.svc / t.total * 100 : 0;
          return `<div class="gtg-item">
            <div class="gtg-top"><span class="gtg-name">${escapeHtml(t.name)}</span>
              <span class="mono gtg-val ${t.uns ? 'has-uns' : ''}">${t.svc}/${t.total}${t.uns ? ` · ${t.uns} U/S` : ''}</span></div>
            <div class="gtg-bar"><span style="width:${pct}%;background:${pct >= 70 ? 'var(--green)' : pct >= 45 ? 'var(--amber)' : 'var(--red)'}"></span></div>
          </div>`; }).join('')}</div>
      </section>
    </div>`;

  /* count-up KPIs */
  el.querySelectorAll('.kpi-num[data-count]').forEach(node => {
    const target = Number(node.dataset.count), suffix = node.dataset.suffix || '', dec = Number(node.dataset.dec || 0);
    const start = performance.now();
    (function frame(now) {
      const p = Math.min((now - start) / 700, 1); const v = target * (1 - Math.pow(1 - p, 3));
      node.textContent = (dec ? v.toFixed(dec) : Math.round(v)) + suffix;
      if (p < 1) requestAnimationFrame(frame); else node.textContent = (dec ? target.toFixed(dec) : target) + suffix;
    })(start);
  });

  if (!isRep) el.querySelectorAll('[data-feed]').forEach(b => b.onclick = () => toggleIntegration(b.dataset.feed));

  const ghaWarnBody = el.querySelector('#gha-warn-body');
  if (ghaWarnBody) ghaWarnBody.onclick = e => {
    const row = e.target.closest('[data-gha-id]'); if (!row) return;
    ghaDetailTab = 'performance';
    showModule('gha');
    openGhaDetail(row.dataset.ghaId);
  };

  const kpiGho = el.querySelector('#kpi-gho');
  if (kpiGho) kpiGho.onclick = () => { ghaModuleTab = 'registry'; showModule('gha'); };
}

function escBodyHtml(outstanding) {
  if (!outstanding.length) return `<div class="esc-empty">✓ All alerts acknowledged.</div>`;
  return outstanding.map(a => {
    const f = getFlight(a.flightId);
    const outstandingMs = Date.now() - new Date(a.createdAt);
    return `<div class="esc-row r-${a.riskLevel}">
      <span class="esc-fl mono">${escapeHtml(a.flightNumber)}</span>
      ${riskChip(a.riskLevel)}
      <span class="esc-stage stage-${a.stage}">${a.stage.replace(/_/g, ' ')}</span>
      <span class="esc-time mono" data-created="${a.createdAt}">${mmss(outstandingMs)}</span>
      <span class="esc-lbl">outstanding</span></div>`;
  }).join('');
}
function tickManagerLive() {
  document.querySelectorAll('.esc-time[data-created]').forEach(el => {
    el.textContent = mmss(Date.now() - new Date(el.dataset.created));
  });
  document.querySelectorAll('[data-mgr-elapsed]').forEach(el => {
    el.textContent = mmss(Date.now() - new Date(el.dataset.since));
  });
}

/* buffer timeline — area + risk-coloured points */
function bufferTimelineSVG(flights) {
  const fs = flights.slice().sort((a, b) => new Date(a.eibt) - new Date(b.eibt));
  if (!fs.length) return '<p class="rs-none">No flights.</p>';
  const W = 460, H = 150, padL = 30, padB = 22, padT = 12, padR = 10;
  const maxB = 55, minB = 20;
  const x = i => padL + (fs.length === 1 ? 0.5 : i / (fs.length - 1)) * (W - padL - padR);
  const y = b => padT + (1 - (b - minB) / (maxB - minB)) * (H - padT - padB);
  const pts = fs.map((f, i) => [x(i), y(f.calculation.bufferMinutes)]);
  const area = polyPath(pts) + ` L${pts[pts.length - 1][0].toFixed(1)} ${H - padB} L${pts[0][0].toFixed(1)} ${H - padB} Z`;
  const grid = [20, 30, 40, 50].map(v => `<line x1="${padL}" y1="${y(v).toFixed(1)}" x2="${W - padR}" y2="${y(v).toFixed(1)}" class="tl-grid"/><text x="4" y="${(y(v) + 3).toFixed(1)}" class="tl-axis mono">${v}</text>`).join('');
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" class="tl-svg">
    ${grid}
    <path d="${area}" class="tl-area"/>
    <path d="${polyPath(pts)}" class="tl-line"/>
    ${fs.map((f, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(f.calculation.bufferMinutes).toFixed(1)}" r="4" fill="${riskColor(f.calculation.riskLevel)}" class="tl-pt"/>`).join('')}
    ${fs.map((f, i) => `<text x="${x(i).toFixed(1)}" y="${H - 6}" text-anchor="middle" class="tl-xlbl mono">${hhmm(f.eibt).slice(0, 5)}</text>`).join('')}
  </svg>`;
}

/* ═══ S7 — EQUIPMENT REGISTER (key: equipment) ══════════════ */
/* ═══ Ground Handling Agents (GHAs) — Multan · MUX ═════════════
   Each GSE unit is operated by one of the station's ground handling
   agents (or the airport authority for safety/fixed infrastructure).
   The agents themselves are a real entity in `orbis_ghas` (see the GHA
   Management module below) — GSE units reference one by `ghaId`. */
/* which agent operates each equipment type by default, at seed time only */
const GHA_BY_TYPE = {
  TUG: 'DNATA', TLT: 'DNATA', PBS: 'DNATA', CAT: 'DNATA', AMB: 'DNATA', PCA: 'DNATA', ASU: 'DNATA',
  BL: 'PIA', BT: 'PIA', GPU: 'PIA', PWT: 'PIA', LST: 'PIA', BCD: 'PIA',
  CL: 'SAPS', FLT: 'SAPS', FLK: 'SAPS', CPD: 'SAPS', ULD: 'SAPS',
  DCT: 'RAS', SWP: 'RAS', CHK: 'RAS', CNS: 'RAS', MSH: 'RAS', JCK: 'RAS', COV: 'RAS',
  RFF: 'AUTH', BCV: 'AUTH', PBB: 'AUTH', FHS: 'AUTH'
};
/* deterministic per-agent accent colour, by insertion order in orbis_ghas —
   the 5 seeded agents land on exactly their original hand-picked colours;
   any agent added later gets the next colour in the cycle */
const GHA_PALETTE = ['#2563EB', '#16A34A', '#D97706', '#7C3AED', '#64748B', '#DB2777', '#0891B2', '#EA580C'];
function ghaColorFor(id) {
  if (!id) return '#94A3B8';
  const idx = getGhas().findIndex(g => g.id === id);
  return GHA_PALETTE[(idx >= 0 ? idx : 0) % GHA_PALETTE.length];
}
function ghaOf(u) { return (u && u.ghaId) || null; }
function ghaShort(id) { const g = getGha(id); return g ? g.code : 'Unassigned'; }
function ghaBadge(id) {
  const g = getGha(id);
  return `<span class="gha-badge" style="--gha:${ghaColorFor(id)}">${escapeHtml(g ? g.code : 'Unassigned')}</span>`;
}
function ghaOwnershipLabel(ownership) { return ownership === 'AIRPORT_SUBSIDIARY' ? 'Airport-owned & operated' : 'Private ground handler'; }
function ghaAirlinesLabel(g) { return (g.airlinesServed && g.airlinesServed.length) ? g.airlinesServed.join(' · ') : 'No scheduled airlines'; }
/* shared contract-expiry read — 'ok' / 'expiring' (<=90d) / 'expired' (<0d) */
function ghaContractState(g) {
  const daysLeft = Math.floor((new Date(g.contractEnd).getTime() - Date.now()) / 864e5);
  const state = daysLeft < 0 ? 'expired' : daysLeft <= 90 ? 'expiring' : 'ok';
  return { state, daysLeft };
}
function ghaFleetBreakdown(id) {
  const units = getGse().filter(u => u.ghaId === id);
  const cats = { POWERED: 0, NON_POWERED: 0, INFRASTRUCTURE: 0 };
  units.forEach(u => { cats[u.category] = (cats[u.category] || 0) + 1; });
  return { units, cats, total: units.length };
}

/* ═══ GHA PERFORMANCE SCORING ENGINE ════════════════════════
   Pure functions only — no DOM access, same discipline as the flight-risk
   ENGINE above. computeGhaPerformance() reads the CURRENT live orbis_gse /
   orbis_ghas / orbis_flights snapshot (this prototype tracks no per-day
   status history, so serviceability is a current-snapshot approximation,
   same as the deployment/fuel figures which are inherently "this month"
   fields on the equipment record). Historical months in Part C are
   synthesised by feeding plausible period-appropriate input figures through
   these exact same functions — the math is always real, only the inputs
   for past periods are constructed rather than read live. */

/* typical litres/hour per equipment type — the fuel-efficiency benchmark.
   Single source of truth: the equipment seed's TYPE_FIN.lph pulls from here
   too, so the benchmark used to grade a unit is the same one used to seed
   its "normal" consumption. */
const GSE_FUEL_BENCHMARK = {
  TUG: 9, TLT: 14, BL: 4, BT: 3.5, CL: 11, GPU: 2.5, ASU: 8, PCA: 6,
  FLT: 10, PWT: 5, LST: 5, DCT: 16, CAT: 9, PBS: 4, AMB: 8, FLK: 4,
  SWP: 11, RFF: 28, BCV: 4
};

/* ── period helpers ('YYYY-MM' strings) ── */
function currentPeriod() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; }
function shiftPeriod(period, deltaMonths) {
  const [y, m] = period.split('-').map(Number);
  const d = new Date(y, m - 1 + deltaMonths, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function previousPeriod(period) { return shiftPeriod(period, -1); }
function last6Periods(endPeriod) { const end = endPeriod || currentPeriod(); return [-5, -4, -3, -2, -1, 0].map(d => shiftPeriod(end, d)); }
function periodLabel(period) { const [y, m] = period.split('-').map(Number); return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'short', year: 'numeric' }); }
function daysInMonth(period) { const [y, m] = period.split('-').map(Number); return new Date(y, m, 0).getDate(); }
/* days to measure deployment capacity against: full month if it's already
   elapsed, days-so-far if it's the current month — same reference the
   Equipment Register's utilisation bar uses */
function referenceDaysForPeriod(period) { return period === currentPeriod() ? new Date().getDate() : daysInMonth(period); }

/* ── B1-B5: pure scoring math ── */
const GHA_PERF = {
  deploymentScore(hoursAchieved, hoursCapacity) {
    if (hoursCapacity <= 0) return 100;
    return Math.round(ENGINE.clamp(hoursAchieved / hoursCapacity, 0, 1) * 100);
  },
  serviceabilityScore(serviceableCount, totalCount) {
    if (totalCount <= 0) return 100;
    return Math.round(ENGINE.clamp(serviceableCount / totalCount, 0, 1) * 100);
  },
  suitabilityScore(typesCovered, typesRequired) {
    if (typesRequired <= 0) return 100;
    return Math.round(ENGINE.clamp(typesCovered / typesRequired, 0, 1) * 100);
  },
  /* 100 at-or-under the benchmark rate, linear falloff to 0 at 2x benchmark */
  fuelEfficiencyScore(actualRate, benchmarkRate) {
    if (benchmarkRate <= 0) return 100;
    const ratio = actualRate / benchmarkRate;
    if (ratio <= 1) return 100;
    return Math.round(ENGINE.clamp(100 - (ratio - 1) * 100, 0, 100));
  },
  overallScore(metrics, weights) {
    return Math.round(
      metrics.deployment * weights.deployment + metrics.serviceability * weights.serviceability +
      metrics.suitability * weights.suitability + metrics.fuelEfficiency * weights.fuelEfficiency
    );
  }
};

/* which aircraft types a GHA actually needs to cover, cross-referenced from
   the airlines it serves against real flights on the board */
function requiredAircraftTypesForGha(gha) {
  if (!gha || !gha.airlinesServed || !gha.airlinesServed.length) return [];
  const types = new Set();
  const flights = getFlights();
  gha.airlinesServed.forEach(code => flights.filter(f => f.airline === code).forEach(f => { if (f.aircraftType) types.add(f.aircraftType); }));
  return [...types];
}
function suitabilityCoverage(ghaId, requiredTypes) {
  const units = getGse().filter(u => u.ghaId === ghaId && u.status === 'SERVICEABLE');
  const coveredTypes = requiredTypes.filter(t => units.some(u => { const sf = u.suitableFor || ['ALL']; return sf.includes('ALL') || sf.includes(t); }));
  return { covered: coveredTypes.length, required: requiredTypes.length, coveredTypes };
}
function ghaMetricLabel(key) { return { deployment: 'Deployment', serviceability: 'Serviceability', suitability: 'Suitability', fuelEfficiency: 'Fuel Efficiency' }[key] || key; }
function ghaWeakestMetric(metrics) {
  let weakestKey = 'deployment';
  Object.keys(metrics).forEach(k => { if (metrics[k] < metrics[weakestKey]) weakestKey = k; });
  return { key: weakestKey, label: ghaMetricLabel(weakestKey), score: metrics[weakestKey] };
}
/* green ≥ threshold+10, amber within 10 points of threshold, red below threshold */
function ghaScoreTier(score, threshold) {
  if (score < threshold) return 'red';
  if (score < threshold + 10) return 'amber';
  return 'green';
}

/* compute one GHA's scorecard for a period from the CURRENT live fleet
   snapshot (see file-header note above on the current-snapshot approach) */
function computeGhaPerformance(ghaId, period) {
  const gha = getGha(ghaId);
  const units = getGse().filter(u => u.ghaId === ghaId && u.status !== 'RETIRED');
  const config = getActiveGhaPerfConfig();

  const refDays = referenceDaysForPeriod(period);
  const hoursCapacity = units.length * refDays * 8;
  const hoursAchieved = units.reduce((s, u) => s + ((u.nonFinancial && u.nonFinancial.deploymentHoursThisMonth) || 0), 0);
  const deployment = GHA_PERF.deploymentScore(hoursAchieved, hoursCapacity);

  const serviceableCount = units.filter(u => u.status === 'SERVICEABLE').length;
  const statusRatio = GHA_PERF.serviceabilityScore(serviceableCount, units.length);
  const svcUnits = units.filter(u => u.status === 'SERVICEABLE');
  const avgPerfOfSvc = svcUnits.length
    ? Math.round(svcUnits.reduce((s, u) => s + ((u.nonFinancial && u.nonFinancial.performanceScore && u.nonFinancial.performanceScore.finalScore) || 50), 0) / svcUnits.length)
    : 50;
  const serviceability = Math.round(0.80 * statusRatio + 0.20 * avgPerfOfSvc);

  const requiredTypes = requiredAircraftTypesForGha(gha);
  const cov = suitabilityCoverage(ghaId, requiredTypes);
  const suitability = GHA_PERF.suitabilityScore(cov.covered, cov.required);

  const powered = units.filter(u => u.category === 'POWERED');
  let fuelScoreSum = 0; const fuelRatios = [];
  powered.forEach(u => {
    const f = u.financial || {};
    const hrs = (u.nonFinancial && u.nonFinancial.deploymentHoursThisMonth) || 0;
    if (f.fuelType !== 'DIESEL' || hrs <= 0) { fuelScoreSum += 100; return; }
    const lph = GSE_FUEL_BENCHMARK[u.typeCode] || 6;
    const actualRate = ((u.nonFinancial && u.nonFinancial.fuelConsumptionThisMonth) || 0) / hrs;
    fuelRatios.push(actualRate / lph);
    fuelScoreSum += GHA_PERF.fuelEfficiencyScore(actualRate, lph);
  });
  const fuelEfficiency = powered.length ? Math.round(fuelScoreSum / powered.length) : 100;
  const fuelAvgRatioPct = fuelRatios.length ? Math.round((fuelRatios.reduce((a, b) => a + b, 0) / fuelRatios.length - 1) * 100) : null;

  const metrics = { deployment, serviceability, suitability, fuelEfficiency };
  const weights = config.params.metricWeights;
  const overallScore = GHA_PERF.overallScore(metrics, weights);
  const belowMinimum = overallScore < config.params.minimumThreshold;

  return {
    ghaId, period, metrics, overallScore, belowMinimum, computedAt: nowISO(),
    detail: {
      deployment: `${hoursAchieved} of ${hoursCapacity} possible hours`,
      serviceability: `${serviceableCount} of ${units.length} svc (status ${statusRatio}% · avg perf ${avgPerfOfSvc}% → blend ${serviceability}%)`,
      suitability: cov.required ? `${cov.covered} of ${cov.required} required types covered` : 'No airlines served — nothing required',
      fuelEfficiency: fuelAvgRatioPct == null ? 'No diesel fuel usage recorded' : (fuelAvgRatioPct <= 0 ? `${Math.abs(fuelAvgRatioPct)}% under benchmark` : `${fuelAvgRatioPct}% above benchmark`)
    }
  };
}

/* upsert one record (by ghaId+period) and, only when explicitly asked to
   log, record a single activity entry the moment a GHA newly crosses below
   minimum relative to the PRIOR month — never re-logged on re-renders, and
   de-duplicated so repeat recomputes in the same month don't spam the feed */
function upsertGhaPerfRecord(result, opts) {
  const doLog = !!(opts && opts.log);
  const records = getGhaPerfRecords();
  const existingIdx = records.findIndex(r => r.ghaId === result.ghaId && r.period === result.period);
  const record = Object.assign({ id: existingIdx >= 0 ? records[existingIdx].id : uid('gp') }, result);
  if (existingIdx >= 0) records[existingIdx] = record; else records.push(record);
  saveGhaPerfRecords(records);

  if (doLog && record.belowMinimum) {
    const prev = getGhaPerfRecord(record.ghaId, previousPeriod(record.period));
    const wasAboveBefore = !prev || !prev.belowMinimum;
    const gha = getGha(record.ghaId);
    const alreadyLogged = gha && getActivity().some(a => a.category === 'gha-performance' && a.target === gha.name && a.action.includes(record.period));
    if (wasAboveBefore && gha && !alreadyLogged) {
      const weak = ghaWeakestMetric(record.metrics);
      logActivity({
        action: `fell below minimum performance for ${periodLabel(record.period)} — driven by low ${weak.label.toLowerCase()} (${weak.score}%)`,
        target: gha.name, category: 'gha-performance', severity: 'warn'
      });
    }
  }
  return record;
}

/* recompute every active GHA for the current month; called once after
   history is seeded, and again after any config save so the effect is
   immediately visible */
function recomputeAllGhaPerformance(opts) {
  const log = !opts || opts.log !== false;
  const period = currentPeriod();
  return getGhas().filter(g => g.status === 'ACTIVE').map(g => upsertGhaPerfRecord(computeGhaPerformance(g.id, period), { log }));
}

/* ═══ EQUIPMENT AGE-BASED PERFORMANCE SCORING ENGINE ════════
   Pure function, no DOM access — same discipline as the risk
   engine and GHA performance scoring. Computes a 0-100 score
   from age decay, maintenance bonus, and reactivation penalty. */

function computeEquipmentPerformanceScore(unit, config) {
  const fin = unit.financial || {};
  const acqDate = fin.acquisitionDate ? new Date(fin.acquisitionDate) : new Date();
  const ageYears = Math.max(0, (Date.now() - acqDate.getTime()) / (365.25 * 864e5));
  const curve = (config.perCategoryCurves || {})[unit.category] || { yearlyDeclinePercent: 8, floorPercent: 35 };
  const floor = curve.floorPercent;

  // B1: base age decay
  const baseFromAge = Math.max(floor, 100 - (ageYears * curve.yearlyDeclinePercent));
  let score = baseFromAge;

  // B2: maintenance bonus — any maintLog entry within last 90 days
  const now = Date.now();
  const d90 = 90 * 864e5;
  const log = unit.maintLog || [];
  const hasRecentMaint = log.some(e => (now - new Date(e.date).getTime()) < d90);
  let maintenanceBonusApplied = false;
  if (hasRecentMaint) {
    score = Math.min(100, score + config.maintenanceBonusPercent);
    maintenanceBonusApplied = true;
  }

  // B3: reactivation penalty — unit is SERVICEABLE now and has a
  //     maintLog entry within last 30 days with repair/corrective keywords
  //     or a log entry type containing 'repair', 'corrective', 'overhaul',
  //     'reactivat' suggesting it was recently brought back into service
  const d30 = 30 * 864e5;
  const reactivationKeywords = ['repair', 'corrective', 'overhaul', 'reactivat', 'restored', 'fixed'];
  let reactivationPenaltyApplied = false;
  if (unit.status === 'SERVICEABLE') {
    const hasRecentReactivation = log.some(e => {
      const age = now - new Date(e.date).getTime();
      if (age > d30) return false;
      const txt = ((e.type || '') + ' ' + (e.notes || '')).toLowerCase();
      return reactivationKeywords.some(kw => txt.includes(kw));
    });
    if (hasRecentReactivation) {
      score = Math.max(floor, score - config.reactivationPenaltyPercent);
      reactivationPenaltyApplied = true;
    }
  }

  // B4: final score
  const finalScore = Math.round(ENGINE.clamp(score, floor, 100));

  return {
    finalScore, ageYears: +ageYears.toFixed(1), baseFromAge: Math.round(baseFromAge),
    maintenanceBonusApplied, reactivationPenaltyApplied,
    category: unit.category, curveUsed: curve
  };
}

function recomputeAllEquipmentScores() {
  const fleet = getGse();
  const config = getActiveEquipPerfConfig().params;
  fleet.forEach(u => {
    u.nonFinancial = u.nonFinancial || {};
    u.nonFinancial.performanceScore = computeEquipmentPerformanceScore(u, config);
  });
  saveGse(fleet);
}

function avgFleetPerfScore(ghaId) {
  let fleet = getGse().filter(u => u.status !== 'RETIRED');
  if (ghaId) fleet = fleet.filter(u => ghaOf(u) === ghaId);
  if (!fleet.length) return 0;
  return Math.round(fleet.reduce((s, u) => {
    const ps = u.nonFinancial && u.nonFinancial.performanceScore;
    return s + (ps ? ps.finalScore : 50);
  }, 0) / fleet.length);
}

function unitsNearFloor(ghaId) {
  const config = getActiveEquipPerfConfig().params;
  let fleet = getGse();
  if (ghaId) fleet = fleet.filter(u => ghaOf(u) === ghaId);
  return fleet.filter(u => {
    if (u.status === 'RETIRED') return false;
    const ps = u.nonFinancial && u.nonFinancial.performanceScore;
    if (!ps) return false;
    const curve = (config.perCategoryCurves || {})[u.category];
    if (!curve) return false;
    return ps.finalScore <= curve.floorPercent + 5;
  });
}

/* ═══ GHO CERTIFICATION EVALUATION (pure functions, no DOM access) ══
   Reads orbis_gha_performance — never recomputes or duplicates the scoring
   logic above, only evaluates already-computed monthly scores against the
   certification rules in orbis_gha_perf_config. */

/* up to the last 12 monthly records for a GHA, chronological order —
   fewer than 12 is expected given the 6-month seed; callers must not
   fabricate missing months to pad the window out */
function ghoEvaluationWindow(ghaId) {
  return getGhaPerfRecords().filter(r => r.ghaId === ghaId).sort((a, b) => a.period.localeCompare(b.period)).slice(-12);
}

function evaluateGhoEligibility(ghaId) {
  const config = getActiveGhaPerfConfig();
  const window = ghoEvaluationWindow(ghaId);
  const zeroMetrics = { deployment: 0, serviceability: 0, suitability: 0, fuelEfficiency: 0 };
  if (!window.length) {
    return {
      eligible: false, trailingAverageScore: 0, monthsBelow: 0, monthsAvailable: 0,
      windowFrom: null, windowTo: null, basisMetrics: zeroMetrics,
      reasonIneligible: 'No performance history available yet.'
    };
  }
  const avg = key => Math.round(window.reduce((a, r) => a + r.metrics[key], 0) / window.length);
  const trailingAverageScore = Math.round(window.reduce((a, r) => a + r.overallScore, 0) / window.length);
  const monthsBelow = window.filter(r => r.overallScore < config.params.minimumThreshold).length;
  const basisMetrics = { deployment: avg('deployment'), serviceability: avg('serviceability'), suitability: avg('suitability'), fuelEfficiency: avg('fuelEfficiency') };

  const avgFail = trailingAverageScore < config.params.ghoAnnualThreshold;
  const monthsFail = monthsBelow > config.params.ghoMaxMonthsBelow;
  const eligible = !avgFail && !monthsFail;
  let reasonIneligible = null;
  if (avgFail && monthsFail) {
    reasonIneligible = `Trailing average ${trailingAverageScore}% is below the ${config.params.ghoAnnualThreshold}% required, and ${monthsBelow} month(s) fell below minimum performance (max ${config.params.ghoMaxMonthsBelow} allowed).`;
  } else if (avgFail) {
    reasonIneligible = `Trailing average ${trailingAverageScore}% is below the ${config.params.ghoAnnualThreshold}% required.`;
  } else if (monthsFail) {
    reasonIneligible = `${monthsBelow} month(s) fell below minimum performance — only ${config.params.ghoMaxMonthsBelow} allowed within the window.`;
  }

  return {
    eligible, trailingAverageScore, monthsBelow, monthsAvailable: window.length,
    windowFrom: window[0].period, windowTo: window[window.length - 1].period,
    basisMetrics, reasonIneligible
  };
}

/* one evaluation pass across every active GHA. Issues, holds, downgrades to
   AT_RISK, revokes (only on a SECOND consecutive failing pass — the current
   status itself is the "was this already at risk?" flag, mirroring the
   risk-engine's staged escalation instead of a full state machine), and
   expires certificates whose validity window has passed. Returns a summary
   for the "Re-evaluate now" toast. */
function recomputeGhoStatuses() {
  const certs = getGhoCertificates();
  const config = getActiveGhaPerfConfig();
  const evalNow = nowISO();
  const summary = { issued: 0, atRisk: 0, revoked: 0, expired: 0, renewed: 0 };
  const actor = 'System (GHO evaluation)';

  getGhas().filter(g => g.status === 'ACTIVE').forEach(gha => {
    const evalResult = evaluateGhoEligibility(gha.id);
    let current = certs.filter(c => c.ghaId === gha.id && (c.status === 'ISSUED' || c.status === 'AT_RISK'))
      .sort((a, b) => new Date(b.issuedAt) - new Date(a.issuedAt))[0] || null;

    if (current && new Date(current.expiresAt) <= new Date(evalNow)) {
      current.status = 'EXPIRED';
      logActivity({ action: 'GHO certificate expired', target: gha.name, category: 'gho', severity: 'warn', actor });
      summary.expired++;
      current = null;   // immediately re-evaluate for a fresh one below
    }

    if (!current) {
      if (evalResult.eligible && evalResult.monthsAvailable > 0) {
        const issuedAt = evalNow;
        const nc = {
          id: uid('ghoc'), certificateNumber: nextGhoCertificateNumber(certs), ghaId: gha.id, periodType: 'ANNUAL',
          evaluationWindow: { from: periodStartISO(evalResult.windowFrom), to: periodEndISO(evalResult.windowTo) },
          trailingAverageScore: evalResult.trailingAverageScore, monthsBelow: evalResult.monthsBelow,
          status: 'ISSUED', issuedAt, expiresAt: addMonthsISO(issuedAt, config.params.ghoValidityMonths),
          revokedAt: null, revokedReason: null, basisMetrics: evalResult.basisMetrics
        };
        certs.push(nc);
        logActivity({ action: 'GHO certificate issued', target: gha.name, category: 'gho', severity: 'success', actor });
        summary.issued++;
      }
      return;
    }

    if (evalResult.eligible) {
      if (current.status === 'AT_RISK') {
        current.status = 'ISSUED';
        logActivity({ action: 'GHO certificate renewed to good standing', target: gha.name, category: 'gho', severity: 'success', actor });
        summary.renewed++;
      }
    } else if (current.status === 'ISSUED') {
      current.status = 'AT_RISK';
      logActivity({ action: `GHO certificate moved to at-risk — ${evalResult.reasonIneligible}`, target: gha.name, category: 'gho', severity: 'warn', actor });
      summary.atRisk++;
    } else if (current.status === 'AT_RISK') {
      current.status = 'REVOKED';
      current.revokedAt = evalNow;
      current.revokedReason = evalResult.reasonIneligible;
      logActivity({ action: `GHO certificate revoked — ${evalResult.reasonIneligible}`, target: gha.name, category: 'gho', severity: 'danger', actor });
      summary.revoked++;
    }
  });

  saveGhoCertificates(certs);
  return summary;
}

/* ═══ GHO certificate document (Part C) ═════════════════════
   A distinct, formal visual component — deliberately not styled like the
   rest of the app's operational cards. Reused by the drawer's "View
   Certificate" button, the registry's row click, and certificate history. */
function ghoStatusInfo(status) {
  return {
    ISSUED: { label: 'Certified', cls: 'gho-issued' },
    AT_RISK: { label: 'At Risk', cls: 'gho-atrisk' },
    REVOKED: { label: 'Revoked', cls: 'gho-revoked' },
    EXPIRED: { label: 'Expired', cls: 'gho-expired' },
    NONE: { label: 'Not Certified', cls: 'gho-none' }
  }[status || 'NONE'];
}
/* the status of the most recent certificate ever issued to this GHA,
   regardless of whether it's still current — 'NONE' if it never held one */
function ghaCertStatus(ghaId) {
  const history = ghoCertificateHistory(ghaId);
  return history.length ? history[0].status : 'NONE';
}
const GHO_BADGE_ICON = {
  'gho-issued': '<path d="M12 2 L20 5 V11 C20 16 16.5 19.5 12 22 C7.5 19.5 4 16 4 11 V5 Z"/><path d="M9 12 L11 14 L16 9"/>',
  'gho-atrisk': '<path d="M12 3 L21 19 H3 Z"/><path d="M12 9 v5"/><circle cx="12" cy="16.3" r="0.6" fill="currentColor"/>',
  'gho-revoked': '<circle cx="12" cy="12" r="9"/><path d="M7 7 L17 17"/>',
  'gho-expired': '<circle cx="12" cy="12" r="9"/><path d="M12 7 v5 l3.5 3"/>',
  'gho-none': '<circle cx="12" cy="12" r="9" stroke-dasharray="2.5,3"/>'
};
/* small icon + label certificate-status indicator — reused on GHA cards,
   the registry, and the drawer's Certification tab */
function ghoBadgeHtml(ghaId) {
  const info = ghoStatusInfo(ghaCertStatus(ghaId));
  return `<span class="gho-badge ${info.cls}"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${GHO_BADGE_ICON[info.cls]}</svg>${info.label}</span>`;
}
/* hand-built circular seal/rosette — scalloped dot border, ring, and the
   ORBIS brand star recentred at its core, all in the theme's blue palette */
function ghoSealSVG(size) {
  size = size || 90;
  const cx = size / 2, cy = size / 2, rOuter = size / 2 - 3;
  let dots = '';
  const n = 20;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * 2 * Math.PI;
    dots += `<circle cx="${(cx + Math.cos(a) * rOuter).toFixed(1)}" cy="${(cy + Math.sin(a) * rOuter).toFixed(1)}" r="3" fill="var(--primary)"/>`;
  }
  const rMid = rOuter - 9, rCore = rMid - 7, starScale = (rCore * 1.5 / 24).toFixed(3);
  return `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" class="cert-seal-svg">
    <g>${dots}</g>
    <circle cx="${cx}" cy="${cy}" r="${rMid}" fill="none" stroke="var(--primary)" stroke-width="2"/>
    <circle class="cert-seal-core" cx="${cx}" cy="${cy}" r="${rCore}" fill="var(--primary-light)" stroke="var(--primary-dark)" stroke-width="1.5"/>
    <g transform="translate(${cx} ${cy}) scale(${starScale}) translate(-12 -12)">
      <path d="M12 2 L14.5 9.5 L22 12 L14.5 14.5 L12 22 L9.5 14.5 L2 12 L9.5 9.5 Z" fill="var(--primary-dark)"/>
    </g>
  </svg>`;
}
/* deterministic, non-cryptographic 10-char verification code — printed on
   the certificate so it reads like a real registry document; derived only
   from the certificate's own id/number so it's stable across re-renders. */
function certVerifyCode(cert) {
  const src = (cert.id || '') + (cert.certificateNumber || '');
  let h = 0;
  for (let i = 0; i < src.length; i++) h = (h * 31 + src.charCodeAt(i)) >>> 0;
  return h.toString(36).toUpperCase().padStart(10, '0').slice(-10);
}
function certificateDocumentHtml(cert) {
  const gha = getGha(cert.ghaId);
  const config = getActiveGhaPerfConfig();
  const tier = ghaScoreTier(cert.trailingAverageScore, config.params.ghoAnnualThreshold);
  const scoreColor = tier === 'green' ? 'var(--green)' : tier === 'amber' ? 'var(--amber)' : 'var(--red)';
  const isDefaced = cert.status === 'REVOKED' || cert.status === 'EXPIRED';
  const scope = gha && gha.airlinesServed && gha.airlinesServed.length
    ? `ramp, baggage, and passenger handling services for ${gha.airlinesServed.join(', ')} operations`
    : 'ramp, baggage, and passenger handling services for all scheduled carrier operations';
  return `<div class="cert-doc cert-status-${cert.status.toLowerCase()}">
    <div class="cert-border" id="cert-print-area">
      <div class="cert-watermark">ORBIS</div>
      ${cert.status === 'AT_RISK' ? '<div class="cert-ribbon">AT RISK</div>' : ''}
      ${isDefaced ? `<div class="cert-stamp"><span>${escapeHtml(cert.status)}</span></div>` : ''}
      <div class="cert-letterhead">Multan International Airport · MUX Ground Operations Authority</div>
      <h1 class="cert-title">Ground Handling Operation Certificate</h1>
      <div class="cert-meta-row">
        <span class="cert-meta-chip">Station MUX</span>
        <span class="cert-meta-chip">${escapeHtml(gha ? ghaOwnershipLabel(gha.ownership) : '—')}</span>
        <span class="cert-meta-chip">Licence ${escapeHtml(gha ? gha.licenseNumber : '—')}</span>
      </div>
      <div class="cert-seal ${cert.status === 'ISSUED' ? 'cert-seal-flourish' : ''}">${ghoSealSVG(108)}</div>
      <div class="cert-gha-name">${escapeHtml(gha ? gha.name : cert.ghaId)}</div>
      <p class="cert-statement">has satisfied the ground handling operational performance standards of the ORBIS certification programme, evaluated against its trailing twelve-month operating record at MUX.</p>
      <p class="cert-scope"><strong>Scope of certification:</strong> ${escapeHtml(scope)}.</p>
      <div class="cert-figures">
        <div class="cert-fig"><span class="cf-k">Certificate No.</span><span class="cf-v mono">${escapeHtml(cert.certificateNumber)}</span></div>
        <div class="cert-fig"><span class="cf-k">Trailing Average Score</span><span class="cf-v mono" style="color:${scoreColor};font-size:20px">${cert.trailingAverageScore}%</span></div>
        <div class="cert-fig"><span class="cf-k">Evaluation Window</span><span class="cf-v mono">${fmtDate(cert.evaluationWindow.from)} – ${fmtDate(cert.evaluationWindow.to)}</span></div>
        <div class="cert-fig"><span class="cf-k">Months Below Minimum</span><span class="cf-v mono">${cert.monthsBelow}</span></div>
        <div class="cert-fig"><span class="cf-k">Issued</span><span class="cf-v mono">${fmtDate(cert.issuedAt)}</span></div>
        <div class="cert-fig"><span class="cf-k">Valid Until</span><span class="cf-v mono">${fmtDate(cert.expiresAt)}</span></div>
      </div>
      <div class="dw-perms" style="justify-content:center;display:flex;flex-wrap:wrap;gap:6px">
        <span class="dw-perm">Deployment ${cert.basisMetrics.deployment}%</span>
        <span class="dw-perm">Serviceability ${cert.basisMetrics.serviceability}%</span>
        <span class="dw-perm">Suitability ${cert.basisMetrics.suitability}%</span>
        <span class="dw-perm">Fuel Eff. ${cert.basisMetrics.fuelEfficiency}%</span>
      </div>
      ${cert.status === 'REVOKED' ? `<p class="cert-revoke-note">Revoked ${fmtDate(cert.revokedAt)} — ${escapeHtml(cert.revokedReason || '')}</p>` : ''}
      <div class="cert-foot">
        <div class="cert-sig-row">
          <div class="cert-sig">
            <div class="cert-sig-script">${escapeHtml(gha && gha.contactName ? gha.contactName : 'Authorized Signatory')}</div>
            <div class="cert-sig-line"></div>
            <div class="cert-sig-name">${escapeHtml(gha && gha.contactName ? gha.contactName : 'Authorized Signatory')}</div>
            <div class="cert-sig-role">GHA Authorized Representative</div>
          </div>
          <div class="cert-sig">
            <div class="cert-sig-script">Capt. Salman Raza</div>
            <div class="cert-sig-line"></div>
            <div class="cert-sig-name">Capt. Salman Raza</div>
            <div class="cert-sig-role">Station Duty Manager · MUX</div>
          </div>
        </div>
        <p class="cert-idline mono">${escapeHtml(cert.periodType)} certification · issued under active scoring configuration</p>
        <p class="cert-verify mono">Verification code ${certVerifyCode(cert)} · this document is invalid without the official seal and both authorized signatures</p>
      </div>
    </div>
  </div>`;
}
/* returnToGhaId: when the certificate is opened from inside a GHA's detail
   modal, closing this view must reopen that modal (a "back" step), not just
   blank the shared #modal-host — otherwise the GHA detail is lost entirely. */
function openCertificateView(certId, returnToGhaId) {
  const cert = getGhoCertificate(certId); if (!cert) return;
  const back = returnToGhaId ? () => openGhaDetail(returnToGhaId) : closeModal;
  const modal = openModal(`
    <div class="modal-head"><div><h3>Certificate</h3><p class="mono">${escapeHtml(cert.certificateNumber)}</p></div>
      <button class="modal-x" data-x aria-label="${returnToGhaId ? 'Back' : 'Close'}"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6 L18 18 M18 6 L6 18"/></svg></button></div>
    <div class="cert-doc-actions">
      <button class="btn btn-ghost btn-sm" id="cert-tab-btn" type="button">Open in New Tab</button>
      <button class="btn btn-primary btn-sm" id="cert-print-btn" type="button">Print / Save as PDF</button>
    </div>
    ${certificateDocumentHtml(cert)}`, true);
  modal.classList.add('cert-view-modal');
  const host = document.getElementById('modal-host');
  host.onclick = e => { if (e.target === host) back(); };
  modal.querySelectorAll('[data-x]').forEach(b => b.onclick = back);
  modal.querySelector('#cert-print-btn').onclick = () => printCertificate(cert);
  modal.querySelector('#cert-tab-btn').onclick = () => openCertificateInNewTab(cert);
}

/* Shared by the print flow and the plain "Open in New Tab" preview — a
   standalone document with NOTHING in it but the certificate (same
   stylesheet + fonts as the app, so it looks identical). Printing straight
   out of the in-app modal relies on hiding the rest of the SPA
   (visibility:hidden on everything but #cert-print-area), and that trick is
   fragile in Chrome's print/PDF pagination — the modal's own scroll
   clipping, the app shell's fixed-height ancestor, and the hidden-but-
   still-in-flow siblings around it can all still influence page breaks,
   which is what caused the certificate to print as a mostly-blank first
   page with the rest spilling onto a second sheet. With no app chrome to
   hide, no scroll container to clip it, and no sibling content to push it
   around, it always starts at the top of page one and fits the A4 page. */
function certStandaloneDocHtml(cert) {
  const styleHref = new URL('style.css', location.href).href;
  const fontsHref = 'https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=Inter:wght@400;500;600;700;800&family=Caveat:wght@600;700&display=swap';
  return `<!doctype html><html><head><meta charset="UTF-8"/>
<title>${escapeHtml(cert.certificateNumber)}</title>
<link rel="stylesheet" href="${fontsHref}"/>
<link rel="stylesheet" href="${styleHref}"/>
<style>
  @page{ size:A4; margin:14mm; }
  html,body{ margin:0; background:#EEF2F7; display:flex; flex-direction:column; align-items:center; }
  body{ padding:28px 16px 60px; width:100%; }
  /* .cert-doc/.cert-border are normally block children that just fill
     whatever container sizes them (the in-app modal, previously); as a
     flex item under align-items:center they have nothing to size against
     and shrink to their own content's fit-content width instead — this is
     what printed/previewed as a narrow sliver in the corner of the page.
     An explicit width fixes both the on-screen preview and the printed A4
     page (182mm = A4 minus the 14mm @page margins on each side). */
  .cert-doc{ width:800px; max-width:100%; }
  .cert-tab-bar{ width:800px; max-width:100%; margin-bottom:16px; display:flex; justify-content:flex-end; }
  @media print{
    html,body{ background:#fff; }
    body{ padding:0; }
    .cert-doc{ width:182mm; max-width:182mm; }
    .cert-tab-bar{ display:none; }
  }
</style>
</head><body>
<div class="cert-tab-bar"><button class="btn btn-primary btn-sm" id="cert-tab-print" onclick="window.print()" type="button">Print / Save as PDF</button></div>
${certificateDocumentHtml(cert)}
</body></html>`;
}
/* Save as PDF from the in-modal button used to open its own popup and call
   w.print() from the OPENER's 'load' listener — that sometimes fired print()
   before the popup had actually painted anything, so the print preview (and
   the tab underneath it) came up blank. "Open in New Tab" never had that
   problem because print only ever runs from a real click the user makes
   after the tab is visibly rendered. So this now opens the exact same tab
   (identical markup to openCertificateInNewTab, print button included) and
   simulates that same click once the tab reports itself loaded — same
   proven path, just one click instead of two. If anything still goes
   sideways the tab is left open with its own working print button as a
   fallback, instead of silently failing. */
function printCertificate(cert) {
  const w = window.open('', '_blank');
  if (!w) { showToast('Pop-up blocked — allow pop-ups for this site to save the certificate as PDF', 'error'); return; }
  w.document.write(certStandaloneDocHtml(cert));
  w.document.close();
  w.addEventListener('load', () => {
    w.focus();
    w.requestAnimationFrame(() => w.requestAnimationFrame(() => {
      const btn = w.document.getElementById('cert-tab-print');
      if (btn) btn.click(); else w.print();
    }));
  });
}
function openCertificateInNewTab(cert) {
  const w = window.open('', '_blank');
  if (!w) { showToast('Pop-up blocked — allow pop-ups for this site to open the certificate', 'error'); return; }
  w.document.write(certStandaloneDocHtml(cert));
  w.document.close();
}

/* ═══ GHA performance — shared UI pieces (ring, warning banner) ═════
   Reused by the GHA card badge, the drawer's Performance tab, and the
   leaderboard so the same score always looks the same everywhere. */
function perfRingHtml(score, threshold, size, fontSize) {
  size = size || 48; fontSize = fontSize || Math.round(size * 0.26);
  const stroke = Math.max(4, Math.round(size * 0.11));
  const R = size / 2 - stroke, CIRC = 2 * Math.PI * R;
  const tier = ghaScoreTier(score, threshold);
  const color = tier === 'green' ? 'var(--green)' : tier === 'amber' ? 'var(--amber)' : 'var(--red)';
  const frac = ENGINE.clamp(score, 0, 100) / 100;
  return `<div class="perf-ring-wrap" style="width:${size}px;height:${size}px">
    <svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">
      <circle cx="${size / 2}" cy="${size / 2}" r="${R}" fill="none" stroke="var(--surface-alt)" stroke-width="${stroke}"/>
      <circle class="perf-ring-fill" cx="${size / 2}" cy="${size / 2}" r="${R}" fill="none" stroke="${color}" stroke-width="${stroke}" stroke-linecap="round"
        transform="rotate(-90 ${size / 2} ${size / 2})" stroke-dasharray="${CIRC.toFixed(1)}" stroke-dashoffset="${CIRC.toFixed(1)}"
        data-target="${(CIRC * (1 - frac)).toFixed(1)}"/>
    </svg>
    <div class="perf-ring-num mono" style="font-size:${fontSize}px;color:${color}">${score}</div>
  </div>`;
}
function animatePerfRings(root) {
  const els = (root || document).querySelectorAll('.perf-ring-fill');
  requestAnimationFrame(() => { els.forEach(gf => { gf.style.transition = 'stroke-dashoffset .8s var(--ease)'; gf.style.strokeDashoffset = gf.dataset.target; }); });
}
/* GHAs whose CURRENT month is below minimum — the single source both the
   GHA Management banner and the Manager Dashboard panel read from */
function ghasBelowMinimum() {
  const config = getActiveGhaPerfConfig();
  const period = currentPeriod();
  return getGhas().filter(g => g.status === 'ACTIVE').map(g => ({ gha: g, rec: getGhaPerfRecord(g.id, period) }))
    .filter(x => x.rec && x.rec.belowMinimum)
    .map(x => Object.assign({ threshold: config.params.minimumThreshold }, x));
}
function ghaWarningLineHtml(x) {
  const weak = ghaWeakestMetric(x.rec.metrics);
  return `<div class="esc-row r-AMBER" data-gha-id="${x.gha.id}" style="cursor:pointer">
    <span class="esc-fl mono">${escapeHtml(x.gha.code)}</span>
    <span class="esc-stage stage-SMS_SENT">${x.rec.overallScore}/100</span>
    <span class="esc-lbl">Below minimum (${x.threshold}) — driven by low ${escapeHtml(weak.label.toLowerCase())} (${weak.score}%)</span>
  </div>`;
}

/* ═══ financial & suitability helpers ══════════════════════
   currentBookValue is a LIVE straight-line depreciation read — never stored,
   always derived from financial.acquisitionCost/acquisitionDate/usefulLifeYears
   so it stays correct as time passes. Floors at a 10% residual value. */
function fmtMoney(n) { return '$' + Math.round(n).toLocaleString('en-US'); }
function fmtMoneyCompact(n) {
  const abs = Math.abs(n);
  if (abs >= 1e6) return '$' + (n / 1e6).toFixed(2).replace(/\.?0+$/, '') + 'M';
  if (abs >= 1e3) return '$' + (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
  return '$' + Math.round(n);
}
function currentBookValue(unit) {
  const f = unit.financial; if (!f) return 0;
  const residual = f.acquisitionCost * 0.10;
  const ageYears = (Date.now() - new Date(f.acquisitionDate).getTime()) / (365.25 * 864e5);
  if (ageYears <= 0) return f.acquisitionCost;
  if (ageYears >= f.usefulLifeYears) return residual;
  return Math.max(residual, f.acquisitionCost - (f.acquisitionCost - residual) * (ageYears / f.usefulLifeYears));
}
const AIRCRAFT_TYPE_LIST = Object.keys(AIRCRAFT_SPECS);
function ownBadge(ownership) {
  return `<span class="own-badge ${ownership === 'AIRPORT' ? 'own-airport' : 'own-gha'} mono">${ownership === 'AIRPORT' ? 'AIRPORT' : 'GHA'}</span>`;
}
function suitabilityTagsHtml(unit) {
  const list = (unit.suitableFor && unit.suitableFor.length) ? unit.suitableFor : ['ALL'];
  if (list.length === 1 && list[0] === 'ALL') return `<span class="dw-perm">Universal</span>`;
  return list.map(a => `<span class="dw-perm">${escapeHtml(a)}</span>`).join('');
}
/* straight-line book-value chart: acquisition cost declining to the 10%
   residual floor across the useful-life horizon, with a "today" marker */
function bookValueChartSVG(unit) {
  const f = unit.financial;
  const W = 300, H = 150, padL = 46, padB = 20, padT = 10, padR = 8;
  const residual = f.acquisitionCost * 0.10;
  const ageYears = ENGINE.clamp((Date.now() - new Date(f.acquisitionDate).getTime()) / (365.25 * 864e5), 0, f.usefulLifeYears);
  const x = yrs => padL + (yrs / f.usefulLifeYears) * (W - padL - padR);
  const y = val => padT + (1 - (val - residual) / (f.acquisitionCost - residual || 1)) * (H - padT - padB);
  const pts = [[x(0), y(f.acquisitionCost)], [x(f.usefulLifeYears), y(residual)]];
  const areaPts = [[x(0), y(residual)], ...pts, [x(f.usefulLifeYears), y(residual)]];
  const nowVal = currentBookValue(unit);
  return `<svg viewBox="0 0 ${W} ${H}" width="100%">
    ${[f.acquisitionCost, (f.acquisitionCost + residual) / 2, residual].map(v => `<line x1="${padL}" y1="${y(v).toFixed(1)}" x2="${W - padR}" y2="${y(v).toFixed(1)}" class="tl-grid"/><text x="2" y="${(y(v) + 3).toFixed(1)}" class="an-axis mono">${fmtMoneyCompact(v)}</text>`).join('')}
    <path d="${polyPath(areaPts)} Z" class="tl-area"/>
    <path d="${polyPath(pts)}" class="tl-line"/>
    <circle cx="${x(ageYears).toFixed(1)}" cy="${y(nowVal).toFixed(1)}" r="4" fill="var(--primary)" class="tl-pt"/>
    <text x="${x(ageYears).toFixed(1)}" y="${H - 4}" text-anchor="middle" class="an-axis mono">today</text>
    <text x="${W - padR}" y="${H - 4}" text-anchor="end" class="an-axis mono">${f.usefulLifeYears}y</text></svg>`;
}
/* utilisation bar: this month's deployment hours against an 8hr/day × days-elapsed reference */
function utilisationBarHtml(hours) {
  const daysElapsed = new Date().getDate();
  const capacity = Math.max(1, daysElapsed * 8);
  const pct = Math.min(100, Math.round(hours / capacity * 100));
  const color = pct >= 70 ? 'var(--green)' : pct >= 40 ? 'var(--amber)' : 'var(--red)';
  return `<div class="gt-bar" style="margin-top:8px"><span class="gt-fill" style="width:${pct}%;background:${color};animation:barSlide .5s var(--ease) both;transform-origin:left"></span></div>
    <p class="mono" style="font-size:11.5px;color:var(--text-mute);margin-top:5px">${hours}h of ${capacity}h reference capacity this month (${pct}%)</p>`;
}
/* GSE Entry info affordance: universal vs aircraft-restricted split among a type's serviceable units */
function suitabilityInfoTitle(typeCode) {
  const units = getGse().filter(u => u.typeCode === typeCode && u.status === 'SERVICEABLE');
  if (!units.length) return '';
  const universal = units.filter(u => { const s = u.suitableFor || ['ALL']; return s.length === 1 && s[0] === 'ALL'; }).length;
  const restricted = units.length - universal;
  if (!restricted) return '';
  return `${universal} universal · ${restricted} aircraft-type restricted (of ${units.length} serviceable)`;
}

function equipGrade(score) {
  if (score >= 80) return { grade: 'A', label: 'Grade A', class: 'grade-a', meaning: 'Fit for peak operations', tier: 'Tier 1 · Prime' };
  if (score >= 60) return { grade: 'B', label: 'Grade B', class: 'grade-b', meaning: 'Usable, monitor closely', tier: 'Tier 2 · Nominal' };
  if (score >= 40) return { grade: 'C', label: 'Grade C', class: 'grade-c', meaning: 'High risk, backup ready', tier: 'Tier 3 · High Risk' };
  return { grade: 'D', label: 'Grade D', class: 'grade-d', meaning: 'Grounded / replacement required', tier: 'Tier 4 · Critical' };
}

let equipFilter = { q: '', type: 'ALL', status: 'ALL', gha: 'ALL', ownership: 'ALL', grade: 'ALL', sortBy: 'PERF_DESC' };

function filterAndSortEquipRows(fleet) {
  const q = equipFilter.q.toLowerCase();
  let rows = fleet.filter(u => {
    if (equipFilter.type !== 'ALL' && u.type !== equipFilter.type) return false;
    if (equipFilter.status !== 'ALL' && u.status !== equipFilter.status) return false;
    if (equipFilter.gha !== 'ALL' && ghaOf(u) !== equipFilter.gha) return false;
    if (equipFilter.ownership !== 'ALL' && u.ownership !== equipFilter.ownership) return false;
    if (equipFilter.grade !== 'ALL') {
      const ps = u.nonFinancial && u.nonFinancial.performanceScore;
      const s = ps ? ps.finalScore : 0;
      if (equipGrade(s).grade !== equipFilter.grade) return false;
    }
    if (q && !(`${u.serial} ${u.type}`.toLowerCase().includes(q))) return false;
    return true;
  });

  rows.sort((a, b) => {
    const scoreA = (a.nonFinancial && a.nonFinancial.performanceScore) ? a.nonFinancial.performanceScore.finalScore : 0;
    const scoreB = (b.nonFinancial && b.nonFinancial.performanceScore) ? b.nonFinancial.performanceScore.finalScore : 0;
    
    if (equipFilter.sortBy === 'PERF_DESC') {
      if (scoreB !== scoreA) return scoreB - scoreA;
      return (b.mtbfHours || 0) - (a.mtbfHours || 0); // Tie-breaker: higher reliability MTBF first
    }
    if (equipFilter.sortBy === 'PERF_ASC') {
      if (scoreA !== scoreB) return scoreA - scoreB;
      return (a.mtbfHours || 0) - (b.mtbfHours || 0);
    }
    if (equipFilter.sortBy === 'SERIAL') {
      return a.serial.localeCompare(b.serial);
    }
    if (equipFilter.sortBy === 'NEXT_DUE') {
      return new Date(a.nextServiceDue) - new Date(b.nextServiceDue);
    }
    if (equipFilter.sortBy === 'FAIL_PROB') {
      return unitFailureProb(b) - unitFailureProb(a);
    }
    return 0;
  });
  return rows;
}

function renderEquipment(el) {
  const fleet = getGse();
  const active = fleet.filter(u => u.status !== 'RETIRED');
  const types = [...new Set(fleet.map(u => u.type))];

  /* the fleet-strip tiles read the selected GHA card (equipFilter.gha) so
     the summary numbers actually reflect the operator you clicked, instead
     of always showing whole-fleet totals no matter what's selected. */
  const scopeId = equipFilter.gha !== 'ALL' ? equipFilter.gha : null;
  const scopeGha = scopeId ? getGha(scopeId) : null;
  const scoped = scopeId ? active.filter(u => ghaOf(u) === scopeId) : active;

  const svcPct = scoped.length ? Math.round(scoped.filter(u => u.status === 'SERVICEABLE').length / scoped.length * 100) : 0;
  const inMaint = scoped.filter(u => u.status === 'MAINTENANCE').length;
  const overdue = scoped.filter(u => new Date(u.nextServiceDue) < new Date()).length;

  const totalBookValue = scoped.reduce((sum, u) => sum + currentBookValue(u), 0);
  const ghaOwnedCount = scoped.filter(u => u.ownership === 'GHA').length;
  const airportOwnedCount = scoped.filter(u => u.ownership === 'AIRPORT').length;
  const ownSplitTotal = Math.max(1, ghaOwnedCount + airportOwnedCount);
  const ghaOwnedPct = Math.round(ghaOwnedCount / ownSplitTotal * 100);

  const fleetPerfAvg = avgFleetPerfScore(scopeId);
  const reviewCount = unitsNearFloor(scopeId).length;

  // Grade distributions count
  const gradeCounts = { A: 0, B: 0, C: 0, D: 0 };
  scoped.forEach(u => {
    const s = (u.nonFinancial && u.nonFinancial.performanceScore) ? u.nonFinancial.performanceScore.finalScore : 0;
    gradeCounts[equipGrade(s).grade]++;
  });

  /* group active fleet by operating GHA */
  const ghas = getGhas();
  const ghaGroups = {};
  ghas.forEach(g => ghaGroups[g.id] = { total: 0, svc: 0 });
  active.forEach(u => { const id = ghaOf(u); if (!id) return; (ghaGroups[id] = ghaGroups[id] || { total: 0, svc: 0 }); ghaGroups[id].total++; if (u.status === 'SERVICEABLE') ghaGroups[id].svc++; });
  const unassignedCount = active.filter(u => !ghaOf(u)).length;

  const rows = filterAndSortEquipRows(fleet);

  el.innerHTML = `
    <div class="mod-wide">
      <div class="mod-head"><div><h1 class="mod-title">Equipment Register</h1>
        <p class="mod-sub">${active.length} active units · fleet management</p></div>
        <button class="btn btn-primary btn-sm" id="eq-add" type="button">+ Add unit</button></div>

      <div class="fs-scope-row">
        <span class="fs-scope-note mono">${scopeGha ? `Fleet snapshot — ${escapeHtml(scopeGha.name)}` : 'Fleet snapshot — all operators'}</span>
        ${scopeGha ? `<button class="fs-scope-clear" id="eq-scope-clear" type="button">Clear ×</button>` : ''}
      </div>
      <div class="fleet-strip">
        <div class="fs-tile"><span class="fs-num mono">${scoped.length}</span><span class="fs-lbl">Active units</span></div>
        <div class="fs-tile"><span class="fs-num mono">${svcPct}%</span><span class="fs-lbl">Serviceable</span></div>
        <div class="fs-tile"><span class="fs-num mono">${inMaint}</span><span class="fs-lbl">In maintenance</span></div>
        <div class="fs-tile ${overdue ? 'warn' : ''}"><span class="fs-num mono">${overdue}</span><span class="fs-lbl">Overdue service</span></div>
        <div class="fs-tile"><span class="fs-num mono" id="eq-num-bookval">$0</span><span class="fs-lbl">Total fleet book value</span></div>
        <div class="fs-tile">
          <span class="fs-num mono" style="font-size:16px">${ghaOwnedCount} GHA · ${airportOwnedCount} Airport</span>
          <span class="fs-lbl">Ownership split</span>
          <div class="gt-bar" style="height:6px;display:flex;overflow:hidden;margin-top:6px">
            <span style="display:block;height:100%;width:${ghaOwnedPct}%;background:#7C3AED"></span>
            <span style="display:block;height:100%;width:${100 - ghaOwnedPct}%;background:#0F766E"></span>
          </div>
        </div>
        <div class="fs-tile">
          <span class="fs-num mono" id="eq-num-perf">0%</span>
          <span class="fs-lbl">Avg perf score</span>
          <div class="eq-grade-pills">
            <span class="grade-badge grade-a" title="Grade A: ${gradeCounts.A} units">A: ${gradeCounts.A}</span>
            <span class="grade-badge grade-b" title="Grade B: ${gradeCounts.B} units">B: ${gradeCounts.B}</span>
            <span class="grade-badge grade-c" title="Grade C: ${gradeCounts.C} units">C: ${gradeCounts.C}</span>
            <span class="grade-badge grade-d" title="Grade D: ${gradeCounts.D} units">D: ${gradeCounts.D}</span>
          </div>
          ${reviewCount > 0 ? `<span class="eq-review-badge" style="margin-top:4px">${reviewCount} units due for review</span>` : ''}
        </div>
      </div>

      <!-- GROUND HANDLING AGENTS (MUX) -->
      <div class="gha-section">
        <div class="gha-head"><h3 class="card-h" style="margin:0">Ground Handling Agents · Multan (MUX)</h3>
          <span class="gha-sub mono">${ghas.filter(g => ghaGroups[g.id] && ghaGroups[g.id].total).length} agents operating this fleet${unassignedCount ? ` · ${unassignedCount} unassigned` : ''}</span></div>
        <div class="gha-grid">
          ${ghas.filter(g => ghaGroups[g.id] && ghaGroups[g.id].total).map((g, i) => { const grp = ghaGroups[g.id]; const color = ghaColorFor(g.id);
            const pct = grp.total ? Math.round(grp.svc / grp.total * 100) : 0;
            return `<button class="gha-card card-stagger ${equipFilter.gha === g.id ? 'active' : ''}" data-gha="${g.id}" type="button" style="--gha:${color};animation-delay:${i * 40}ms">
              <div class="ghc-top"><span class="ghc-name">${escapeHtml(g.name)}</span><span class="gha-badge" style="--gha:${color}">${escapeHtml(g.code)}</span></div>
              <div class="ghc-role">${escapeHtml(ghaOwnershipLabel(g.ownership))}</div>
              <div class="ghc-carriers">${escapeHtml(ghaAirlinesLabel(g))}</div>
              <div class="ghc-foot"><span class="mono ghc-units">${grp.total} units</span><span class="ghc-bar"><span style="width:${pct}%"></span></span><span class="mono ghc-pct">${pct}% svc</span></div>
            </button>`; }).join('')}
        </div>
      </div>

      <div class="filters" style="border:1px solid var(--border);border-radius:var(--r);margin-bottom:16px">
        <div class="search"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20 L16.5 16.5"/></svg>
          <input type="text" id="eq-search" placeholder="Search serial or type…" value="${escapeHtml(equipFilter.q)}"/></div>
        <select id="eq-sort" class="filter-select" title="Sort and Rank by">
          <option value="PERF_DESC" ${equipFilter.sortBy === 'PERF_DESC' ? 'selected' : ''}>🏆 Rank: High → Low</option>
          <option value="PERF_ASC" ${equipFilter.sortBy === 'PERF_ASC' ? 'selected' : ''}>🔻 Score: Low → High</option>
          <option value="SERIAL" ${equipFilter.sortBy === 'SERIAL' ? 'selected' : ''}>Serial Number</option>
          <option value="NEXT_DUE" ${equipFilter.sortBy === 'NEXT_DUE' ? 'selected' : ''}>Next Service Due</option>
          <option value="FAIL_PROB" ${equipFilter.sortBy === 'FAIL_PROB' ? 'selected' : ''}>Failure Probability</option>
        </select>
        <select id="eq-grade" class="filter-select">
          <option value="ALL" ${equipFilter.grade === 'ALL' ? 'selected' : ''}>All Grades (A-D)</option>
          <option value="A" ${equipFilter.grade === 'A' ? 'selected' : ''}>Grade A (80-100 · Peak)</option>
          <option value="B" ${equipFilter.grade === 'B' ? 'selected' : ''}>Grade B (60-79 · Usable)</option>
          <option value="C" ${equipFilter.grade === 'C' ? 'selected' : ''}>Grade C (40-59 · High Risk)</option>
          <option value="D" ${equipFilter.grade === 'D' ? 'selected' : ''}>Grade D (0-39 · Grounded)</option>
        </select>
        <select id="eq-gha" class="filter-select"><option value="ALL">All operators (GHA)</option>${ghas.map(g => `<option value="${g.id}" ${equipFilter.gha === g.id ? 'selected' : ''}>${escapeHtml(g.name)}</option>`).join('')}</select>
        <select id="eq-type" class="filter-select"><option value="ALL">All types</option>${types.map(t => `<option value="${escapeHtml(t)}" ${equipFilter.type === t ? 'selected' : ''}>${escapeHtml(t)}</option>`).join('')}</select>
        <select id="eq-status" class="filter-select"><option value="ALL">All statuses</option>${['SERVICEABLE', 'UNSERVICEABLE', 'MAINTENANCE', 'RETIRED'].map(s => `<option value="${s}" ${equipFilter.status === s ? 'selected' : ''}>${s}</option>`).join('')}</select>
        <select id="eq-ownership" class="filter-select"><option value="ALL" ${equipFilter.ownership === 'ALL' ? 'selected' : ''}>All ownership</option><option value="GHA" ${equipFilter.ownership === 'GHA' ? 'selected' : ''}>GHA-owned</option><option value="AIRPORT" ${equipFilter.ownership === 'AIRPORT' ? 'selected' : ''}>Airport-owned</option></select>
      </div>

      <div class="card" style="padding:0"><div class="table-scroll"><table class="eq-tbl">
        <thead><tr><th>Unit</th><th>Type</th><th>Operator (GHA)</th><th>Ownership</th><th>Serial</th><th>Status</th><th>MTBF</th><th>Last service</th><th>Next due</th><th>Perf & Grade</th><th>Fail prob</th><th></th></tr></thead>
        <tbody>${rows.length ? rows.map((u, i) => equipRowHtml(u, i)).join('') : `<tr><td colspan="12">${emptyState('No units match', 'Adjust the search or filters.')}</td></tr>`}</tbody>
      </table></div></div>
    </div>`;

  countUpMoney(document.getElementById('eq-num-bookval'), totalBookValue);
  const perfEl = document.getElementById('eq-num-perf');
  if (perfEl) {
    const target = fleetPerfAvg;
    const dur = 600;
    const start = performance.now();
    (function tick(now) {
      const p = Math.min(1, (now - start) / dur);
      const ease = 1 - Math.pow(1 - p, 3);
      perfEl.textContent = Math.round(ease * target) + '%';
      if (p < 1) requestAnimationFrame(tick);
    })(start);
  }
  animatePerfRings(el);

  el.querySelector('#eq-add').onclick = () => openEquipModal(null);
  el.querySelector('#eq-search').oninput = e => { equipFilter.q = e.target.value; renderEquipmentTableOnly(); };
  el.querySelector('#eq-sort').onchange = e => { equipFilter.sortBy = e.target.value; renderEquipmentTableOnly(); };
  el.querySelector('#eq-grade').onchange = e => { equipFilter.grade = e.target.value; renderEquipmentTableOnly(); };
  el.querySelector('#eq-type').onchange = e => { equipFilter.type = e.target.value; renderEquipmentTableOnly(); };
  el.querySelector('#eq-status').onchange = e => { equipFilter.status = e.target.value; renderEquipmentTableOnly(); };
  el.querySelector('#eq-ownership').onchange = e => { equipFilter.ownership = e.target.value; renderEquipmentTableOnly(); };
  el.querySelector('#eq-gha').onchange = e => { equipFilter.gha = e.target.value; renderEquipmentBody(); };
  el.querySelectorAll('.gha-card').forEach(c => c.onclick = () => { equipFilter.gha = equipFilter.gha === c.dataset.gha ? 'ALL' : c.dataset.gha; renderEquipmentBody(); });
  const scopeClearBtn = el.querySelector('#eq-scope-clear');
  if (scopeClearBtn) scopeClearBtn.onclick = () => { equipFilter.gha = 'ALL'; renderEquipmentBody(); };
  el.querySelector('.eq-tbl tbody').onclick = handleEquipRowClick;
}

function renderEquipmentTableOnly() {
  const tbody = document.querySelector('.eq-tbl tbody');
  if (!tbody) return;
  const fleet = getGse();
  const rows = filterAndSortEquipRows(fleet);
  tbody.innerHTML = rows.length ? rows.map((u, i) => equipRowHtml(u, i)).join('') : `<tr><td colspan="12">${emptyState('No units match', 'Adjust the search or filters.')}</td></tr>`;
  animatePerfRings(document.querySelector('.eq-tbl'));
}

function renderEquipmentBody() {
  const searchInput = document.getElementById('eq-search');
  const isFocused = document.activeElement === searchInput;
  const selStart = searchInput ? searchInput.selectionStart : 0;
  const selEnd = searchInput ? searchInput.selectionEnd : 0;

  const el = document.querySelector('.module-view');
  if (el) renderEquipment(el);

  if (isFocused) {
    const newInp = document.getElementById('eq-search');
    if (newInp) {
      newInp.focus();
      try { newInp.setSelectionRange(selStart, selEnd); } catch (err) { }
    }
  }
}

function equipPerfMiniRing(u, rankIndex) {
  const ps = u.nonFinancial && u.nonFinancial.performanceScore;
  const score = ps ? ps.finalScore : 0;
  const gr = equipGrade(score);
  const color = score >= 80 ? 'var(--green)' : score >= 60 ? '#0D9488' : score >= 40 ? 'var(--amber)' : 'var(--red)';
  const size = 28, stroke = 3, R = size / 2 - stroke, CIRC = 2 * Math.PI * R;
  const frac = ENGINE.clamp(score, 0, 100) / 100;
  const rankTag = (rankIndex !== undefined && equipFilter.sortBy === 'PERF_DESC') 
    ? `<span class="eq-rank-num ${rankIndex < 3 ? 'eq-rank-top' : ''}">#${rankIndex + 1}</span>` 
    : '';

  return `<td><div class="eq-cell-perf" title="${escapeHtml(gr.label)} (${score}%) · ${escapeHtml(gr.meaning)}">
    ${rankTag}
    <div class="eq-perf-mini">
      <svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">
        <circle cx="${size/2}" cy="${size/2}" r="${R}" fill="none" stroke="var(--surface-alt)" stroke-width="${stroke}"/>
        <circle class="perf-ring-fill" cx="${size/2}" cy="${size/2}" r="${R}" fill="none" stroke="${color}" stroke-width="${stroke}" stroke-linecap="round"
          transform="rotate(-90 ${size/2} ${size/2})" stroke-dasharray="${CIRC.toFixed(1)}" stroke-dashoffset="${CIRC.toFixed(1)}"
          data-target="${(CIRC * (1 - frac)).toFixed(1)}"/>
      </svg>
      <div class="perf-ring-num mono" style="font-size:9px;color:${color}">${score}</div>
    </div>
    <span class="grade-badge ${gr.class}">${gr.grade}</span>
  </div></td>`;
}

function equipRowHtml(u, index) {
  const overdue = new Date(u.nextServiceDue) < new Date() && u.status !== 'RETIRED';
  const fp = unitFailureProb(u);
  const stCls = { SERVICEABLE: 'ok', UNSERVICEABLE: 'bad', MAINTENANCE: 'maint', RETIRED: 'ret' }[u.status];
  return `<tr data-unit="${u.id}" class="${u.status === 'UNSERVICEABLE' ? 'row-uns' : ''} ${overdue ? 'row-overdue' : ''}">
    <td class="mono">${escapeHtml(u.id.replace('gse-', ''))}</td><td>${escapeHtml(u.type)}</td><td>${ghaBadge(ghaOf(u))}</td><td>${ownBadge(u.ownership)}</td><td class="mono">${escapeHtml(u.serial)}</td>
    <td><span class="eq-status es-${stCls}">${u.status}</span></td>
    <td class="mono">${u.mtbfHours} h</td>
    <td class="mono">${fmtDate(u.lastService)}</td>
    <td class="mono ${overdue ? 'overdue-txt' : ''}">${fmtDate(u.nextServiceDue)}${overdue ? ' ⚠' : ''}</td>
    ${equipPerfMiniRing(u, index)}
    <td class="mono">${Math.round(fp * 100)}%</td>
    <td class="th-act"><button class="kebab-btn" data-eqmenu="${u.id}" aria-label="Actions"><svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor"><circle cx="12" cy="5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="19" r="1.6"/></svg></button></td>
  </tr>`;
}
function handleEquipRowClick(e) {
  const menu = e.target.closest('[data-eqmenu]');
  if (menu) { e.stopPropagation(); openEquipMenu(menu.dataset.eqmenu, menu); return; }
  const row = e.target.closest('[data-unit]'); if (row) openMaintDrawer(row.dataset.unit);
}
function openEquipMenu(id, anchor) {
  const u = getGse().find(x => x.id === id); if (!u) return;
  const items = [
    { key: 'log', label: 'Maintenance log', onClick: () => openMaintDrawer(id) },
    { key: 'edit', label: 'Edit unit', onClick: () => openEquipModal(id) },
    { sep: true },
    { key: 'svc', label: 'Set serviceable', onClick: () => changeUnitStatus(id, 'SERVICEABLE') },
    { key: 'uns', label: 'Set unserviceable', onClick: () => changeUnitStatus(id, 'UNSERVICEABLE') },
    { key: 'maint', label: 'Set maintenance', onClick: () => changeUnitStatus(id, 'MAINTENANCE') },
    { sep: true },
    { key: 'retire', label: 'Retire unit', danger: true, onClick: () => retireUnit(id) }
  ];
  openKebab(anchor, items);
}
async function changeUnitStatus(id, status) {
  const g = getGse(); const u = g.find(x => x.id === id); if (!u || u.status === status) return;
  u.status = status; saveGse(g);
  logActivity({ action: `set ${u.serial} ${status}`, target: u.type, category: 'equipment', severity: status === 'UNSERVICEABLE' ? 'warn' : 'info' });
  showToast(`${u.serial} → ${status}`, 'success');
  renderEquipmentBody();
  offerRecalc();
}
async function retireUnit(id) {
  const u = getGse().find(x => x.id === id); if (!u) return;
  const ok = await confirmDialog({ title: 'Retire unit', message: `Retire ${u.serial} (${u.type})? It will be removed from active availability.`, confirmLabel: 'Retire' });
  if (!ok) return;
  const g = getGse(); g.find(x => x.id === id).status = 'RETIRED'; saveGse(g);
  logActivity({ action: `retired ${u.serial}`, target: u.type, category: 'equipment', severity: 'warn' });
  showToast(`${u.serial} retired`, 'notice');
  renderEquipmentBody(); offerRecalc();
}
async function offerRecalc() {
  const ok = await confirmDialog({ title: 'Recalculate pending flights?', message: 'Equipment status changed — GSE availability and failure-risk inputs are affected. Recalculate all pending flights now?', confirmLabel: 'Recalculate', danger: false });
  if (!ok) return;
  const modal = openModal(`<div class="modal-head"><div><h3>Recalculating</h3><p>Applying the updated fleet state</p></div></div><div id="recalc-host"></div>`);
  const total = getFlights().filter(f => f.status !== 'OFF_BLOCK').length;
  const changes = await recalcSequence(modal.querySelector('#recalc-host'), f => applyFleetToFlight(f));
  modal.querySelector('#recalc-host').innerHTML = changeSummaryHtml(changes, total) + '<div class="modal-foot"><button class="btn btn-primary" id="rc-close">Done</button></div>';
  modal.querySelector('#rc-close').onclick = closeModal;
  updateAlertBadge();
}

function openEquipModal(id) {
  const u = id ? getGse().find(x => x.id === id) : null;
  const presets = ['Pushback Tug', 'Towbarless Tractor', 'Belt Loader', 'Baggage Tractor', 'Cargo High Loader', 'Ground Power Unit (GPU)', 'Air Start Unit (ASU)', 'Preconditioned Air (PCA)', 'Fuel Bowser Truck', 'Potable Water Truck', 'Lavatory Service Truck', 'Catering Hi-Lift Truck', 'Mobile Boarding Stairs', 'Ambulift (PRM)', 'Ramp Forklift', 'Wheel Chocks', 'Safety Cones', 'Baggage Cart / Dolly', 'Passenger Boarding Bridge', 'Fuel Hydrant System'];
  const curType = u ? u.type : '';
  const curStatus = u ? u.status : 'SERVICEABLE';
  const curLast = u ? u.lastService.slice(0, 10) : nowISO().slice(0, 10);
  const curNext = u ? u.nextServiceDue.slice(0, 10) : addMinutesISO(nowISO(), 60 * 24 * 30).slice(0, 10);
  const ghasList = getGhas();
  const curGha = u ? (ghaOf(u) || '') : (ghasList[0] ? ghasList[0].id : '');
  const curOwnership = u ? (u.ownership || 'GHA') : 'GHA';
  const curSuitable = u && u.suitableFor && u.suitableFor.length ? u.suitableFor : ['ALL'];
  const curSuitIsAll = curSuitable.length === 1 && curSuitable[0] === 'ALL';
  const fin = u ? (u.financial || {}) : {};
  const curCost = fin.acquisitionCost != null ? fin.acquisitionCost : '';
  const curAcqDate = fin.acquisitionDate ? fin.acquisitionDate.slice(0, 10) : nowISO().slice(0, 10);
  const curLife = fin.usefulLifeYears != null ? fin.usefulLifeYears : 10;
  const curFuelType = fin.fuelType || 'DIESEL';
  const curFuelCost = fin.fuelCostPerHour != null ? fin.fuelCostPerHour : '';

  const modal = openModal(`
    <div class="modal-head">
      <div>
        <div class="modal-h-tag mono">FLEET MANAGEMENT</div>
        <h3>${u ? 'Edit GSE Unit' : 'Register GSE Unit'}</h3>
        <p>${u ? `Serial: ${escapeHtml(u.serial)} · ID: ${escapeHtml(u.id)}` : 'Register a new airside unit to station inventory'}</p>
      </div>
      <button class="modal-x" data-x aria-label="Close">
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6 L18 18 M18 6 L6 18"/></svg>
      </button>
    </div>

    <div class="eq-modal-body">
      <!-- TYPE SELECTOR & PRESET CHIPS -->
      <div class="field">
        <label for="eq-f-type">Equipment Type</label>
        <div class="input-wrap">
          <input type="text" id="eq-f-type" value="${escapeHtml(curType)}" placeholder="Select or type equipment category…" autocomplete="off" />
        </div>
        <div class="eq-type-chips" id="eq-type-chips">
          ${presets.map(t => `<button type="button" class="eq-chip ${curType === t ? 'active' : ''}" data-type="${t}">${t}</button>`).join('')}
        </div>
      </div>

      <!-- SERIAL & MTBF -->
      <div class="grid-2">
        <div class="field">
          <label for="eq-f-serial">Serial / Unit Identifier</label>
          <div class="input-wrap">
            <input type="text" id="eq-f-serial" value="${u ? escapeHtml(u.serial) : ''}" placeholder="e.g. BL-4474, GPU-802" autocomplete="off" />
          </div>
        </div>
        <div class="field">
          <label for="eq-f-mtbf">MTBF (Mean Time Between Failures)</label>
          <div class="input-wrap">
            <input type="number" id="eq-f-mtbf" value="${u ? u.mtbfHours : '800'}" placeholder="800" />
            <span class="input-unit mono">hrs</span>
          </div>
        </div>
      </div>

      <!-- OPERATING GROUND HANDLING AGENT & OWNERSHIP -->
      <div class="grid-2">
        <div class="field">
          <label for="eq-f-gha">Operating Ground Handling Agent (GHA)</label>
          <div class="input-wrap">
            <select id="eq-f-gha"><option value="">— Unassigned —</option>${ghasList.map(g => `<option value="${g.id}" ${curGha === g.id ? 'selected' : ''}>${escapeHtml(g.name)}</option>`).join('')}</select>
          </div>
        </div>
        <div class="field">
          <label for="eq-f-ownership">Ownership</label>
          <div class="input-wrap">
            <select id="eq-f-ownership">
              <option value="GHA" ${curOwnership === 'GHA' ? 'selected' : ''}>GHA-owned</option>
              <option value="AIRPORT" ${curOwnership === 'AIRPORT' ? 'selected' : ''}>Airport-owned</option>
            </select>
          </div>
        </div>
      </div>

      <!-- AIRCRAFT SUITABILITY -->
      <div class="field">
        <label>Aircraft Suitability</label>
        <div class="eq-type-chips" id="eq-suit-chips">
          <button type="button" class="eq-chip ${curSuitIsAll ? 'active' : ''}" data-suit="ALL">Universal (ALL)</button>
          ${AIRCRAFT_TYPE_LIST.map(a => `<button type="button" class="eq-chip ${!curSuitIsAll && curSuitable.includes(a) ? 'active' : ''}" data-suit="${escapeHtml(a)}">${escapeHtml(a)}</button>`).join('')}
        </div>
      </div>

      <!-- VISUAL STATUS PILLS -->
      <div class="field">
        <label>Operational Status</label>
        <div class="eq-status-pills" id="eq-status-pills">
          <button type="button" class="eq-status-pill st-ok ${curStatus === 'SERVICEABLE' ? 'active' : ''}" data-status="SERVICEABLE">
            <span class="sp-dot"></span><span>SERVICEABLE</span>
          </button>
          <button type="button" class="eq-status-pill st-maint ${curStatus === 'MAINTENANCE' ? 'active' : ''}" data-status="MAINTENANCE">
            <span class="sp-dot"></span><span>MAINTENANCE</span>
          </button>
          <button type="button" class="eq-status-pill st-bad ${curStatus === 'UNSERVICEABLE' ? 'active' : ''}" data-status="UNSERVICEABLE">
            <span class="sp-dot"></span><span>UNSERVICEABLE</span>
          </button>
        </div>
      </div>

      <!-- DATE PICKERS WITH QUICK PRESET CHIPS -->
      <div class="grid-2">
        <div class="field">
          <label for="eq-f-last">Last Service Date</label>
          <div class="input-wrap date-wrap">
            <svg class="date-ico" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
            <input type="date" id="eq-f-last" value="${curLast}"/>
          </div>
          <div class="date-presets">
            <button type="button" class="dp-preset" data-target="eq-f-last" data-days="0">Today</button>
            <button type="button" class="dp-preset" data-target="eq-f-last" data-days="-7">1 wk ago</button>
            <button type="button" class="dp-preset" data-target="eq-f-last" data-days="-30">1 mo ago</button>
          </div>
        </div>

        <div class="field">
          <label for="eq-f-next">Next Service Due</label>
          <div class="input-wrap date-wrap">
            <svg class="date-ico" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
            <input type="date" id="eq-f-next" value="${curNext}"/>
          </div>
          <div class="date-presets">
            <button type="button" class="dp-preset" data-target="eq-f-next" data-days="30">+30 days</button>
            <button type="button" class="dp-preset" data-target="eq-f-next" data-days="60">+60 days</button>
            <button type="button" class="dp-preset" data-target="eq-f-next" data-days="90">+90 days</button>
          </div>
        </div>
      </div>

      <!-- FINANCIAL DETAILS (collapsible) -->
      <section class="audit-card" style="border:1px solid var(--border);border-radius:var(--r)">
        <button class="audit-toggle" id="eq-fin-toggle" type="button">
          <span>Financial details</span><span class="au-chev">▸</span></button>
        <div class="audit-body" id="eq-fin-body" hidden>
          <div class="grid-2">
            <div class="field"><label for="eq-f-cost">Acquisition Cost</label>
              <div class="input-wrap"><input type="number" id="eq-f-cost" value="${curCost}" placeholder="42000"/><span class="input-unit mono">USD</span></div></div>
            <div class="field"><label for="eq-f-acqdate">Acquisition Date</label>
              <div class="input-wrap"><input type="date" id="eq-f-acqdate" value="${curAcqDate}"/></div></div>
          </div>
          <div class="grid-2">
            <div class="field"><label for="eq-f-life">Useful Life</label>
              <div class="input-wrap"><input type="number" id="eq-f-life" value="${curLife}" placeholder="10"/><span class="input-unit mono">yrs</span></div></div>
            <div class="field"><label for="eq-f-fueltype">Fuel Type</label>
              <div class="input-wrap"><select id="eq-f-fueltype">
                <option value="DIESEL" ${curFuelType === 'DIESEL' ? 'selected' : ''}>DIESEL</option>
                <option value="ELECTRIC" ${curFuelType === 'ELECTRIC' ? 'selected' : ''}>ELECTRIC</option>
                <option value="N/A" ${curFuelType === 'N/A' ? 'selected' : ''}>N/A (non-powered)</option>
              </select></div></div>
          </div>
          <div class="field" id="eq-f-fuelcost-field" ${curFuelType !== 'DIESEL' ? 'hidden' : ''}>
            <label for="eq-f-fuelcost">Fuel Cost / Hour</label>
            <div class="input-wrap"><input type="number" id="eq-f-fuelcost" value="${curFuelCost}" placeholder="12" step="0.1"/><span class="input-unit mono">USD/hr</span></div>
          </div>
        </div>
      </section>
    </div>

    <div class="modal-foot">
      <button class="btn btn-ghost" data-x type="button">Cancel</button>
      <button class="btn btn-primary" id="eq-save" type="button">${u ? 'Save Changes' : 'Register Unit'}</button>
    </div>`);

  modal.querySelectorAll('[data-x]').forEach(b => b.onclick = closeModal);

  let selectedStatus = curStatus;
  const statusPills = modal.querySelectorAll('.eq-status-pill');
  statusPills.forEach(p => p.onclick = () => {
    statusPills.forEach(x => x.classList.remove('active'));
    p.classList.add('active');
    selectedStatus = p.dataset.status;
  });

  const typeInput = modal.querySelector('#eq-f-type');
  const typeChips = modal.querySelectorAll('#eq-type-chips .eq-chip');
  typeChips.forEach(c => c.onclick = () => {
    typeChips.forEach(x => x.classList.remove('active'));
    c.classList.add('active');
    typeInput.value = c.dataset.type;
  });

  /* suitability chips: 'ALL' is exclusive, individual aircraft toggle and
     fall back to 'ALL' the moment none are left selected */
  const suitChips = modal.querySelectorAll('#eq-suit-chips .eq-chip');
  const suitAllChip = modal.querySelector('#eq-suit-chips [data-suit="ALL"]');
  suitChips.forEach(c => c.onclick = () => {
    if (c.dataset.suit === 'ALL') {
      suitChips.forEach(x => x.classList.remove('active'));
      c.classList.add('active');
    } else {
      suitAllChip.classList.remove('active');
      c.classList.toggle('active');
      if (![...suitChips].some(x => x !== suitAllChip && x.classList.contains('active'))) suitAllChip.classList.add('active');
    }
  });

  const finToggle = modal.querySelector('#eq-fin-toggle');
  const finBody = modal.querySelector('#eq-fin-body');
  finToggle.onclick = () => {
    finBody.hidden = !finBody.hidden;
    finToggle.classList.toggle('open', !finBody.hidden);
  };
  const fuelTypeSel = modal.querySelector('#eq-f-fueltype');
  const fuelCostField = modal.querySelector('#eq-f-fuelcost-field');
  fuelTypeSel.onchange = () => { fuelCostField.hidden = fuelTypeSel.value !== 'DIESEL'; };

  modal.querySelectorAll('.dp-preset').forEach(btn => {
    btn.onclick = () => {
      const targetId = btn.dataset.target;
      const days = Number(btn.dataset.days);
      const targetInput = modal.querySelector('#' + targetId);
      if (targetInput) {
        const d = new Date();
        d.setDate(d.getDate() + days);
        targetInput.value = d.toISOString().slice(0, 10);
      }
    };
  });

  modal.querySelector('#eq-save').onclick = () => {
    const type = typeInput.value.trim();
    const serial = modal.querySelector('#eq-f-serial').value.trim();
    const status = selectedStatus;
    const mtbf = Number(modal.querySelector('#eq-f-mtbf').value) || 800;
    const last = modal.querySelector('#eq-f-last').value;
    const next = modal.querySelector('#eq-f-next').value;
    const ghaId = modal.querySelector('#eq-f-gha').value || null;
    const ownership = modal.querySelector('#eq-f-ownership').value;
    const suitableFor = suitAllChip.classList.contains('active') ? ['ALL']
      : [...suitChips].filter(c => c !== suitAllChip && c.classList.contains('active')).map(c => c.dataset.suit);
    const acquisitionCost = Number(modal.querySelector('#eq-f-cost').value) || 0;
    const acquisitionDateVal = modal.querySelector('#eq-f-acqdate').value;
    const usefulLifeYears = Number(modal.querySelector('#eq-f-life').value) || 10;
    const fuelType = fuelTypeSel.value;
    const fuelCostPerHour = fuelType === 'DIESEL' ? (Number(modal.querySelector('#eq-f-fuelcost').value) || 0) : 0;
    if (!type || !serial) { showToast('Type and serial are required', 'error'); return; }
    const g = getGse();
    const financial = {
      acquisitionCost, acquisitionDate: acquisitionDateVal ? new Date(acquisitionDateVal).toISOString() : (fin.acquisitionDate || nowISO()),
      usefulLifeYears, fuelType, fuelCostPerHour, maintenanceCostToDate: fin.maintenanceCostToDate || 0
    };
    if (u) {
      Object.assign(g.find(x => x.id === id), {
        type, serial, status, mtbfHours: mtbf, ghaId, ownership, suitableFor, financial,
        lastService: last ? new Date(last).toISOString() : u.lastService,
        nextServiceDue: next ? new Date(next).toISOString() : u.nextServiceDue
      });
      logActivity({ action: `edited unit ${serial}`, target: type, category: 'equipment', severity: 'info' });
    } else {
      const code = (type.match(/\b\w/g) || ['G']).join('').toUpperCase().slice(0, 3);
      g.push({
        id: 'gse-' + code + '-' + uid('n').slice(-4), typeCode: code, type, serial, status, mtbfHours: mtbf, ghaId, ownership, suitableFor, financial,
        nonFinancial: { deploymentHoursThisMonth: 0, fuelConsumptionThisMonth: 0 },
        lastService: last ? new Date(last).toISOString() : nowISO(),
        nextServiceDue: next ? new Date(next).toISOString() : addMinutesISO(nowISO(), 60 * 24 * 30),
        maintLog: []
      });
      logActivity({ action: `added unit ${serial}`, target: type, category: 'equipment', severity: 'success' });
    }
    saveGse(g); closeModal(); showToast(`${serial} ${u ? 'updated' : 'added'}`, 'success'); renderEquipmentBody();
    if (equipDetailOpenId === id) openEquipDetail(id);
  };
}

let equipDrawerTab = 'overview';
function equipOverviewTabHtml(u, gha, viewAgentBtn, log) {
  return `<div class="dw-grid">
      <div class="dw-item"><div class="k">Type</div><div class="v">${escapeHtml(u.type)}</div></div>
      <div class="dw-item"><div class="k">Operator (GHA)</div><div class="v">${escapeHtml(gha ? gha.name : 'Unassigned')}${viewAgentBtn}</div></div>
      <div class="dw-item"><div class="k">Ownership</div><div class="v">${ownBadge(u.ownership)}</div></div>
      <div class="dw-item"><div class="k">Status</div><div class="v">${u.status}</div></div>
      <div class="dw-item"><div class="k">MTBF</div><div class="v mono">${u.mtbfHours} h</div></div>
      <div class="dw-item"><div class="k">Fail prob</div><div class="v mono">${Math.round(unitFailureProb(u) * 100)}%</div></div>
    </div>
    <div class="dw-section"><h4>Add log entry</h4>
      <div class="grid-2"><div class="field"><label>Date</label><div class="input-wrap"><input type="date" id="ml-date" value="${nowISO().slice(0, 10)}"/></div></div>
        <div class="field"><label>Hours</label><div class="input-wrap"><input type="text" id="ml-hours" placeholder="2"/></div></div></div>
      <div class="field"><label>Type</label><div class="input-wrap"><input type="text" id="ml-type" placeholder="Scheduled service"/></div></div>
      <div class="field"><label>Notes</label><textarea id="ml-notes" placeholder="Work performed…"></textarea></div>
      <button class="btn btn-primary btn-sm" id="ml-add" type="button">Add entry</button>
    </div>
    <div class="dw-section"><h4>Service history</h4>
      <div id="ml-list">${log.length ? log.map(m => `<div class="ml-row"><div class="ml-top"><span class="mono">${fmtDate(m.date)}</span><span class="ml-hrs mono">${m.hours || 0}h</span></div>
        <div class="ml-type">${escapeHtml(m.type)}</div>${m.notes ? `<div class="ml-notes">${escapeHtml(m.notes)}</div>` : ''}</div>`).join('') : '<p style="font-size:12.5px;color:var(--text-mute)">No service history recorded.</p>'}</div>
    </div>`;
}
function equipFinancialTabHtml(u) {
  const f = u.financial || {};
  const hasFuel = f.fuelType && f.fuelType !== 'N/A';
  return `<div class="dw-section" style="margin-top:0">
      <h4>Book value</h4>
      <div class="tobt-big mono">${fmtMoney(currentBookValue(u))}</div>
      <div class="an-chart">${bookValueChartSVG(u)}</div>
    </div>
    <div class="dw-grid">
      <div class="dw-item"><div class="k">Acquisition cost</div><div class="v mono">${fmtMoney(f.acquisitionCost || 0)}</div></div>
      <div class="dw-item"><div class="k">Acquisition date</div><div class="v mono">${fmtDate(f.acquisitionDate)}</div></div>
      <div class="dw-item"><div class="k">Useful life</div><div class="v mono">${f.usefulLifeYears || 0} yrs</div></div>
      <div class="dw-item"><div class="k">Maintenance cost to date</div><div class="v mono">${fmtMoney(f.maintenanceCostToDate || 0)}</div></div>
      ${hasFuel ? `<div class="dw-item"><div class="k">Fuel type</div><div class="v">${escapeHtml(f.fuelType)}</div></div>
      <div class="dw-item"><div class="k">Fuel cost / hour</div><div class="v mono">${fmtMoney(f.fuelCostPerHour || 0)}</div></div>` : ''}
    </div>`;
}
function equipDecayChartSVG(u) {
  const f = u.financial || {};
  const ps = (u.nonFinancial && u.nonFinancial.performanceScore) || {};
  const curve = ps.curveUsed || { yearlyDeclinePercent: 8, floorPercent: 35 };
  const life = f.usefulLifeYears || 10;
  const floor = curve.floorPercent;
  const ageYears = ps.ageYears || 0;
  const unitScore = ps.finalScore || 0;

  // Visual dimension setup
  const W = 380, H = 175, padL = 36, padR = 16, padT = 28, padB = 26;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const x = yrs => padL + (yrs / life) * plotW;
  const y = val => padT + (1 - (val / 100)) * plotH;

  // Determine dynamic accent color
  const accent = unitScore >= 80 ? '#10B981' : unitScore >= 50 ? '#F59E0B' : '#EF4444';
  const gradId = 'edc-g-' + (u.id || 'unit').replace(/[^a-zA-Z0-9]/g, '');

  // Calculate smooth decay curve points
  const steps = 40;
  const curvePts = [];
  for (let i = 0; i <= steps; i++) {
    const yr = (i / steps) * life;
    const val = Math.max(floor, 100 - yr * curve.yearlyDeclinePercent);
    curvePts.push([x(yr), y(val)]);
  }

  // Polygon area under the curve
  const areaPts = [[x(0), y(floor)], ...curvePts, [x(life), y(floor)]];

  // Coordinates for the current unit's position
  const dotX = x(Math.min(ageYears, life));
  const dotY = y(unitScore);
  const midX = x(life / 2);
  const endX = W - padR;

  // Y-axis grid levels
  const gridVals = [100, 75, 50, floor];
  const gridLines = gridVals.map(v => {
    const isFloor = v === floor;
    const strokeStyle = isFloor ? 'stroke="rgba(239, 68, 68, 0.45)" stroke-dasharray="4,3"' : 'class="tl-grid"';
    const textStyle = isFloor ? 'style="fill:var(--red);font-weight:600"' : 'class="an-axis mono"';
    return `<line x1="${padL}" y1="${y(v).toFixed(1)}" x2="${W - padR}" y2="${y(v).toFixed(1)}" ${strokeStyle}/>
      <text x="${padL - 4}" y="${(y(v) + 3).toFixed(1)}" text-anchor="end" ${textStyle} font-size="9.5">${v}%</text>`;
  }).join('');

  // Callout pill positioning (prevent clipping on edges)
  const pillW = 96, pillH = 21;
  let pillX = dotX - pillW / 2;
  if (pillX < padL + 2) pillX = padL + 2;
  if (pillX + pillW > W - padR - 2) pillX = W - padR - pillW - 2;
  const pillY = dotY - 26 < padT - 6 ? dotY + 12 : dotY - 26;

  // Safe buffer delta
  const bufferDelta = Math.max(0, unitScore - floor);

  return `<div class="eq-decay-card">
    <div class="edc-head">
      <div>
        <span class="edc-title">Lifecycle Reliability Trajectory</span>
        <span class="edc-sub">Category: ${escapeHtml(u.category || 'GSE')} · ${curve.yearlyDeclinePercent}%/yr nominal decline</span>
      </div>
      <div class="edc-badges">
        <span class="edc-tag floor">Floor: ${floor}%</span>
        <span class="edc-tag status" style="--tag-c:${accent}">Score: ${unitScore}%</span>
      </div>
    </div>

    <div class="edc-svg-wrap">
      <svg viewBox="0 0 ${W} ${H}" width="100%" class="edc-svg">
        <defs>
          <linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="${accent}" stop-opacity="0.32"/>
            <stop offset="70%" stop-color="${accent}" stop-opacity="0.08"/>
            <stop offset="100%" stop-color="${accent}" stop-opacity="0.01"/>
          </linearGradient>
        </defs>

        <!-- Background grid & Floor -->
        ${gridLines}
        <text x="${padL + 6}" y="${(y(floor) - 4).toFixed(1)}" text-anchor="start" class="mono" font-size="8.5" font-weight="600" fill="var(--red)" opacity="0.85">Safety Floor (${floor}%)</text>

        <!-- Area fill & Line -->
        <path d="${polyPath(areaPts)} Z" fill="url(#${gradId})"/>
        <path d="${polyPath(curvePts)}" fill="none" stroke="${accent}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>

        <!-- Crosshair guides to current position -->
        <line x1="${dotX.toFixed(1)}" y1="${dotY.toFixed(1)}" x2="${dotX.toFixed(1)}" y2="${(H - padB).toFixed(1)}" stroke="${accent}" stroke-width="1.2" stroke-dasharray="3,3" opacity="0.7"/>
        <line x1="${padL}" y1="${dotY.toFixed(1)}" x2="${dotX.toFixed(1)}" y2="${dotY.toFixed(1)}" stroke="${accent}" stroke-width="1.2" stroke-dasharray="3,3" opacity="0.4"/>

        <!-- Axis landing indicator for current position -->
        <circle cx="${dotX.toFixed(1)}" cy="${(H - padB).toFixed(1)}" r="3" fill="${accent}"/>

        <!-- Baseline X axis -->
        <line x1="${padL}" y1="${(H - padB).toFixed(1)}" x2="${W - padR}" y2="${(H - padB).toFixed(1)}" stroke="var(--border)" stroke-width="1.2"/>
        <line x1="${padL}" y1="${(H - padB).toFixed(1)}" x2="${padL}" y2="${(H - padB + 4).toFixed(1)}" stroke="var(--border)" stroke-width="1.2"/>
        <line x1="${midX.toFixed(1)}" y1="${(H - padB).toFixed(1)}" x2="${midX.toFixed(1)}" y2="${(H - padB + 4).toFixed(1)}" stroke="var(--border)" stroke-width="1.2"/>
        <line x1="${endX.toFixed(1)}" y1="${(H - padB).toFixed(1)}" x2="${endX.toFixed(1)}" y2="${(H - padB + 4).toFixed(1)}" stroke="var(--border)" stroke-width="1.2"/>

        <!-- Clean, Fixed X-axis Milestone Labels (Zero Collision) -->
        <text x="${padL}" y="${H - 9}" class="an-axis mono" font-size="9">0y</text>
        <text x="${midX.toFixed(1)}" y="${H - 9}" text-anchor="middle" class="an-axis mono" font-size="9">${(life / 2).toFixed(0)}y</text>
        <text x="${endX.toFixed(1)}" y="${H - 9}" text-anchor="end" class="an-axis mono" font-size="9">${life}y Max</text>

        <!-- Active Unit Beacon & Pulse -->
        <circle cx="${dotX.toFixed(1)}" cy="${dotY.toFixed(1)}" r="10" fill="${accent}" opacity="0.22" class="eq-decay-pulse"/>
        <circle cx="${dotX.toFixed(1)}" cy="${dotY.toFixed(1)}" r="5.5" fill="var(--surface)" stroke="${accent}" stroke-width="2.5"/>
        <circle cx="${dotX.toFixed(1)}" cy="${dotY.toFixed(1)}" r="2.5" fill="${accent}"/>

        <!-- Telemetry Callout Pill (High Contrast, Self-Contained) -->
        <rect x="${pillX.toFixed(1)}" y="${pillY.toFixed(1)}" width="${pillW}" height="${pillH}" rx="4" fill="var(--surface-alt)" stroke="var(--border)" stroke-width="1" filter="drop-shadow(0 2px 4px rgba(0,0,0,0.12))"/>
        <circle cx="${(pillX + 8).toFixed(1)}" cy="${(pillY + 10.5).toFixed(1)}" r="3.2" fill="${accent}"/>
        <text x="${(pillX + 16).toFixed(1)}" y="${(pillY + 14).toFixed(1)}" class="mono" font-size="10.5" font-weight="700" fill="var(--text)">${unitScore}% · ${ageYears}y</text>
      </svg>
    </div>

    <div class="edc-foot">
      <div class="edc-foot-item"><span class="edc-k">Asset Lifespan</span><span class="edc-v mono">${ageYears} / ${life} yrs (${Math.round((ageYears / life) * 100)}%)</span></div>
      <div class="edc-foot-item"><span class="edc-k">Safety Margin</span><span class="edc-v mono ${unitScore > floor + 10 ? 'good' : 'warn'}">+${bufferDelta}% above floor</span></div>
      <div class="edc-foot-item"><span class="edc-k">Active Adjustments</span><span class="edc-v">${ps.maintenanceBonusApplied ? '<span class="epb-v bonus">✓ +3% Maint</span>' : '<span class="epb-v neutral">Standard</span>'} ${ps.reactivationPenaltyApplied ? '<span class="epb-v penalty">⚠ -10% React</span>' : ''}</span></div>
    </div>
  </div>`;
}

function equipPerformanceTabHtml(u) {
  const nf = u.nonFinancial || { deploymentHoursThisMonth: 0, fuelConsumptionThisMonth: 0 };
  const f = u.financial || {};
  const showFuel = f.fuelType === 'DIESEL';
  const ps = nf.performanceScore;
  const score = ps ? ps.finalScore : 0;
  const gr = equipGrade(score);
  const scoreColor = score >= 80 ? 'var(--green)' : score >= 60 ? '#0D9488' : score >= 40 ? 'var(--amber)' : 'var(--red)';
  const colorClass = score >= 80 ? 'perf-score-green' : score >= 50 ? 'perf-score-amber' : 'perf-score-red';
  const ratingTier = gr.tier;
  
  // Use perfRingHtml pattern for the large ring but with equipment score bands
  const ringSize = 72, ringFontSize = 20;
  const ringStroke = Math.max(5, Math.round(ringSize * 0.09));
  const ringR = ringSize / 2 - ringStroke, ringCIRC = 2 * Math.PI * ringR;
  const ringFrac = ENGINE.clamp(score, 0, 100) / 100;
  
  const ringHtml = `<div class="perf-ring-wrap" style="width:${ringSize}px;height:${ringSize}px">
    <svg viewBox="0 0 ${ringSize} ${ringSize}" width="${ringSize}" height="${ringSize}">
      <circle cx="${ringSize/2}" cy="${ringSize/2}" r="${ringR}" fill="none" stroke="var(--surface-alt)" stroke-width="${ringStroke}"/>
      <circle class="perf-ring-fill" cx="${ringSize/2}" cy="${ringSize/2}" r="${ringR}" fill="none" stroke="${scoreColor}" stroke-width="${ringStroke}" stroke-linecap="round"
        transform="rotate(-90 ${ringSize/2} ${ringSize/2})" stroke-dasharray="${ringCIRC.toFixed(1)}" stroke-dashoffset="${ringCIRC.toFixed(1)}"
        data-target="${(ringCIRC * (1 - ringFrac)).toFixed(1)}"/>
    </svg>
    <div class="perf-ring-num mono" style="font-size:${ringFontSize}px;color:${scoreColor}">${score}</div>
  </div>`;

  const config = getActiveEquipPerfConfig().params;
  const curve = ps ? ps.curveUsed : { yearlyDeclinePercent: 8, floorPercent: 35 };
  const ageDecayTotal = ps ? +(ps.ageYears * curve.yearlyDeclinePercent).toFixed(1) : 0;
  const isFloorClamped = ps ? (100 - ageDecayTotal) < curve.floorPercent : false;

  // Natural language summary of why this score was reached
  let narrative = '';
  if (ps) {
    const parts = [];
    parts.push(`Started at 100% baseline`);
    parts.push(`lost ${ageDecayTotal}% across ${ps.ageYears} yrs of operational life`);
    if (ps.maintenanceBonusApplied) parts.push(`gained +${config.maintenanceBonusPercent}% for recent preventive maintenance`);
    if (ps.reactivationPenaltyApplied) parts.push(`deducted -${config.reactivationPenaltyPercent}% risk penalty for recent post-repair reactivation`);
    if (isFloorClamped) parts.push(`protected by ${curve.floorPercent}% safety floor`);
    narrative = parts.join(', ') + '.';
  }

  const decayChart = ps ? equipDecayChartSVG(u) : '';

  return `<div class="dw-section" style="margin-top:0">
      <div class="eq-perf-headline">
        ${ringHtml}
        <div>
          <div class="eq-perf-score-label ${colorClass}">Equipment Performance Score</div>
          <div class="eq-modal-grade-wrap">
            <span class="grade-badge ${gr.class}">${gr.label}</span>
            <span class="eq-modal-grade-desc">${escapeHtml(gr.meaning)}</span>
          </div>
          <div class="eq-perf-score-sub" style="margin-top:4px">${escapeHtml(u.type)} · ${ps ? escapeHtml(ps.category) : 'N/A'} · <span class="mono" style="font-weight:600">${ratingTier}</span></div>
          <p style="font-size:11.5px;color:var(--text-mute);margin:5px 0 0;line-height:1.4">${escapeHtml(narrative)}</p>
        </div>
      </div>

      ${ps ? `
      <!-- STEP-BY-STEP CALCULATION LEDGER -->
      <div style="margin-top:14px">
        <h4 style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;color:var(--text-mute);margin-bottom:8px">Score Derivation Ledger (How this score was calculated)</h4>
        <div class="eq-ledger-card">
          <div class="elc-row">
            <div class="elc-icon">📦</div>
            <div class="elc-info">
              <span class="elc-name">1. Brand New Baseline (Year 0)</span>
              <span class="elc-sub">Full factory standard operational capability</span>
            </div>
            <div class="elc-val mono good">+100.0%</div>
          </div>

          <div class="elc-row">
            <div class="elc-icon">⏳</div>
            <div class="elc-info">
              <span class="elc-name">2. Natural Age Wear & Tear</span>
              <span class="elc-sub">${ps.ageYears} yrs active × ${curve.yearlyDeclinePercent}%/yr nominal decline for ${escapeHtml(ps.category)}</span>
            </div>
            <div class="elc-val mono bad">−${ageDecayTotal.toFixed(1)}%</div>
          </div>

          <div class="elc-row">
            <div class="elc-icon">🔧</div>
            <div class="elc-info">
              <span class="elc-name">3. 90-Day Preventive Service Bonus</span>
              <span class="elc-sub">${ps.maintenanceBonusApplied ? 'Active bonus: Routine preventive maintenance logged within last 90 days' : 'No service entry logged in last 90 days'}</span>
            </div>
            <div class="elc-val mono ${ps.maintenanceBonusApplied ? 'bonus' : 'neutral'}">${ps.maintenanceBonusApplied ? `+${config.maintenanceBonusPercent}.0%` : '0.0%'}</div>
          </div>

          <div class="elc-row">
            <div class="elc-icon">⚠️</div>
            <div class="elc-info">
              <span class="elc-name">4. 30-Day Post-Repair Risk Penalty</span>
              <span class="elc-sub">${ps.reactivationPenaltyApplied ? 'Active penalty: Corrective overhaul/repair logged within last 30 days' : 'Zero recent breakdowns — systems operating stably'}</span>
            </div>
            <div class="elc-val mono ${ps.reactivationPenaltyApplied ? 'penalty' : 'neutral'}">${ps.reactivationPenaltyApplied ? `−${config.reactivationPenaltyPercent}.0%` : '0.0%'}</div>
          </div>

          ${isFloorClamped ? `
          <div class="elc-row">
            <div class="elc-icon">🛡️</div>
            <div class="elc-info">
              <span class="elc-name">5. Safety Floor Protection</span>
              <span class="elc-sub">Protected by regulatory operational baseline minimum of ${curve.floorPercent}%</span>
            </div>
            <div class="elc-val mono warn">Floor ${curve.floorPercent}%</div>
          </div>` : ''}

          <div class="elc-total">
            <div>
              <div class="elc-tot-lbl">Derived Performance Score</div>
              <span class="grade-badge ${gr.class}" style="margin-top:3px">${gr.label} (${score}%)</span>
            </div>
            <div class="elc-tot-val mono ${colorClass}">${ps.finalScore}%</div>
          </div>
        </div>
      </div>

      <!-- CONTRIBUTING DRIVERS & OPERATIONAL GUIDANCE -->
      <div class="eq-guide-grid">
        <div class="egg-card ${ps.maintenanceBonusApplied ? 'ok' : 'action'}">
          <span class="egg-tag ${ps.maintenanceBonusApplied ? 'ok' : 'action'}">${ps.maintenanceBonusApplied ? 'Bonus Active' : 'Action Required'}</span>
          <div class="egg-title">Maintenance Standing</div>
          <p class="egg-text">${ps.maintenanceBonusApplied ? `Unit is rewarded with +${config.maintenanceBonusPercent}% bonus for active scheduled servicing.` : `Log a routine inspection or service to grant this unit a +${config.maintenanceBonusPercent}% performance boost.`}</p>
        </div>
        <div class="egg-card ${ps.reactivationPenaltyApplied ? 'warn' : 'ok'}">
          <span class="egg-tag ${ps.reactivationPenaltyApplied ? 'warn' : 'ok'}">${ps.reactivationPenaltyApplied ? 'Penalty Active' : 'Stable Ops'}</span>
          <div class="egg-title">Breakdown Risk</div>
          <p class="egg-text">${ps.reactivationPenaltyApplied ? `Under observation after corrective repair. Penalty automatically clears 30 days post-repair.` : `No corrective repairs logged recently. Machine running reliably with 0% risk penalty.`}</p>
        </div>
      </div>
      ` : ''}

      ${decayChart}
    </div>
    <div class="dw-section">
      <h4>Deployment this month</h4>
      ${utilisationBarHtml(nf.deploymentHoursThisMonth)}
    </div>
    ${showFuel ? `<div class="dw-section"><h4>Fuel consumption this month</h4>
      <div class="v mono" style="font-size:15px">${nf.fuelConsumptionThisMonth} L</div></div>` : ''}
    <div class="dw-section"><h4>Aircraft suitability</h4>
      <div class="dw-perms">${suitabilityTagsHtml(u)}</div>
    </div>`;
}
let equipDetailOpenId = null;
let equipDetailTab = 'overview';

function equipStatusBadge(status) {
  const cls = { SERVICEABLE: 'b-approved', MAINTENANCE: 'b-pending', UNSERVICEABLE: 'b-suspended', RETIRED: 'b-suspended' }[status] || 'b-pending';
  return `<span class="badge ${cls}"><span class="dot"></span>${status}</span>`;
}

function openEquipDetail(id) {
  const u = getGse().find(x => x.id === id); if (!u) return;
  const ghaId = ghaOf(u);
  const gha = getGha(ghaId);
  const color = ghaColorFor(ghaId);
  const catIcon = { POWERED: '⚡', NON_POWERED: '📦', INFRASTRUCTURE: '🏗' }[u.category] || '⚙';
  const canEdit = hasPermission('equipment');

  equipDetailOpenId = id;
  const modal = openModal(`
    <div class="modal-head">
      <div style="display:flex;align-items:center;gap:12px">
        <div class="drawer-avatar" style="width:40px;height:40px;font-size:16px;margin-bottom:0;background:color-mix(in srgb, ${color} 16%, transparent);color:${color}">${catIcon}</div>
        <div>
          <h3 style="font-size:17px;font-weight:700">${escapeHtml(u.type)} — <span class="mono">${escapeHtml(u.serial)}</span></h3>
          <p class="mono" style="font-size:12px;color:var(--text-mute);margin-top:2px">${escapeHtml(u.category)} · Operator: ${escapeHtml(gha ? gha.name : 'Unassigned')}</p>
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:8px">
        ${canEdit ? `<button class="btn btn-ghost btn-xs" id="eq-modal-edit" type="button">Edit unit</button>` : ''}
        <button class="modal-x" data-x aria-label="Close"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6 L18 18 M18 6 L6 18"/></svg></button>
      </div>
    </div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin:-8px 0 16px">
      ${equipStatusBadge(u.status)}
      ${ownBadge(u.ownership)}
      <span class="role-badge" style="font-size:11px">${escapeHtml(u.category)}</span>
    </div>

    <div class="gse-cat-tabs" id="eq-modal-tabs" style="margin-bottom:14px">
      <button type="button" class="gct-tab ${equipDetailTab === 'overview' ? 'active' : ''}" data-eqtab="overview">Overview & Service</button>
      <button type="button" class="gct-tab ${equipDetailTab === 'financial' ? 'active' : ''}" data-eqtab="financial">Financial</button>
      <button type="button" class="gct-tab ${equipDetailTab === 'performance' ? 'active' : ''}" data-eqtab="performance">Performance</button>
    </div>
    <div id="eq-detail-content"></div>`, true);
  modal.classList.add('equip-detail-modal');

  const closeEquipDetail = () => { equipDetailOpenId = null; closeModal(); };
  const host = document.getElementById('modal-host');
  host.onclick = e => { if (e.target === host) closeEquipDetail(); };
  modal.querySelectorAll('[data-x]').forEach(b => b.onclick = closeEquipDetail);

  const editBtn = modal.querySelector('#eq-modal-edit');
  if (editBtn) editBtn.onclick = () => openEquipModal(id);

  modal.querySelector('#eq-modal-tabs').onclick = e => {
    const b = e.target.closest('[data-eqtab]'); if (!b || b.dataset.eqtab === equipDetailTab) return;
    equipDetailTab = b.dataset.eqtab;
    modal.querySelectorAll('[data-eqtab]').forEach(x => x.classList.toggle('active', x === b));
    paintEquipDetailTab(u, modal);
  };

  paintEquipDetailTab(u, modal);
}

function paintEquipDetailTab(u, modal) {
  const id = u.id;
  const currentUnit = getGse().find(x => x.id === id) || u;
  const log = (currentUnit.maintLog || []).slice().sort((a, b) => new Date(b.date) - new Date(a.date));
  const ghaId = ghaOf(currentUnit);
  const gha = getGha(ghaId);
  const viewAgentBtn = (gha && hasPermission('gha'))
    ? ` <button class="btn btn-ghost btn-xs" id="ml-view-agent" type="button" style="margin-left:6px">View agent</button>` : '';

  const tabHtml = equipDetailTab === 'financial' ? equipFinancialTabHtml(currentUnit)
    : equipDetailTab === 'performance' ? equipPerformanceTabHtml(currentUnit)
      : equipOverviewTabHtml(currentUnit, gha, viewAgentBtn, log);

  modal.querySelector('#eq-detail-content').innerHTML = tabHtml;

  if (equipDetailTab === 'performance') {
    animatePerfRings(modal);
  }

  if (equipDetailTab === 'overview') {
    const viewAgentEl = modal.querySelector('#ml-view-agent');
    if (viewAgentEl) viewAgentEl.onclick = () => openGhaDetail(ghaId);

    const addBtn = modal.querySelector('#ml-add');
    if (addBtn) {
      addBtn.onclick = () => {
        const date = modal.querySelector('#ml-date').value, hours = Number(modal.querySelector('#ml-hours').value) || 0;
        const type = modal.querySelector('#ml-type').value.trim() || 'Service', notes = modal.querySelector('#ml-notes').value.trim();
        const g = getGse(); const unit = g.find(x => x.id === id);
        if (!unit) return;
        unit.maintLog = unit.maintLog || [];
        unit.maintLog.push({ date: date ? new Date(date).toISOString() : nowISO(), type, notes, hours });
        unit.lastService = date ? new Date(date).toISOString() : nowISO();
        if (unit.financial) unit.financial.maintenanceCostToDate = (unit.financial.maintenanceCostToDate || 0) + Math.round(150 + hours * 45);
        saveGse(g);
        recomputeAllEquipmentScores();
        logActivity({ action: `logged maintenance on ${unit.serial}`, target: type, category: 'equipment', severity: 'info' });
        showToast('Maintenance entry added', 'success');
        paintEquipDetailTab(unit, modal);
        renderEquipmentBody();
      };
    }
  }
}

function openMaintDrawer(id) {
  openEquipDetail(id);
}

/* ═══ S7b — GHA MANAGEMENT (key: gha) ═══════════════════════
   Ground Handling Agents as a first-class entity — inventory and
   management only. Performance scoring / GHO certification are later
   prompts that extend this data model, not this pass. */
let ghaLoaded = false;
let ghaListFilter = { q: '', status: 'ALL', ownership: 'ALL' };
let ghaReassignSelection = new Set();

function ghaStatusBadge(status) {
  const cls = { ACTIVE: 'b-approved', SUSPENDED: 'b-pending', TERMINATED: 'b-suspended' }[status] || 'b-suspended';
  return `<span class="badge ${cls}"><span class="dot"></span>${status}</span>`;
}
function ghaOwnershipBadge(ownership) {
  return `<span class="role-badge">${ownership === 'AIRPORT_SUBSIDIARY' ? 'Airport Subsidiary' : 'Private'}</span>`;
}
function ghaContractFlagHtml(g) {
  const { state, daysLeft } = ghaContractState(g);
  if (state === 'expired') return `<span class="orc-err bad mono">Expired ${Math.abs(daysLeft)}d ago</span>`;
  if (state === 'expiring') return `<span class="orc-err warn mono">Expiring in ${daysLeft}d</span>`;
  return `<span class="orc-err good mono">${daysLeft}d remaining</span>`;
}

function renderGhaManagement(el) {
  if (!ghaLoaded) {
    el.innerHTML = `<div id="gha-skeleton"><div class="sk sk-banner"></div>
      <div class="sk-strip"><div class="sk sk-tile"></div><div class="sk sk-tile"></div><div class="sk sk-tile"></div><div class="sk sk-tile"></div></div>
      <div class="sk sk-block"></div></div>`;
    setTimeout(() => { ghaLoaded = true; paintGhaManagement(el); }, LOAD_DELAY);
    return;
  }
  paintGhaManagement(el);
}

function ghaCardHtml(g, i, perfConfig) {
  const color = ghaColorFor(g.id);
  const { cats, total } = ghaFleetBreakdown(g.id);
  const catRows = [['POWERED', '⚡ Powered'], ['NON_POWERED', '📦 Non-powered'], ['INFRASTRUCTURE', '🏗 Infrastructure']]
    .map(([k, label]) => {
      const pct = total ? Math.round(cats[k] / total * 100) : 0;
      return `<div class="grc-row"><span class="grc-lbl">${label}</span>
        <span class="grc-bar"><span style="width:${pct}%;background:${color}"></span></span>
        <span class="mono grc-val">${cats[k]}</span></div>`;
    }).join('');
  const rec = getGhaPerfRecord(g.id, currentPeriod());
  const threshold = perfConfig.params.minimumThreshold;
  const perfBadge = rec ? `<div class="ghc-perf-mini" title="Overall performance score — ${rec.overallScore}/100">${perfRingHtml(rec.overallScore, threshold, 38, 12)}</div>` : '';
  return `<div class="gha-card card-stagger ${rec && rec.belowMinimum ? 'perf-flagged' : ''}" data-gha-id="${g.id}" style="--gha:${color};animation-delay:${i * 40}ms">
    <div class="ghc-top" style="align-items:flex-start">
      <div><span class="ghc-name" style="font-size:15px">${escapeHtml(g.name)}</span>
        <div style="margin-top:5px;display:flex;gap:6px;flex-wrap:wrap">${ghaStatusBadge(g.status)}${ghaOwnershipBadge(g.ownership)}${ghoBadgeHtml(g.id)}</div></div>
      <div style="display:flex;align-items:center;gap:8px;flex:0 0 auto">
        ${perfBadge}
        <span class="gha-badge" style="--gha:${color}">${escapeHtml(g.code)}</span>
        <button class="kebab-btn" data-kebab="${g.id}" aria-label="Actions" type="button"><svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor"><circle cx="12" cy="5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="19" r="1.6"/></svg></button>
      </div>
    </div>
    ${rec && rec.belowMinimum ? `<div class="perf-warn-chip mono">⚠ Below minimum performance (${rec.overallScore}/${threshold})</div>` : ''}
    <div class="gr-cats" style="margin-top:12px">${total ? catRows : '<p class="rs-none">No equipment assigned.</p>'}</div>
    <div class="dw-perms" style="margin-top:10px">${g.airlinesServed && g.airlinesServed.length ? g.airlinesServed.map(a => `<span class="dw-perm">${escapeHtml(a)}</span>`).join('') : '<span class="mono" style="font-size:11px;color:var(--text-mute)">No scheduled airlines</span>'}</div>
    <div class="ghc-foot" style="margin-top:12px;justify-content:space-between">
      <span class="mono ghc-units">${total} unit${total === 1 ? '' : 's'}</span>
      ${ghaContractFlagHtml(g)}
    </div>
  </div>`;
}

let ghaModuleTab = 'agents';

function ghaWarningBannerHtml(warnings) {
  return `<div class="perf-warn-banner">
    <span class="pwb-dot"></span>
    <div class="pwb-text"><strong>${warnings.length} agent${warnings.length === 1 ? '' : 's'} below minimum performance.</strong>
      ${warnings.map(w => `${escapeHtml(w.gha.name)} (${w.rec.overallScore}/100)`).join(' · ')}</div>
  </div>`;
}

/* ── Re-evaluate now (Part D5) — reuses the recalc-box progress pattern
   already used for fleet-status recalculation elsewhere in this app ── */
async function runGhoReevaluation() {
  const modal = openModal(`<div class="modal-head"><div><h3>Re-evaluating certifications</h3><p>Checking every active agent against current GHO rules</p></div></div><div id="ghoeval-host"></div>`);
  const host = modal.querySelector('#ghoeval-host');
  const ghas = getGhas().filter(g => g.status === 'ACTIVE');
  host.innerHTML = `<div class="recalc-box">
      <div class="recalc-head"><span class="spinner" style="border-color:rgba(37,99,235,.25);border-top-color:var(--primary)"></span>
        <span>Evaluating agents…</span></div>
      <div class="recalc-now mono" id="ghoeval-now">—</div>
      <div class="recalc-track"><span class="recalc-fill" id="ghoeval-fill"></span></div>
    </div>`;
  for (let i = 0; i < ghas.length; i++) {
    const nowEl = host.querySelector('#ghoeval-now'); if (nowEl) nowEl.textContent = ghas[i].name;
    const fill = host.querySelector('#ghoeval-fill'); if (fill) fill.style.width = ((i + 1) / ghas.length * 100) + '%';
    await new Promise(r => setTimeout(r, 180));
  }

  const summary = recomputeGhoStatuses();
  const parts = [];
  if (summary.issued) parts.push(`${summary.issued} certificate${summary.issued === 1 ? '' : 's'} issued`);
  if (summary.renewed) parts.push(`${summary.renewed} renewed to good standing`);
  if (summary.atRisk) parts.push(`${summary.atRisk} moved to at-risk`);
  if (summary.revoked) parts.push(`${summary.revoked} revoked`);
  if (summary.expired) parts.push(`${summary.expired} expired`);
  const summaryText = parts.length ? parts.join(', ') : 'No status changes';

  host.innerHTML = `<div class="recalc-summary">
      <div class="rs-head"><strong>Re-evaluation complete</strong> · ${ghas.length} agent${ghas.length === 1 ? '' : 's'} checked</div>
      <p style="font-size:13px;color:var(--text-mute);margin-top:6px">${escapeHtml(summaryText)}</p>
    </div>
    <div class="modal-foot"><button class="btn btn-primary" id="ghoeval-close" type="button">Done</button></div>`;
  host.querySelector('#ghoeval-close').onclick = closeModal;
  showToast(summaryText, parts.length ? 'success' : 'notice');
  if (currentModule === 'gha') paintGhaManagement(document.querySelector('.module-view'));
}

function paintGhaManagement(el) {
  const all = getGhas();
  const perfConfig = getActiveGhaPerfConfig();
  const warnings = ghasBelowMinimum();
  const canConfig = hasPermission('weights');
  if (ghaModuleTab === 'config' && !canConfig) ghaModuleTab = 'agents';

  el.innerHTML = `
    <div class="mod-wide">
      <div class="mod-head"><div><h1 class="mod-title">GHA Management</h1>
        <p class="mod-sub">${all.length} ground handling agent${all.length === 1 ? '' : 's'} · Multan (MUX)</p></div>
        <div style="display:flex;gap:8px">
          ${canConfig ? `<button class="btn btn-ghost btn-sm" id="gho-reeval" type="button">Re-evaluate now</button>` : ''}
          <button class="btn btn-primary btn-sm" id="gha-add" type="button">+ Add GHA</button>
        </div></div>

      ${warnings.length ? ghaWarningBannerHtml(warnings) : ''}

      <div class="gse-cat-tabs" id="gha-mod-tabs">
        <button type="button" class="gct-tab ${ghaModuleTab === 'agents' ? 'active' : ''}" data-modtab="agents">Agents</button>
        <button type="button" class="gct-tab ${ghaModuleTab === 'leaderboard' ? 'active' : ''}" data-modtab="leaderboard">Performance Leaderboard</button>
        <button type="button" class="gct-tab ${ghaModuleTab === 'registry' ? 'active' : ''}" data-modtab="registry">GHO Registry</button>
        ${canConfig ? `<button type="button" class="gct-tab ${ghaModuleTab === 'config' ? 'active' : ''}" data-modtab="config">Configuration</button>` : ''}
      </div>

      <div id="gha-tab-content"></div>
    </div>`;

  el.querySelector('#gha-add').onclick = () => openGhaModal(null);
  if (canConfig) el.querySelector('#gho-reeval').onclick = () => runGhoReevaluation();
  el.querySelector('#gha-mod-tabs').onclick = e => {
    const b = e.target.closest('[data-modtab]'); if (!b || b.dataset.modtab === ghaModuleTab) return;
    ghaModuleTab = b.dataset.modtab;
    paintGhaManagement(el);
  };

  const content = el.querySelector('#gha-tab-content');
  if (ghaModuleTab === 'leaderboard') paintGhaLeaderboard(content);
  else if (ghaModuleTab === 'registry') paintGhoRegistry(content);
  else if (ghaModuleTab === 'config' && canConfig) { paintGhaPerfConfig(content); paintEquipPerfConfig(content); }
  else paintGhaAgentsTab(content, perfConfig);
}

function paintGhaAgentsTab(el, perfConfig) {
  const all = getGhas();
  const active = all.filter(g => g.status === 'ACTIVE');
  const inactive = all.filter(g => g.status !== 'ACTIVE');
  const expiringSoon = all.filter(g => ghaContractState(g).state === 'expiring').length;
  const totalUnitsManaged = getGse().filter(u => u.status !== 'RETIRED' && u.ghaId).length;
  const unassignedUnits = getGse().filter(u => u.status !== 'RETIRED' && !u.ghaId).length;

  const q = ghaListFilter.q.trim().toLowerCase();
  const rows = all.filter(g => {
    if (ghaListFilter.status !== 'ALL' && g.status !== ghaListFilter.status) return false;
    if (ghaListFilter.ownership !== 'ALL' && g.ownership !== ghaListFilter.ownership) return false;
    if (q && !(`${g.name} ${g.code}`.toLowerCase().includes(q))) return false;
    return true;
  }).sort((a, b) => a.name.localeCompare(b.name));

  el.innerHTML = `
    <div class="fleet-strip">
      <div class="fs-tile"><span class="fs-num mono" id="gha-num-active">0</span><span class="fs-lbl">Active agents</span></div>
      <div class="fs-tile"><span class="fs-num mono" id="gha-num-units">0</span><span class="fs-lbl">Fleet units managed</span></div>
      <div class="fs-tile ${expiringSoon ? 'warn' : ''}"><span class="fs-num mono" id="gha-num-expiring">0</span><span class="fs-lbl">Contracts expiring ≤90d</span></div>
      <div class="fs-tile ${inactive.length ? 'warn' : ''}"><span class="fs-num mono" id="gha-num-inactive">0</span><span class="fs-lbl">Suspended / terminated</span></div>
    </div>

    <div class="filters" style="border:1px solid var(--border);border-radius:var(--r);margin-bottom:16px">
      <div class="search"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20 L16.5 16.5"/></svg>
        <input type="text" id="gha-search" placeholder="Search by name or code…" value="${escapeHtml(ghaListFilter.q)}" autocomplete="off"/></div>
      <select id="gha-status-filter" class="filter-select">
        <option value="ALL" ${ghaListFilter.status === 'ALL' ? 'selected' : ''}>All statuses</option>
        <option value="ACTIVE" ${ghaListFilter.status === 'ACTIVE' ? 'selected' : ''}>Active</option>
        <option value="SUSPENDED" ${ghaListFilter.status === 'SUSPENDED' ? 'selected' : ''}>Suspended</option>
        <option value="TERMINATED" ${ghaListFilter.status === 'TERMINATED' ? 'selected' : ''}>Terminated</option>
      </select>
      <select id="gha-ownership-filter" class="filter-select">
        <option value="ALL" ${ghaListFilter.ownership === 'ALL' ? 'selected' : ''}>All ownership types</option>
        <option value="PRIVATE" ${ghaListFilter.ownership === 'PRIVATE' ? 'selected' : ''}>Private</option>
        <option value="AIRPORT_SUBSIDIARY" ${ghaListFilter.ownership === 'AIRPORT_SUBSIDIARY' ? 'selected' : ''}>Airport Subsidiary</option>
      </select>
    </div>

    <div class="gha-grid" id="gha-list">${rows.map((g, i) => ghaCardHtml(g, i, perfConfig)).join('')}</div>
    ${!rows.length ? emptyState('No matching agents', 'Try a different search term or filter.') : ''}
    ${unassignedUnits ? `<p class="an-cap mono" style="margin-top:14px">${unassignedUnits} equipment unit${unassignedUnits === 1 ? '' : 's'} currently have no assigned agent — expected for airport-owned units, no action needed.</p>` : ''}`;

  countUp(document.getElementById('gha-num-active'), active.length);
  countUp(document.getElementById('gha-num-units'), totalUnitsManaged);
  countUp(document.getElementById('gha-num-expiring'), expiringSoon);
  countUp(document.getElementById('gha-num-inactive'), inactive.length);
  animatePerfRings(el);

  el.querySelector('#gha-search').oninput = e => { ghaListFilter.q = e.target.value; paintGhaManagementPreserveFocus(document.querySelector('.module-view')); };
  el.querySelector('#gha-status-filter').onchange = e => { ghaListFilter.status = e.target.value; paintGhaAgentsTab(el, perfConfig); };
  el.querySelector('#gha-ownership-filter').onchange = e => { ghaListFilter.ownership = e.target.value; paintGhaAgentsTab(el, perfConfig); };
  el.querySelector('#gha-list').onclick = e => {
    const kebab = e.target.closest('[data-kebab]');
    if (kebab) { e.stopPropagation(); openGhaMenu(kebab.dataset.kebab, kebab); return; }
    const card = e.target.closest('[data-gha-id]'); if (card) { ghaDetailTab = 'overview'; openGhaDetail(card.dataset.ghaId); }
  };
}

function paintGhaManagementPreserveFocus(el) {
  const searchInput = document.getElementById('gha-search');
  const isFocused = document.activeElement === searchInput;
  const selStart = searchInput ? searchInput.selectionStart : 0;
  const selEnd = searchInput ? searchInput.selectionEnd : 0;
  paintGhaAgentsTab(document.getElementById('gha-tab-content'), getActiveGhaPerfConfig());
  if (isFocused) {
    const newInp = document.getElementById('gha-search');
    if (newInp) { newInp.focus(); try { newInp.setSelectionRange(selStart, selEnd); } catch (e) { } }
  }
}

/* ── performance leaderboard (Part D3) ── */
let ghaLeaderboardPeriod = currentPeriod();
let ghaLeaderboardSort = 'score-desc';
function paintGhaLeaderboard(el) {
  const config = getActiveGhaPerfConfig();
  const threshold = config.params.minimumThreshold;
  const periods = last6Periods();
  const ghas = getGhas().filter(g => g.status === 'ACTIVE');
  const rows = ghas.map(g => ({ gha: g, rec: getGhaPerfRecord(g.id, ghaLeaderboardPeriod) })).filter(r => r.rec);

  const sorters = {
    'score-desc': (a, b) => b.rec.overallScore - a.rec.overallScore,
    'score-asc': (a, b) => a.rec.overallScore - b.rec.overallScore,
    name: (a, b) => a.gha.name.localeCompare(b.gha.name)
  };
  rows.sort(sorters[ghaLeaderboardSort] || sorters['score-desc']);

  el.innerHTML = `
    <div class="card">
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;margin-bottom:14px">
        <h3 class="card-h" style="margin:0">Performance leaderboard</h3>
        <div style="display:flex;gap:8px;align-items:center">
          <select id="lb-period" class="filter-select">
            ${periods.map(p => `<option value="${p}" ${p === ghaLeaderboardPeriod ? 'selected' : ''}>${escapeHtml(periodLabel(p))}</option>`).join('')}
          </select>
          <select id="lb-sort" class="filter-select">
            <option value="score-desc" ${ghaLeaderboardSort === 'score-desc' ? 'selected' : ''}>Score · high to low</option>
            <option value="score-asc" ${ghaLeaderboardSort === 'score-asc' ? 'selected' : ''}>Score · low to high</option>
            <option value="name" ${ghaLeaderboardSort === 'name' ? 'selected' : ''}>Name</option>
          </select>
        </div>
      </div>
      <div class="table-scroll"><table class="eq-tbl">
        <thead><tr><th>#</th><th>Agent</th><th>Score</th><th>Deployment</th><th>Serviceability</th><th>Suitability</th><th>Fuel Eff.</th><th>Status</th></tr></thead>
        <tbody id="lb-body">
          ${rows.length ? rows.map((r, i) => {
    const tier = ghaScoreTier(r.rec.overallScore, threshold);
    const color = tier === 'green' ? 'var(--green)' : tier === 'amber' ? 'var(--amber)' : 'var(--red)';
    return `<tr data-gha-id="${r.gha.id}" class="card-stagger" style="animation-delay:${i * 40}ms">
              <td class="mono">${i + 1}</td>
              <td>${escapeHtml(r.gha.name)}</td>
              <td class="mono" style="font-weight:700;color:${color}">${r.rec.overallScore}</td>
              <td class="mono">${r.rec.metrics.deployment}%</td>
              <td class="mono">${r.rec.metrics.serviceability}%</td>
              <td class="mono">${r.rec.metrics.suitability}%</td>
              <td class="mono">${r.rec.metrics.fuelEfficiency}%</td>
              <td>${r.rec.belowMinimum ? '<span class="eq-status es-bad">BELOW MIN</span>' : '<span class="eq-status es-ok">OK</span>'}</td>
            </tr>`;
  }).join('') : `<tr><td colspan="8">${emptyState('No data for this period', 'Try a different month.')}</td></tr>`}
        </tbody>
      </table></div>
    </div>`;

  el.querySelector('#lb-period').onchange = e => { ghaLeaderboardPeriod = e.target.value; paintGhaLeaderboard(el); };
  el.querySelector('#lb-sort').onchange = e => { ghaLeaderboardSort = e.target.value; paintGhaLeaderboard(el); };
  el.querySelector('#lb-body').onclick = e => {
    const row = e.target.closest('[data-gha-id]'); if (!row) return;
    ghaDetailTab = 'performance';
    openGhaDetail(row.dataset.ghaId);
  };
}

/* ── GHO registry (Part D3) — the kind of screen shown to an auditor,
   so it gets a more formal visual treatment than the operational tabs ── */
function paintGhoRegistry(el) {
  /* same ACTIVE-only scope as the Manager Dashboard's certification tile,
     so the two counts can never diverge (a suspended/terminated GHA
     shouldn't appear "certified" in the register even if an old certificate
     is technically still on file) */
  const withCert = getGhas().filter(g => g.status === 'ACTIVE').map(g => ({ gha: g, cert: currentGhoCertificate(g.id) }));
  const issued = withCert.filter(x => x.cert && x.cert.status === 'ISSUED').sort((a, b) => b.cert.trailingAverageScore - a.cert.trailingAverageScore);
  const atRisk = withCert.filter(x => x.cert && x.cert.status === 'AT_RISK').sort((a, b) => b.cert.trailingAverageScore - a.cert.trailingAverageScore);

  el.innerHTML = `
    <div class="gho-registry">
      <div class="gho-registry-head">
        <div class="gho-registry-seal">${ghoSealSVG(48)}</div>
        <div>
          <h2>Certified Ground Handling Agents</h2>
          <p class="mono">Official register · Multan International Airport (MUX) · ${issued.length} certified agent${issued.length === 1 ? '' : 's'}</p>
        </div>
      </div>

      <div class="table-scroll"><table class="eq-tbl gho-registry-tbl">
        <thead><tr><th>Agent</th><th>Certificate No.</th><th>Issued</th><th>Expires</th><th>Trailing Score</th><th></th></tr></thead>
        <tbody>
          ${issued.length ? issued.map(({ gha, cert }) => `
            <tr data-cert-id="${cert.id}">
              <td>${escapeHtml(gha.name)}</td>
              <td class="mono">${escapeHtml(cert.certificateNumber)}</td>
              <td class="mono">${fmtDate(cert.issuedAt)}</td>
              <td class="mono">${fmtDate(cert.expiresAt)}</td>
              <td class="mono" style="font-weight:700;color:var(--green)">${cert.trailingAverageScore}%</td>
              <td><button class="btn btn-ghost btn-xs" data-view-cert="${cert.id}" type="button">View</button></td>
            </tr>`).join('') : `<tr><td colspan="6">${emptyState('No certified agents yet', 'Run Re-evaluate now once enough performance history exists.')}</td></tr>`}
        </tbody>
      </table></div>

      ${atRisk.length ? `
      <div class="gho-atrisk-section">
        <h3 class="card-h" style="color:#92400E">⚠ At-risk certificates (${atRisk.length})</h3>
        <div class="table-scroll"><table class="eq-tbl">
          <thead><tr><th>Agent</th><th>Certificate No.</th><th>Expires</th><th>Trailing Score</th><th></th></tr></thead>
          <tbody>
            ${atRisk.map(({ gha, cert }) => `
              <tr data-cert-id="${cert.id}">
                <td>${escapeHtml(gha.name)}</td>
                <td class="mono">${escapeHtml(cert.certificateNumber)}</td>
                <td class="mono">${fmtDate(cert.expiresAt)}</td>
                <td class="mono" style="font-weight:700;color:var(--amber)">${cert.trailingAverageScore}%</td>
                <td><button class="btn btn-ghost btn-xs" data-view-cert="${cert.id}" type="button">View</button></td>
              </tr>`).join('')}
          </tbody>
        </table></div>
      </div>` : ''}
    </div>`;

  el.querySelectorAll('[data-view-cert]').forEach(b => b.onclick = e => { e.stopPropagation(); openCertificateView(b.dataset.viewCert); });
  el.querySelectorAll('tr[data-cert-id]').forEach(row => row.onclick = () => openCertificateView(row.dataset.certId));
}

/* ── performance config (Part F) — append-only, identical UX to Weights & Thresholds ── */
function saveNewGhaPerfConfigVersion(params, note) {
  const versions = getGhaPerfConfigVersions();
  versions.forEach(v => { if (v.status === 'ACTIVE') v.status = 'SUPERSEDED'; });
  const nv = {
    id: 'gpc-' + uid('v').slice(-6), createdAt: nowISO(), author: currentActor(),
    note: note || 'Manual calibration update.', status: 'ACTIVE', params: JSON.parse(JSON.stringify(params))
  };
  versions.push(nv); saveGhaPerfConfigVersions(versions);
  logActivity({ action: 'created GHA performance config version', target: nv.id, category: 'gha-performance', severity: 'warn' });
  return nv;
}

function saveNewEquipPerfConfigVersion(params, note) {
  const versions = getEquipPerfConfigVersions();
  versions.forEach(v => { if (v.status === 'ACTIVE') v.status = 'SUPERSEDED'; });
  const nv = {
    id: 'epc-' + uid('v').slice(-6), createdAt: nowISO(), author: currentActor(),
    note: note || 'Manual equipment decay configuration update.', status: 'ACTIVE',
    params: JSON.parse(JSON.stringify(params))
  };
  versions.push(nv); saveEquipPerfConfigVersions(versions);
  logActivity({ action: 'created equipment performance config version', target: nv.id, category: 'equipment', severity: 'warn' });
  return nv;
}
function paintGhaPerfConfig(el) {
  const active = getActiveGhaPerfConfig();
  const proposed = JSON.parse(JSON.stringify(active.params));
  const metricKeys = ['deployment', 'serviceability', 'suitability', 'fuelEfficiency'];

  el.innerHTML = `
    <div class="card">
      <h3 class="card-h">Scoring weights <span class="wt-total mono" id="gpc-total">1.000</span></h3>
      <div id="gpc-sliders">
        ${metricKeys.map(k => `
          <div class="wt-row"><label>${ghaMetricLabel(k)}</label>
            <input type="range" min="0" max="1" step="0.01" value="${proposed.metricWeights[k]}" data-w="${k}"/>
            <span class="wt-val mono" data-wv="${k}">${proposed.metricWeights[k].toFixed(2)}</span></div>`).join('')}
      </div>
      <div class="wt-validate" id="gpc-validate"></div>
      <div class="wt-btns"><button class="btn btn-ghost btn-sm" id="gpc-normalise" type="button">Normalise to 1.0</button></div>

      <h3 class="card-h" style="margin-top:20px">Minimum performance threshold</h3>
      <div class="field" style="max-width:200px">
        <div class="input-wrap"><input type="number" id="gpc-threshold" min="0" max="100" value="${proposed.minimumThreshold}"/><span class="input-unit mono">/ 100</span></div>
      </div>

      <h3 class="card-h" style="margin-top:20px">GHO certification rules</h3>
      <div class="grid-2">
        <div class="field"><label for="gpc-gho-threshold">Annual (trailing 12mo) threshold</label>
          <div class="input-wrap"><input type="number" id="gpc-gho-threshold" min="0" max="100" value="${proposed.ghoAnnualThreshold}"/><span class="input-unit mono">/ 100</span></div>
        </div>
        <div class="field"><label for="gpc-gho-maxbelow">Max months below minimum</label>
          <div class="input-wrap"><input type="number" id="gpc-gho-maxbelow" min="0" max="12" value="${proposed.ghoMaxMonthsBelow}"/><span class="input-unit mono">months</span></div>
        </div>
      </div>
      <div class="field" style="max-width:200px">
        <label for="gpc-gho-validity">Certificate validity</label>
        <div class="input-wrap"><input type="number" id="gpc-gho-validity" min="1" max="60" value="${proposed.ghoValidityMonths}"/><span class="input-unit mono">months</span></div>
      </div>

      <div class="wt-actions">
        <button class="btn btn-primary btn-sm" id="gpc-save" type="button">Save new version &amp; recompute</button>
      </div>
    </div>

    <div class="card"><h3 class="card-h">Version history</h3>
      <div class="table-scroll"><table class="ver-tbl">
        <thead><tr><th>Version</th><th>Status</th><th>Author</th><th>Created</th><th>Note</th></tr></thead>
        <tbody>${getGhaPerfConfigVersions().slice().reverse().map(v => `
          <tr><td class="mono">${escapeHtml(v.id)}</td><td><span class="ver-status vs-${v.status.toLowerCase()}">${v.status}</span></td>
            <td>${escapeHtml(v.author)}</td><td class="mono">${fmtDate(v.createdAt)}</td><td class="ver-note">${escapeHtml(v.note)}</td></tr>`).join('')}
        </tbody></table></div>
    </div>`;

  function readTotal() { return metricKeys.reduce((a, k) => a + proposed.metricWeights[k], 0); }
  function paintTotal() {
    const total = readTotal();
    const t = el.querySelector('#gpc-total'); t.textContent = total.toFixed(3);
    const ok = Math.abs(total - 1) < 0.001;
    t.classList.toggle('bad', !ok); t.classList.toggle('good', ok);
    const val = el.querySelector('#gpc-validate');
    val.className = 'wt-validate ' + (ok ? 'ok' : 'bad');
    val.textContent = ok ? '✓ Weights sum to 1.0 — save enabled.' : `VALIDATION_FAILED · weights sum to ${total.toFixed(3)}, must equal 1.0`;
    el.querySelector('#gpc-save').disabled = !ok;
  }
  paintTotal();

  el.querySelector('#gpc-sliders').oninput = e => {
    const s = e.target.closest('[data-w]'); if (!s) return;
    const k = s.dataset.w; proposed.metricWeights[k] = Number(s.value);
    el.querySelector(`[data-wv="${k}"]`).textContent = proposed.metricWeights[k].toFixed(2);
    paintTotal();
  };
  el.querySelector('#gpc-normalise').onclick = () => {
    const s = readTotal() || 1;
    metricKeys.forEach(k => proposed.metricWeights[k] = +(proposed.metricWeights[k] / s).toFixed(3));
    metricKeys.forEach(k => {
      const sl = el.querySelector(`[data-w="${k}"]`); sl.value = proposed.metricWeights[k];
      el.querySelector(`[data-wv="${k}"]`).textContent = proposed.metricWeights[k].toFixed(2);
    });
    paintTotal();
  };
  el.querySelector('#gpc-threshold').oninput = e => { proposed.minimumThreshold = Number(e.target.value) || 0; };
  el.querySelector('#gpc-gho-threshold').oninput = e => { proposed.ghoAnnualThreshold = Number(e.target.value) || 0; };
  el.querySelector('#gpc-gho-maxbelow').oninput = e => { proposed.ghoMaxMonthsBelow = Number(e.target.value) || 0; };
  el.querySelector('#gpc-gho-validity').oninput = e => { proposed.ghoValidityMonths = Number(e.target.value) || 1; };

  el.querySelector('#gpc-save').onclick = () => {
    const total = readTotal();
    if (Math.abs(total - 1) >= 0.001) { showToast('VALIDATION_FAILED — weights must sum to 1.0', 'error'); return; }
    saveNewGhaPerfConfigVersion(proposed, 'Manual calibration update.');
    recomputeAllGhaPerformance();
    showToast('New performance config saved — scores recomputed', 'success');
    paintGhaManagement(document.querySelector('.module-view'));
  };
}

function paintEquipPerfConfig(el) {
  const active = getActiveEquipPerfConfig();
  const proposed = JSON.parse(JSON.stringify(active.params));
  const cats = ['POWERED', 'NON_POWERED', 'INFRASTRUCTURE'];
  const catLabels = { POWERED: 'Powered GSE', NON_POWERED: 'Non-Powered', INFRASTRUCTURE: 'Infrastructure' };

  el.innerHTML += `
    <div class="card" style="margin-top:20px">
      <h3 class="card-h">Equipment Performance Decay Configuration
        <span class="mono" style="font-size:11px;color:var(--text-mute);margin-left:8px">v${escapeHtml(active.id || 'default')}</span></h3>
      <p style="font-size:12px;color:var(--text-mute);margin-bottom:14px">Age-based performance scoring — per-category yearly decline, floor percentages, and adjustment bonuses.</p>

      <h3 class="card-h" style="margin-bottom:8px">Per-Category Decay Curves</h3>
      <div class="epc-cat-grid">
        ${cats.map(cat => {
          const c = proposed.perCategoryCurves[cat];
          return `<div class="epc-cat-card">
            <div class="epc-cat-title">${catLabels[cat]}</div>
            <div class="field" style="margin-bottom:8px"><label>Yearly decline %</label>
              <div class="input-wrap"><input type="number" min="0" max="30" step="0.5" value="${c.yearlyDeclinePercent}" data-epc-cat="${cat}" data-epc-field="yearlyDeclinePercent"/><span class="input-unit mono">%/yr</span></div></div>
            <div class="field"><label>Floor %</label>
              <div class="input-wrap"><input type="number" min="0" max="100" step="1" value="${c.floorPercent}" data-epc-cat="${cat}" data-epc-field="floorPercent"/><span class="input-unit mono">%</span></div></div>
          </div>`;
        }).join('')}
      </div>

      <h3 class="card-h" style="margin:16px 0 8px">Global Adjustments</h3>
      <div class="epc-global-grid">
        <div class="field"><label>Maintenance bonus (90-day window)</label>
          <div class="input-wrap"><input type="number" min="0" max="20" step="1" value="${proposed.maintenanceBonusPercent}" id="epc-maint-bonus"/><span class="input-unit mono">%</span></div></div>
        <div class="field"><label>Reactivation penalty</label>
          <div class="input-wrap"><input type="number" min="0" max="30" step="1" value="${proposed.reactivationPenaltyPercent}" id="epc-react-penalty"/><span class="input-unit mono">%</span></div></div>
      </div>

      <div class="wt-actions">
        <button class="btn btn-ghost btn-sm" id="epc-recompute" type="button">Recompute scores now</button>
        <button class="btn btn-primary btn-sm" id="epc-save" type="button">Save new version & recompute</button>
      </div>
    </div>

    <div class="card" style="margin-top:12px">
      <h3 class="card-h">Equipment Performance Config History</h3>
      <div class="table-scroll"><table class="ver-tbl">
        <thead><tr><th>Version</th><th>Status</th><th>Author</th><th>Created</th><th>Note</th></tr></thead>
        <tbody>${getEquipPerfConfigVersions().slice().reverse().map(v => `
          <tr><td class="mono">${escapeHtml(v.id)}</td><td><span class="ver-status vs-${v.status.toLowerCase()}">${v.status}</span></td>
            <td>${escapeHtml(v.author)}</td><td class="mono">${fmtDate(v.createdAt)}</td><td class="ver-note">${escapeHtml(v.note)}</td></tr>`).join('')}
        </tbody></table></div>
    </div>`;

  // Wire category field inputs
  el.querySelectorAll('[data-epc-cat]').forEach(inp => {
    inp.oninput = () => {
      const cat = inp.dataset.epcCat, field = inp.dataset.epcField;
      proposed.perCategoryCurves[cat][field] = Number(inp.value) || 0;
    };
  });
  // Wire global fields
  const mb = el.querySelector('#epc-maint-bonus');
  if (mb) mb.oninput = () => { proposed.maintenanceBonusPercent = Number(mb.value) || 0; };
  const rp = el.querySelector('#epc-react-penalty');
  if (rp) rp.oninput = () => { proposed.reactivationPenaltyPercent = Number(rp.value) || 0; };

  // Recompute button (no config change)
  el.querySelector('#epc-recompute').onclick = () => {
    const before = avgFleetPerfScore();
    recomputeAllEquipmentScores();
    const after = avgFleetPerfScore();
    showToast(`Scores recomputed — fleet average ${before}% → ${after}%`, 'success');
    if (currentModule === 'gha') paintGhaManagement(document.querySelector('.module-view'));
  };

  // Save new version
  el.querySelector('#epc-save').onclick = () => {
    const before = avgFleetPerfScore();
    saveNewEquipPerfConfigVersion(proposed, 'Manual equipment decay configuration update.');
    recomputeAllEquipmentScores();
    recomputeAllGhaPerformance();
    const after = avgFleetPerfScore();
    showToast(`Average fleet score changed from ${before}% to ${after}%`, 'success');
    paintGhaManagement(document.querySelector('.module-view'));
  };
}

/* ── add / edit GHA modal ── */
function openGhaModal(id) {
  const g = id ? getGha(id) : null;
  const modal = openModal(`
    <div class="modal-head"><div><h3>${g ? 'Edit GHA' : 'Add GHA'}</h3><p>${g ? escapeHtml(g.name) : 'Register a new ground handling agent'}</p></div>
      <button class="modal-x" data-x aria-label="Close"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6 L18 18 M18 6 L6 18"/></svg></button></div>
    <div class="field" data-field="gha-name"><label for="gha-f-name">Agent name</label><div class="input-wrap"><input type="text" id="gha-f-name" value="${g ? escapeHtml(g.name) : ''}" placeholder="e.g. Menzies-RAS" autocomplete="off"/></div><p class="field-err"></p></div>
    <div class="grid-2">
      <div class="field" data-field="gha-code"><label for="gha-f-code">Short code</label><div class="input-wrap"><input type="text" id="gha-f-code" value="${g ? escapeHtml(g.code) : ''}" placeholder="e.g. MNZ" autocomplete="off"/></div><p class="field-err"></p></div>
      <div class="field"><label for="gha-f-ownership">Ownership</label><div class="input-wrap"><select id="gha-f-ownership">
        <option value="PRIVATE" ${!g || g.ownership === 'PRIVATE' ? 'selected' : ''}>Private</option>
        <option value="AIRPORT_SUBSIDIARY" ${g && g.ownership === 'AIRPORT_SUBSIDIARY' ? 'selected' : ''}>Airport Subsidiary</option>
      </select></div></div>
    </div>
    <div class="field" data-field="gha-license"><label for="gha-f-license">Licence number</label><div class="input-wrap"><input type="text" id="gha-f-license" value="${g ? escapeHtml(g.licenseNumber) : ''}" placeholder="e.g. PCAA/GH/MUX/000" autocomplete="off"/></div><p class="field-err"></p></div>
    <div class="grid-2">
      <div class="field" data-field="gha-start"><label for="gha-f-start">Contract start</label><div class="input-wrap date-wrap">
        <svg class="date-ico" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
        <input type="date" id="gha-f-start" value="${g ? g.contractStart.slice(0, 10) : nowISO().slice(0, 10)}"/></div><p class="field-err"></p></div>
      <div class="field" data-field="gha-end"><label for="gha-f-end">Contract end</label><div class="input-wrap date-wrap">
        <svg class="date-ico" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
        <input type="date" id="gha-f-end" value="${g ? g.contractEnd.slice(0, 10) : addMinutesISO(nowISO(), 60 * 24 * 365).slice(0, 10)}"/></div><p class="field-err"></p></div>
    </div>
    <div class="grid-2">
      <div class="field"><label for="gha-f-contact-name">Contact name</label><div class="input-wrap"><input type="text" id="gha-f-contact-name" value="${g ? escapeHtml(g.contactName || '') : ''}" placeholder="Jane Doe" autocomplete="off"/></div></div>
      <div class="field"><label for="gha-f-contact-phone">Contact phone</label><div class="input-wrap"><input type="text" id="gha-f-contact-phone" value="${g ? escapeHtml(g.contactPhone || '') : ''}" placeholder="+92-…" autocomplete="off"/></div></div>
    </div>
    <div class="field" data-field="gha-contact"><label for="gha-f-contact-email">Contact email</label><div class="input-wrap"><input type="text" id="gha-f-contact-email" value="${g ? escapeHtml(g.contactEmail || '') : ''}" placeholder="ops@agent.com" autocomplete="off"/></div><p class="field-err"></p></div>
    <div class="field"><label for="gha-f-airline-input">Airlines served</label>
      <div class="input-wrap"><input type="text" id="gha-f-airline-input" placeholder="Type a code, press Enter (e.g. QR)" autocomplete="off"/></div>
      <div class="eq-type-chips" id="gha-f-airline-chips"></div>
    </div>
    <div class="modal-foot"><button class="btn btn-ghost" data-x>Cancel</button><button class="btn btn-primary" id="gha-save">${g ? 'Save changes' : 'Create GHA'}</button></div>`, true);

  modal.querySelectorAll('[data-x]').forEach(b => b.onclick = closeModal);

  let airlines = new Set((g && g.airlinesServed) || []);
  const chipsEl = modal.querySelector('#gha-f-airline-chips');
  function paintChips() { chipsEl.innerHTML = [...airlines].map(a => `<button type="button" class="eq-chip active" data-air="${escapeHtml(a)}">${escapeHtml(a)} ×</button>`).join(''); }
  paintChips();
  chipsEl.onclick = e => { const chip = e.target.closest('[data-air]'); if (!chip) return; airlines.delete(chip.dataset.air); paintChips(); };
  const airlineInput = modal.querySelector('#gha-f-airline-input');
  airlineInput.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      const v = airlineInput.value.trim().toUpperCase().replace(/,$/, '');
      if (v) { airlines.add(v); paintChips(); }
      airlineInput.value = '';
    }
  });

  modal.querySelector('#gha-save').onclick = () => {
    const name = modal.querySelector('#gha-f-name').value.trim();
    const code = modal.querySelector('#gha-f-code').value.trim().toUpperCase();
    const ownership = modal.querySelector('#gha-f-ownership').value;
    const license = modal.querySelector('#gha-f-license').value.trim();
    const startVal = modal.querySelector('#gha-f-start').value;
    const endVal = modal.querySelector('#gha-f-end').value;
    const contactName = modal.querySelector('#gha-f-contact-name').value.trim();
    const contactPhone = modal.querySelector('#gha-f-contact-phone').value.trim();
    const contactEmail = modal.querySelector('#gha-f-contact-email').value.trim();

    modal.querySelectorAll('.field').forEach(f => f.classList.remove('bad'));
    let bad = false;
    const fail = (sel, msg) => { const f = modal.querySelector(sel); f.classList.add('bad'); const err = f.querySelector('.field-err'); if (err) err.textContent = msg; bad = true; };

    if (name.length < 2) fail('[data-field="gha-name"]', "Enter the agent's full name.");
    if (!code) fail('[data-field="gha-code"]', 'Enter a short code.');
    else { const dup = getGhas().find(x => x.code.toLowerCase() === code.toLowerCase() && x.id !== id); if (dup) fail('[data-field="gha-code"]', 'That code is already in use.'); }
    if (!license) fail('[data-field="gha-license"]', 'Licence number is required.');
    if (!startVal) fail('[data-field="gha-start"]', 'Contract start date is required.');
    if (!endVal) fail('[data-field="gha-end"]', 'Contract end date is required.');
    else if (startVal && new Date(endVal) <= new Date(startVal)) fail('[data-field="gha-end"]', 'Contract end must be after the start date.');
    if (!contactName && !contactPhone && !contactEmail) fail('[data-field="gha-contact"]', 'Provide at least one contact field (name, phone or email).');
    if (bad) return;

    const list = getGhas();
    const nowIso = nowISO();
    let savedId = id;
    if (g) {
      Object.assign(list.find(x => x.id === id), {
        name, code, ownership, licenseNumber: license,
        contractStart: new Date(startVal).toISOString(), contractEnd: new Date(endVal).toISOString(),
        contactName, contactPhone, contactEmail, airlinesServed: [...airlines], updatedAt: nowIso
      });
      saveGhas(list);
      logActivity({ action: 'edited GHA', target: name, category: 'gha', severity: 'info' });
      showToast(`${name} updated`, 'success');
    } else {
      const newG = {
        id: uid('gha'), name, code, ownership, licenseNumber: license,
        contactName, contactPhone, contactEmail,
        contractStart: new Date(startVal).toISOString(), contractEnd: new Date(endVal).toISOString(),
        airlinesServed: [...airlines], status: 'ACTIVE', createdAt: nowIso, updatedAt: nowIso
      };
      list.push(newG); saveGhas(list); savedId = newG.id;
      logActivity({ action: 'created GHA', target: name, category: 'gha', severity: 'success' });
      showToast(`${name} created`, 'success');
    }
    closeModal();
    if (currentModule === 'gha') paintGhaManagement(document.querySelector('.module-view'));
    if (currentModule === 'equipment') renderEquipmentBody();
    if (ghaDetailOpenId === savedId) openGhaDetail(savedId);
  };
}

/* ── status changes (suspend / reactivate / terminate) ── */
function updateGha(id, changes) {
  const list = getGhas(); const g = list.find(x => x.id === id);
  if (!g) return null; Object.assign(g, changes, { updatedAt: nowISO() }); saveGhas(list); return g;
}

function openGhaMenu(id, anchor) {
  const g = getGha(id); if (!g) return;
  const items = [
    { key: 'view', label: 'View details', onClick: () => openGhaDetail(id) },
    { key: 'edit', label: 'Edit GHA', onClick: () => openGhaModal(id) },
    { sep: true }
  ];
  if (g.status !== 'ACTIVE') items.push({ key: 'reactivate', label: 'Reactivate', onClick: () => ghaStatusChange(id, 'ACTIVE') });
  if (g.status !== 'SUSPENDED') items.push({ key: 'suspend', label: 'Suspend', onClick: () => ghaStatusChange(id, 'SUSPENDED') });
  if (g.status !== 'TERMINATED') items.push({ key: 'terminate', label: 'Terminate', danger: true, onClick: () => ghaStatusChange(id, 'TERMINATED') });
  openKebab(anchor, items);
}

async function ghaStatusChange(id, newStatus) {
  const g = getGha(id); if (!g) return;
  const copy = {
    SUSPENDED: { title: 'Suspend GHA', verb: 'Suspend', past: 'suspended', danger: true, note: "Its assigned equipment stays assigned unless reassigned separately." },
    TERMINATED: { title: 'Terminate GHA', verb: 'Terminate', past: 'terminated', danger: true, note: "Its assigned equipment stays assigned unless reassigned separately — use this agent's detail view to move it." },
    ACTIVE: { title: 'Reactivate GHA', verb: 'Reactivate', past: 'reactivated', danger: false, note: '' }
  }[newStatus];
  const ok = await confirmDialog({ title: copy.title, danger: copy.danger, confirmLabel: copy.verb, message: `${copy.verb} ${g.name}? ${copy.note}` });
  if (!ok) return;
  updateGha(id, { status: newStatus });
  logActivity({ action: `${copy.past} GHA`, target: g.name, category: 'gha', severity: copy.danger ? 'warn' : 'success' });
  showToast(`${g.name} ${copy.past}`, copy.danger ? 'notice' : 'success');
  if (currentModule === 'gha') paintGhaManagement(document.querySelector('.module-view'));
  if (ghaDetailOpenId === id) openGhaDetail(id);
}

/* ── GHA detail (overview · assigned equipment · reassign · contract) —
   a centred modal, not a side drawer; ghaDetailOpenId tracks which GHA (if
   any) currently has its detail modal open, so edit/status-change actions
   know whether to refresh it in place afterward. ── */
let ghaDetailTab = 'overview';
let ghaDetailOpenId = null;

function ghaOverviewTabHtml(g) {
  const { total } = ghaFleetBreakdown(g.id);
  const contract = ghaContractState(g);
  const perfConfig = getActiveGhaPerfConfig();
  const perfRec = getGhaPerfRecord(g.id, currentPeriod());
  const airlines = g.airlinesServed && g.airlinesServed.length ? g.airlinesServed : [];

  return `<div class="dw-section" style="margin-top:0">
      <div class="dw-snapshot">
        <div class="dw-snap-tile center">
          ${perfRec ? perfRingHtml(perfRec.overallScore, perfConfig.params.minimumThreshold, 44, 13) : `<span class="dw-snap-val" style="color:var(--text-mute)">—</span>`}
          <span class="dw-snap-lbl">Performance</span>
        </div>
        <div class="dw-snap-tile center">
          <span class="dw-snap-val">${total}</span>
          <span class="dw-snap-lbl">Equipment units</span>
        </div>
        <div class="dw-snap-tile center">
          <span class="dw-snap-val" style="font-size:14px">${ghaContractFlagHtml(g)}</span>
          <span class="dw-snap-lbl">Contract${contract.state === 'ok' ? '' : ' — ' + (contract.state === 'expired' ? 'expired' : 'expiring soon')}</span>
        </div>
        <div class="dw-snap-tile center">
          ${ghoBadgeHtml(g.id)}
          <span class="dw-snap-lbl">GHO certification</span>
        </div>
      </div>
    </div>

    <div class="dw-section"><h4>Contact</h4>
      <div class="dw-grid">
        <div class="dw-item"><div class="k">Name</div><div class="v">${escapeHtml(g.contactName || '—')}</div></div>
        <div class="dw-item"><div class="k">Phone</div><div class="v mono">${escapeHtml(g.contactPhone || '—')}</div></div>
        <div class="dw-item" style="grid-column:1 / -1"><div class="k">Email</div><div class="v mono">${escapeHtml(g.contactEmail || '—')}</div></div>
      </div>
    </div>

    <div class="dw-section"><h4>Airlines served</h4>
      ${airlines.length ? `<div class="dw-perms">${airlines.map(a => `<span class="dw-perm">${escapeHtml(a)}</span>`).join('')}</div>` : `<p class="rs-none">No scheduled airlines.</p>`}
    </div>

    <button class="btn btn-ghost btn-sm" id="gha-dw-edit" type="button" style="margin-top:20px;width:100%">Edit GHA</button>`;
}
function ghaEquipmentTabHtml(g, units, cats, total, otherGhas, color) {
  return `<div class="dw-section" style="margin-top:0"><h4>Assigned equipment (${total})</h4>
      ${total ? `
      <div class="gr-cats" style="margin-bottom:12px">
        ${[['POWERED', '⚡ Powered'], ['NON_POWERED', '📦 Non-powered'], ['INFRASTRUCTURE', '🏗 Infrastructure']].filter(([k]) => cats[k]).map(([k, label]) => {
      const pct = total ? Math.round(cats[k] / total * 100) : 0;
      return `<div class="grc-row"><span class="grc-lbl">${label}</span><span class="grc-bar"><span style="width:${pct}%;background:${color}"></span></span><span class="mono grc-val">${cats[k]}</span></div>`;
    }).join('')}
      </div>
      <div class="bulkbar" id="gha-reassign-bar" hidden>
        <span class="bulk-count mono"><strong id="gha-reassign-n">0</strong> selected</span>
        <div class="bulk-actions" style="align-items:center;gap:8px">
          <select id="gha-reassign-target" class="filter-select" style="min-width:150px">
            <option value="">— Unassigned —</option>
            ${otherGhas.map(og => `<option value="${og.id}">${escapeHtml(og.name)}</option>`).join('')}
          </select>
          <button class="btn btn-primary btn-xs" id="gha-reassign-go" type="button">Reassign</button>
          <button class="btn btn-ghost btn-xs" id="gha-reassign-clear" type="button">Clear</button>
        </div>
      </div>
      <div class="table-scroll">
        <table class="eq-tbl">
          <thead><tr><th class="th-check"><input type="checkbox" id="gha-check-all" aria-label="Select all"/></th><th>Type</th><th>Ownership</th><th>Serial</th><th>Status</th><th>Last service</th></tr></thead>
          <tbody id="gha-unit-body">
            ${units.map(u => {
      const stCls = { SERVICEABLE: 'ok', UNSERVICEABLE: 'bad', MAINTENANCE: 'maint', RETIRED: 'ret' }[u.status];
      return `<tr data-unit="${u.id}">
                <td class="cell-check"><input type="checkbox" data-check="${u.id}" aria-label="Select ${escapeHtml(u.serial)}"/></td>
                <td>${escapeHtml(u.type)}</td><td>${ownBadge(u.ownership)}</td><td class="mono">${escapeHtml(u.serial)}</td>
                <td><span class="eq-status es-${stCls}">${u.status}</span></td>
                <td class="mono">${fmtDate(u.lastService)}</td>
              </tr>`;
    }).join('')}
          </tbody>
        </table>
      </div>` : `<p class="rs-none">No equipment currently assigned to this agent.</p>`}
    </div>`;
}
function ghaContractTabHtml(g, contract) {
  return `<div class="dw-section" style="margin-top:0">
      <div class="dw-grid">
        <div class="dw-item"><div class="k">Start</div><div class="v mono">${fmtDate(g.contractStart)}</div></div>
        <div class="dw-item"><div class="k">End</div><div class="v mono">${fmtDate(g.contractEnd)}</div></div>
      </div>
      <div class="form-msg ${contract.state === 'expired' ? 'error' : contract.state === 'expiring' ? 'notice' : 'info'}" style="margin-top:12px">
        ${contract.state === 'expired' ? `⚠ Contract expired ${Math.abs(contract.daysLeft)} day${Math.abs(contract.daysLeft) === 1 ? '' : 's'} ago — renewal required.`
      : contract.state === 'expiring' ? `⚠ Contract expires in ${contract.daysLeft} day${contract.daysLeft === 1 ? '' : 's'} — within the 90-day renewal window.`
        : `✓ Contract in good standing — ${contract.daysLeft} days remaining.`}
      </div>
    </div>`;
}
function ghaTrendChartSVG(records, threshold) {
  if (records.length < 2) return '<p class="rs-none">Not enough history.</p>';
  const W = 300, H = 170, padL = 26, padB = 22, padT = 10, padR = 8;
  const x = i => padL + (i / (records.length - 1)) * (W - padL - padR);
  const y = v => padT + (1 - v / 100) * (H - padT - padB);
  const pts = records.map((r, i) => [x(i), y(r.overallScore)]);
  const thresholdY = y(threshold);
  return `<svg viewBox="0 0 ${W} ${H}" width="100%">
    ${[0, 50, 100].map(v => `<line x1="${padL}" y1="${y(v).toFixed(1)}" x2="${W - padR}" y2="${y(v).toFixed(1)}" class="tl-grid"/><text x="2" y="${(y(v) + 3).toFixed(1)}" class="an-axis mono">${v}</text>`).join('')}
    <line x1="${padL}" y1="${thresholdY.toFixed(1)}" x2="${W - padR}" y2="${thresholdY.toFixed(1)}" class="perf-threshold-line"/>
    <text x="${(W - padR).toFixed(1)}" y="${(thresholdY - 4).toFixed(1)}" text-anchor="end" class="an-axis mono" style="fill:var(--amber)">min ${threshold}</text>
    <path d="${polyPath(pts)}" class="tl-line"/>
    ${pts.map((p, i) => `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="3.2" fill="${records[i].belowMinimum ? 'var(--red)' : 'var(--primary)'}" class="tl-pt"/>`).join('')}
    ${records.map((r, i) => `<text x="${x(i).toFixed(1)}" y="${H - 6}" text-anchor="middle" class="an-axis mono">${escapeHtml(periodLabel(r.period).slice(0, 3))}</text>`).join('')}
  </svg>`;
}
function ghaPerformanceTabHtml(g) {
  const config = getActiveGhaPerfConfig();
  const period = currentPeriod();
  const rec = getGhaPerfRecord(g.id, period);
  if (!rec) return `<div class="dw-section" style="margin-top:0"><p class="rs-none">No performance data computed yet for this period.</p></div>`;
  const threshold = config.params.minimumThreshold;
  const weights = config.params.metricWeights;
  const metricOrder = ['deployment', 'serviceability', 'suitability', 'fuelEfficiency'];
  const weakest = ghaWeakestMetric(rec.metrics);

  const bars = metricOrder.map(k => {
    const score = rec.metrics[k];
    const isWeak = k === weakest.key && rec.belowMinimum;
    const tier = ghaScoreTier(score, threshold);
    const color = tier === 'green' ? 'var(--green)' : tier === 'amber' ? 'var(--amber)' : 'var(--red)';
    return `<div class="contrib-row ${isWeak ? 'dominant' : ''}">
      <div class="cr-top"><span class="cr-name">${ghaMetricLabel(k)}${isWeak ? ' <span class="cr-tag">WEAKEST</span>' : ''}
        <span class="mono" style="font-size:10px;color:var(--text-mute);margin-left:6px">weight ${Math.round(weights[k] * 100)}%</span></span>
        <span class="cr-share mono">${score}%</span></div>
      <div class="cr-bar"><span class="cr-fill" style="width:${score}%;--accent:${color}"></span></div>
      <div class="cr-meta mono">${escapeHtml(rec.detail[k])}</div>
    </div>`;
  }).join('');

  const trendData = last6Periods(period).map(p => getGhaPerfRecord(g.id, p)).filter(Boolean);

  return `<div class="dw-section" style="margin-top:0;text-align:center">
      <div style="display:flex;justify-content:center">${perfRingHtml(rec.overallScore, threshold, 108, 30)}</div>
      <p class="mono" style="margin-top:8px;font-size:12px;color:var(--text-mute)">Overall score · ${escapeHtml(periodLabel(period))}</p>
      ${rec.belowMinimum ? `<div class="form-msg error" style="margin-top:10px;text-align:left">⚠ Below the ${threshold} minimum — driven by low ${weakest.label.toLowerCase()} (${weakest.score}%).</div>` : ''}
    </div>
    <div class="dw-section"><h4>Sub-metric breakdown</h4>
      <div class="contrib-rows">${bars}</div>
    </div>
    <div class="dw-section"><h4>6-month trend</h4>
      <div class="an-chart">${ghaTrendChartSVG(trendData, threshold)}</div>
    </div>`;
}

function ghaCertificationTabHtml(g) {
  const config = getActiveGhaPerfConfig();
  const evalResult = evaluateGhoEligibility(g.id);
  const current = currentGhoCertificate(g.id);
  const history = ghoCertificateHistory(g.id);
  const statusInfo = ghoStatusInfo(ghaCertStatus(g.id));

  return `<div class="dw-section" style="margin-top:0">
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px">
        <span class="gho-badge ${statusInfo.cls}" style="font-size:13px;padding:6px 12px">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${GHO_BADGE_ICON[statusInfo.cls]}</svg>
          ${statusInfo.label}
        </span>
        ${current ? `<button class="btn btn-primary btn-sm" id="gha-view-cert" type="button">View Certificate</button>` : ''}
      </div>
      ${current ? `<p class="mono" style="font-size:11.5px;color:var(--text-mute);margin-top:8px">${escapeHtml(current.certificateNumber)} · valid until ${fmtDate(current.expiresAt)}</p>` : ''}
    </div>

    <div class="dw-section"><h4>Eligibility breakdown</h4>
      <div class="dw-grid">
        <div class="dw-item"><div class="k">Trailing average</div><div class="v mono">${evalResult.trailingAverageScore}% <span style="color:var(--text-mute)">/ ${config.params.ghoAnnualThreshold}% required</span></div></div>
        <div class="dw-item"><div class="k">Months below minimum</div><div class="v mono">${evalResult.monthsBelow} <span style="color:var(--text-mute)">/ ${config.params.ghoMaxMonthsBelow} allowed</span></div></div>
        <div class="dw-item"><div class="k">Window</div><div class="v mono">${evalResult.monthsAvailable} month${evalResult.monthsAvailable === 1 ? '' : 's'} available${evalResult.monthsAvailable < 12 ? ' (partial)' : ''}</div></div>
        <div class="dw-item"><div class="k">Eligible now</div><div class="v">${evalResult.eligible ? '<span class="eq-status es-ok">YES</span>' : '<span class="eq-status es-bad">NO</span>'}</div></div>
      </div>
      ${!evalResult.eligible && evalResult.reasonIneligible ? `<div class="form-msg error" style="margin-top:10px">⚠ ${escapeHtml(evalResult.reasonIneligible)}</div>` : ''}
      <div class="dw-perms" style="margin-top:12px">
        <span class="dw-perm">Deployment ${evalResult.basisMetrics.deployment}%</span>
        <span class="dw-perm">Serviceability ${evalResult.basisMetrics.serviceability}%</span>
        <span class="dw-perm">Suitability ${evalResult.basisMetrics.suitability}%</span>
        <span class="dw-perm">Fuel Eff. ${evalResult.basisMetrics.fuelEfficiency}%</span>
      </div>
    </div>

    <div class="dw-section"><h4>Certificate history</h4>
      ${history.length ? `<div id="gha-cert-history">${history.map(c => {
    const info = ghoStatusInfo(c.status);
    return `<div class="cert-hist-row" data-cert-id="${c.id}">
          <span class="gho-badge ${info.cls}"><svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${GHO_BADGE_ICON[info.cls]}</svg>${info.label}</span>
          <span class="mono" style="font-size:12px">${escapeHtml(c.certificateNumber)}</span>
          <span class="mono" style="font-size:11px;color:var(--text-mute)">${fmtDate(c.issuedAt)} → ${fmtDate(c.expiresAt)}</span>
        </div>`;
  }).join('')}</div>` : '<p class="rs-none">No certificates issued yet.</p>'}
    </div>`;
}

/* opens the shell (avatar/name/badges/tabs) exactly once — tab switches
   only repaint #gha-detail-content below, so the modal never rebuilds (and
   never replays its pop-in animation) just from clicking between tabs;
   only actions that actually change data (reassign, edit, status change)
   go through a full reopen. */
function openGhaDetail(id) {
  const g = getGha(id); if (!g) return;
  const color = ghaColorFor(id);

  ghaDetailOpenId = id;
  const modal = openModal(`
    <div class="modal-head">
      <div style="display:flex;align-items:center;gap:12px">
        <div class="drawer-avatar" style="width:40px;height:40px;font-size:14px;margin-bottom:0;background:color-mix(in srgb, ${color} 16%, transparent);color:${color}">${escapeHtml(g.code.slice(0, 3))}</div>
        <div><h3>${escapeHtml(g.name)}</h3><p class="mono">${escapeHtml(g.licenseNumber)}</p></div>
      </div>
      <button class="modal-x" data-x aria-label="Close"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6 L18 18 M18 6 L6 18"/></svg></button>
    </div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin:-8px 0 16px">${ghaStatusBadge(g.status)}${ghaOwnershipBadge(g.ownership)}</div>

    <div class="gse-cat-tabs" id="gha-dw-tabs">
      <button type="button" class="gct-tab ${ghaDetailTab === 'overview' ? 'active' : ''}" data-ghatab="overview">Overview</button>
      <button type="button" class="gct-tab ${ghaDetailTab === 'equipment' ? 'active' : ''}" data-ghatab="equipment">Equipment (${ghaFleetBreakdown(id).total})</button>
      <button type="button" class="gct-tab ${ghaDetailTab === 'performance' ? 'active' : ''}" data-ghatab="performance">Performance</button>
      <button type="button" class="gct-tab ${ghaDetailTab === 'certification' ? 'active' : ''}" data-ghatab="certification">Certification</button>
      <button type="button" class="gct-tab ${ghaDetailTab === 'contract' ? 'active' : ''}" data-ghatab="contract">Contract</button>
    </div>
    <div id="gha-detail-content"></div>`, true);
  modal.classList.add('gha-detail-modal');

  const closeGhaDetail = () => { ghaDetailOpenId = null; closeModal(); };
  const host = document.getElementById('modal-host');
  host.onclick = e => { if (e.target === host) closeGhaDetail(); };
  modal.querySelectorAll('[data-x]').forEach(b => b.onclick = closeGhaDetail);
  modal.querySelector('#gha-dw-tabs').onclick = e => {
    const b = e.target.closest('[data-ghatab]'); if (!b || b.dataset.ghatab === ghaDetailTab) return;
    ghaDetailTab = b.dataset.ghatab;
    modal.querySelectorAll('[data-ghatab]').forEach(x => x.classList.toggle('active', x === b));
    paintGhaDetailTab(g, modal);
  };

  paintGhaDetailTab(g, modal);
}

/* repaints just #gha-detail-content for the active tab and wires that
   tab's own controls — called on open and on every tab switch, never
   touches the modal shell itself. */
function paintGhaDetailTab(g, modal) {
  const id = g.id;
  ghaReassignSelection = new Set();
  const { units, cats, total } = ghaFleetBreakdown(id);
  const otherGhas = getGhas().filter(x => x.id !== id);
  const contract = ghaContractState(g);
  const color = ghaColorFor(id);

  const tabHtml = ghaDetailTab === 'equipment' ? ghaEquipmentTabHtml(g, units, cats, total, otherGhas, color)
    : ghaDetailTab === 'performance' ? ghaPerformanceTabHtml(g)
      : ghaDetailTab === 'certification' ? ghaCertificationTabHtml(g)
        : ghaDetailTab === 'contract' ? ghaContractTabHtml(g, contract)
          : ghaOverviewTabHtml(g);
  modal.querySelector('#gha-detail-content').innerHTML = tabHtml;

  if (ghaDetailTab === 'overview') { modal.querySelector('#gha-dw-edit').onclick = () => openGhaModal(id); animatePerfRings(modal); }
  if (ghaDetailTab === 'performance') animatePerfRings(modal);
  if (ghaDetailTab === 'certification') {
    const viewBtn = modal.querySelector('#gha-view-cert');
    const current = currentGhoCertificate(id);
    if (viewBtn && current) viewBtn.onclick = () => openCertificateView(current.id, id);
    const histEl = modal.querySelector('#gha-cert-history');
    if (histEl) histEl.onclick = e => {
      const row = e.target.closest('[data-cert-id]'); if (row) openCertificateView(row.dataset.certId, id);
    };
  }

  if (ghaDetailTab === 'equipment' && total) {
    const tbody = modal.querySelector('#gha-unit-body');
    const checkAll = modal.querySelector('#gha-check-all');
    const bar = modal.querySelector('#gha-reassign-bar');
    const nEl = modal.querySelector('#gha-reassign-n');
    function syncBar() {
      bar.hidden = ghaReassignSelection.size === 0;
      nEl.textContent = String(ghaReassignSelection.size);
      checkAll.checked = units.length > 0 && units.every(u => ghaReassignSelection.has(u.id));
    }
    tbody.onclick = e => {
      const check = e.target.closest('[data-check]'); if (!check) return;
      if (check.checked) ghaReassignSelection.add(check.dataset.check); else ghaReassignSelection.delete(check.dataset.check);
      syncBar();
    };
    checkAll.onchange = e => {
      tbody.querySelectorAll('[data-check]').forEach(c => { c.checked = e.target.checked; if (e.target.checked) ghaReassignSelection.add(c.dataset.check); else ghaReassignSelection.delete(c.dataset.check); });
      syncBar();
    };
    modal.querySelector('#gha-reassign-clear').onclick = () => {
      ghaReassignSelection.clear();
      tbody.querySelectorAll('[data-check]').forEach(c => c.checked = false);
      syncBar();
    };
    modal.querySelector('#gha-reassign-go').onclick = () => {
      const targetId = modal.querySelector('#gha-reassign-target').value || null;
      const targetGha = targetId ? getGha(targetId) : null;
      const targetName = targetGha ? targetGha.name : 'Unassigned';
      const ids = [...ghaReassignSelection];
      if (!ids.length) return;
      const fleet = getGse();
      ids.forEach(unitId => { const u = fleet.find(x => x.id === unitId); if (u) u.ghaId = targetId; });
      saveGse(fleet);
      logActivity({ action: `reassigned ${ids.length} unit(s) to ${targetName}`, target: g.name, category: 'gha', severity: 'info' });
      showToast(`${ids.length} unit(s) reassigned to ${targetName}`, 'success');
      if (currentModule === 'equipment') renderEquipmentBody();
      if (currentModule === 'gse') showModule('gse');
      if (currentModule === 'gha') paintGhaManagement(document.querySelector('.module-view'));
      openGhaDetail(id);
    };
  }
}

/* ═══ weight-version write helpers (append-only) ═══════════ */
function saveNewWeightVersion(params, note, fromRecalib) {
  const versions = getWeightVersions();
  versions.forEach(v => { if (v.status === 'ACTIVE') v.status = 'SUPERSEDED'; });
  const nv = {
    id: 'wv-' + uid('v').slice(-6), createdAt: nowISO(), author: currentActor(),
    note: note || 'Manual calibration update.', status: 'ACTIVE', params: JSON.parse(JSON.stringify(params))
  };
  versions.push(nv); saveWeightVersions(versions);
  logActivity({ action: 'created weight version' + (fromRecalib ? ' (recalibration)' : ''), target: nv.id, category: 'weights', severity: 'warn' });
  return nv;
}
function activateWeightVersion(id) {
  const versions = getWeightVersions();
  const target = versions.find(v => v.id === id); if (!target) return;
  versions.forEach(v => { v.status = v.id === id ? 'ACTIVE' : (v.status === 'ACTIVE' ? 'SUPERSEDED' : v.status); });
  /* ensure exactly one active */
  versions.forEach(v => { if (v.id !== id && v.status === 'ACTIVE') v.status = 'SUPERSEDED'; });
  saveWeightVersions(versions);
  logActivity({ action: 'activated weight version', target: id, category: 'weights', severity: 'warn' });
}

/* transient compute with arbitrary params (no persistence) */
function computeWithParams(flight, params) {
  const ts = flight.calculation ? flight.calculation.calculatedAt : nowISO();
  const r = ENGINE.run(flight.rawInputs, params, flight.flightNumber, ts);
  return {
    bufferMinutes: r.buffer, p10: r.p10, p50: r.p50, p90: r.p90, riskLevel: r.riskLevel,
    dominantVariable: ENGINE.VAR_NAMES[r.dominant]
  };
}

/* T9 monotonicity self-check — buffer must never decrease as any
   single variable rises with the others held fixed. */
function monotonicityCheck(params) {
  const holds = [0.25, 0.75];
  const rises = [0.0, 0.2, 0.4, 0.6, 0.8, 1.0];
  const MONO_ITERS = 240;   // reduced draws keep the check well under a second
  let tested = 0; const violations = [];
  const p50For = v => {
    const raw = {
      heatIndexC: 28 + v[0] * 27, gseAvailable: Math.round((1 - v[1]) * 1000), gseTotal: 1000,
      mtbfFailureProb: v[2], loadFactorPercent: v[3] * 100, prmCount: v[4] * params.stationPrmP95, passengerTotal: 1e6
    };
    return ENGINE.run(raw, params, 'MONO', 'fixed-seed', MONO_ITERS).p50;
  };
  for (let k = 0; k < 5; k++) {
    /* iterate the four held variables over the grid */
    for (const a of holds) for (const b of holds) for (const c of holds) for (const d of holds) {
      const base = [a, b, c, d]; let prev = -Infinity;
      for (const r of rises) {
        const v = [0, 0, 0, 0, 0]; let bi = 0;
        for (let i = 0; i < 5; i++) v[i] = (i === k) ? r : base[bi++];
        const buf = p50For(v);
        tested++;
        if (buf < prev - 1e-9) violations.push({ variable: ENGINE.VAR_NAMES[k], at: r, drop: +(prev - buf).toFixed(3) });
        prev = buf;
      }
    }
  }
  return { pass: violations.length === 0, tested, violations };
}

/* ═══ S8 — WEIGHTS & THRESHOLDS (key: weights) ══════════════ */
function renderWeights(el) {
  const active = getActiveWeightVersion();
  const proposed = JSON.parse(JSON.stringify(active.params));
  const flights = getFlights();
  let previewFlightId = flights.length ? flights[0].id : null;

  el.innerHTML = `
    <div class="mod-wide">
      <div class="mod-head"><div><h1 class="mod-title">Weights &amp; Thresholds</h1>
        <p class="mod-sub">Calibration · append-only versioning · active <span class="mono">${escapeHtml(active.id)}</span></p></div></div>

      <div class="weights-grid">
        <!-- LEFT COLUMN: WEIGHTS, SIGMA & ACTIONS -->
        <section class="card">
          <h3 class="card-h">Variable weights <span class="wt-total mono" id="wt-total">1.000</span></h3>
          <div id="weight-sliders">
            ${ENGINE.VAR_NAMES.map((name, i) => `
              <div class="wt-row"><label>${escapeHtml(name)}</label>
                <input type="range" min="0" max="1" step="0.01" value="${proposed.weights[i]}" data-w="${i}"/>
                <span class="wt-val mono" data-wv="${i}">${proposed.weights[i].toFixed(2)}</span></div>`).join('')}
          </div>
          <div class="wt-validate" id="wt-validate"></div>
          <div class="wt-btns"><button class="btn btn-ghost btn-sm" id="wt-normalise" type="button">Normalise to 1.0</button></div>

          <h3 class="card-h" style="margin-top:20px">Sigma (per-variable σ)</h3>
          <div class="param-grid">
            ${ENGINE.VAR_NAMES.map((name, i) => `
              <div class="pg-field"><label>${escapeHtml(name)}</label><input type="text" data-sig="${i}" value="${proposed.sigma[i]}"/></div>`).join('')}
            <div class="pg-field"><label>Residual Noise (σ)</label><input type="text" data-sig="5" value="${proposed.sigma[5] || 0.05}"/></div>
          </div>

          <div class="wt-info-card">
            <span class="wt-info-tag mono">T9 ENFORCED</span>
            <span class="wt-info-txt">Monotonicity constraints prevent buffer decay when single risk variables escalate.</span>
          </div>

          <div class="wt-actions">
            <button class="btn btn-ghost btn-sm" id="wt-mono" type="button">Run monotonicity check (T9)</button>
            <button class="btn btn-primary btn-sm" id="wt-save" type="button">Save new version</button>
          </div>
          <div class="mono-result" id="mono-result" hidden></div>
        </section>

        <!-- RIGHT COLUMN: LIVE PREVIEW & THRESHOLDS -->
        <section class="card">
          <h3 class="card-h">Live preview</h3>
          <div class="field"><label for="wt-flight">Preview flight</label><div class="input-wrap">
            <select id="wt-flight">${flights.map(f => `<option value="${f.id}">${escapeHtml(f.flightNumber)} · ${f.calculation.riskLevel}</option>`).join('')}</select></div></div>
          <div class="preview-cmp" id="preview-cmp"></div>

          <h3 class="card-h" style="margin-top:22px">Buffer &amp; risk thresholds</h3>
          <div class="param-grid">
            <div class="pg-field"><label>Base buffer (min)</label><input type="text" data-p="baseBuffer" value="${proposed.baseBuffer}"/></div>
            <div class="pg-field"><label>Max additional (min)</label><input type="text" data-p="maxAdditional" value="${proposed.maxAdditional}"/></div>
            <div class="pg-field"><label>Green p90 limit</label><input type="text" data-th="green_p90" value="${proposed.thresholds.green_p90}"/></div>
            <div class="pg-field"><label>Green spread limit</label><input type="text" data-th="green_spread" value="${proposed.thresholds.green_spread}"/></div>
            <div class="pg-field"><label>Amber p90 limit</label><input type="text" data-th="amber_p90" value="${proposed.thresholds.amber_p90}"/></div>
            <div class="pg-field"><label>Amber spread limit</label><input type="text" data-th="amber_spread" value="${proposed.thresholds.amber_spread}"/></div>
            <div class="pg-field"><label>Station PRM P95</label><input type="text" data-p="stationPrmP95" value="${proposed.stationPrmP95}"/></div>
            <div class="pg-field"><label>Safety Factor Margin</label><input type="text" data-p="safetyFactor" value="${proposed.safetyFactor || 1.00}"/></div>
          </div>
        </section>
      </div>

      <section class="card"><h3 class="card-h">Version history</h3>
        <div class="table-scroll"><table class="ver-tbl">
          <thead><tr><th>Version</th><th>Status</th><th>Author</th><th>Created</th><th>Note</th><th></th></tr></thead>
          <tbody id="ver-body"></tbody></table></div>
        <div class="ver-diff-hint mono">Select two versions to diff.</div>
      </section>
    </div>`;

  /* ── state sync ── */
  function readTotal() { return proposed.weights.reduce((a, b) => a + b, 0); }
  function paintTotal() {
    const total = readTotal();
    const t = el.querySelector('#wt-total'); t.textContent = total.toFixed(3);
    const ok = Math.abs(total - 1) < 0.001;
    t.classList.toggle('bad', !ok); t.classList.toggle('good', ok);
    const val = el.querySelector('#wt-validate');
    val.className = 'wt-validate ' + (ok ? 'ok' : 'bad');
    val.textContent = ok ? '✓ Weights sum to 1.0 — save enabled.' : `VALIDATION_FAILED · weights sum to ${total.toFixed(3)}, must equal 1.0`;
    el.querySelector('#wt-save').disabled = !ok;
  }
  function paintPreview() {
    const f = getFlight(el.querySelector('#wt-flight').value); if (!f) return;
    const cur = computeWithParams(f, active.params);
    const prop = computeWithParams(f, proposed);
    const cell = (a, b, unit) => `<td class="mono">${a}${unit || ''}</td><td class="mono ${a !== b ? 'changed' : ''}">${b}${unit || ''}</td>`;
    el.querySelector('#preview-cmp').innerHTML = `
      <table class="cmp-tbl"><thead><tr><th>Metric</th><th>Active</th><th>Proposed</th></tr></thead><tbody>
        <tr><td>Buffer</td>${cell(cur.bufferMinutes, prop.bufferMinutes, ' min')}</tr>
        <tr><td>P10</td>${cell(Math.round(cur.p10), Math.round(prop.p10), '')}</tr>
        <tr><td>P50</td>${cell(Math.round(cur.p50), Math.round(prop.p50), '')}</tr>
        <tr><td>P90</td>${cell(Math.round(cur.p90), Math.round(prop.p90), '')}</tr>
        <tr><td>Risk</td><td>${riskChip(cur.riskLevel)}</td><td>${riskChip(prop.riskLevel)}</td></tr>
        <tr><td>Driver</td><td>${escapeHtml(cur.dominantVariable)}</td><td class="${cur.dominantVariable !== prop.dominantVariable ? 'changed' : ''}">${escapeHtml(prop.dominantVariable)}</td></tr>
      </tbody></table>`;
  }
  paintTotal(); paintPreview(); renderVersionTable(el);

  el.querySelector('#weight-sliders').oninput = e => {
    const s = e.target.closest('[data-w]'); if (!s) return;
    const i = Number(s.dataset.w); proposed.weights[i] = Number(s.value);
    el.querySelector(`[data-wv="${i}"]`).textContent = proposed.weights[i].toFixed(2);
    paintTotal(); paintPreview();
  };
  el.querySelector('#wt-normalise').onclick = () => {
    const s = readTotal() || 1; proposed.weights = proposed.weights.map(w => +(w / s).toFixed(3));
    el.querySelectorAll('[data-w]').forEach(sl => { const i = Number(sl.dataset.w); sl.value = proposed.weights[i]; el.querySelector(`[data-wv="${i}"]`).textContent = proposed.weights[i].toFixed(2); });
    paintTotal(); paintPreview();
  };
  el.querySelectorAll('[data-sig]').forEach(inp => inp.oninput = () => { proposed.sigma[Number(inp.dataset.sig)] = Number(inp.value) || 0; paintPreview(); });
  el.querySelectorAll('[data-p]').forEach(inp => inp.oninput = () => { proposed[inp.dataset.p] = Number(inp.value) || 0; paintPreview(); });
  el.querySelectorAll('[data-th]').forEach(inp => inp.oninput = () => { proposed.thresholds[inp.dataset.th] = Number(inp.value) || 0; paintPreview(); });
  el.querySelector('#wt-flight').onchange = paintPreview;

  el.querySelector('#wt-mono').onclick = () => {
    const box = el.querySelector('#mono-result'); box.hidden = false;
    box.className = 'mono-result'; box.innerHTML = 'Running T9 across the sampled input grid…';
    const btn = el.querySelector('#wt-mono'); btn.disabled = true;
    setTimeout(() => {   // let the "running" state paint before the blocking compute
      const res = monotonicityCheck(proposed);
      btn.disabled = false;
      box.className = 'mono-result ' + (res.pass ? 'ok' : 'fail');
      box.innerHTML = res.pass
        ? `<strong>✓ T9 PASSED.</strong> ${res.tested} input combinations tested — raising any single variable never reduced the buffer.`
        : `<strong>✗ T9 FAILED.</strong> ${res.violations.length} violation(s) across ${res.tested} combinations. First: ${escapeHtml(res.violations[0].variable)} dropped ${res.violations[0].drop} min.`;
      logActivity({ action: 'ran monotonicity check', target: res.pass ? 'PASS' : 'FAIL', category: 'weights', severity: res.pass ? 'info' : 'danger' });
    }, 30);
  };

  el.querySelector('#wt-save').onclick = () => {
    const total = readTotal();
    if (Math.abs(total - 1) >= 0.001) { showToast('VALIDATION_FAILED — weights must sum to 1.0', 'error'); return; }
    const nv = saveNewWeightVersion(proposed, 'Manual calibration update.');
    showToast(`New active version ${nv.id} created`, 'success');
    showModule('weights');
  };
}

let diffSelection = [];
function renderVersionTable(el) {
  const versions = getWeightVersions().slice().reverse();
  const body = el.querySelector('#ver-body');
  body.innerHTML = versions.map(v => `
    <tr data-ver="${v.id}" class="${diffSelection.includes(v.id) ? 'sel' : ''}">
      <td class="mono">${escapeHtml(v.id)}</td>
      <td><span class="ver-status vs-${v.status.toLowerCase()}">${v.status}</span></td>
      <td>${escapeHtml(v.author)}</td><td class="mono">${fmtDate(v.createdAt)}</td>
      <td class="ver-note">${escapeHtml(v.note)}</td>
      <td class="th-act">${v.status !== 'ACTIVE' ? `<button class="btn btn-ghost btn-xs" data-activate="${v.id}" type="button">Activate</button>` : '<span class="mono" style="color:var(--text-mute);font-size:11px">current</span>'}</td>
    </tr>`).join('');
  body.onclick = e => {
    const act = e.target.closest('[data-activate]');
    if (act) { e.stopPropagation(); activateWeightVersion(act.dataset.activate); showToast('Version activated (rollback applied)', 'success'); showModule('weights'); return; }
    const row = e.target.closest('[data-ver]'); if (!row) return;
    const id = row.dataset.ver;
    const idx = diffSelection.indexOf(id);
    if (idx >= 0) diffSelection.splice(idx, 1); else { diffSelection.push(id); if (diffSelection.length > 2) diffSelection.shift(); }
    renderVersionTable(el);
    if (diffSelection.length === 2) openVersionDiff(diffSelection[0], diffSelection[1]);
  };
}
function openVersionDiff(idA, idB) {
  const a = getWeightVersion(idA), b = getWeightVersion(idB); if (!a || !b) return;
  const line = (label, x, y) => `<tr><td>${label}</td><td class="mono">${x}</td><td class="mono ${x !== y ? 'changed' : ''}">${y}</td></tr>`;
  const rows = ENGINE.VAR_NAMES.map((n, i) => line('W · ' + n, a.params.weights[i], b.params.weights[i])).join('') +
    ENGINE.VAR_NAMES.map((n, i) => line('σ · ' + n, a.params.sigma[i], b.params.sigma[i])).join('') +
    line('Base buffer', a.params.baseBuffer, b.params.baseBuffer) + line('Max additional', a.params.maxAdditional, b.params.maxAdditional) +
    ['green_p90', 'green_spread', 'amber_p90', 'amber_spread'].map(k => line(k, a.params.thresholds[k], b.params.thresholds[k])).join('') +
    line('PRM P95', a.params.stationPrmP95, b.params.stationPrmP95);
  openModal(`<div class="modal-head"><div><h3>Version diff</h3><p>${escapeHtml(idA)} → ${escapeHtml(idB)}</p></div>
    <button class="modal-x" data-x aria-label="Close"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6 L18 18 M18 6 L6 18"/></svg></button></div>
    <div class="table-scroll"><table class="diff-tbl"><thead><tr><th>Parameter</th><th>${escapeHtml(idA)}</th><th>${escapeHtml(idB)}</th></tr></thead><tbody>${rows}</tbody></table></div>
    <div class="modal-foot"><button class="btn btn-primary" data-x>Close</button></div>`, true)
    .querySelectorAll('[data-x]').forEach(b2 => b2.onclick = () => { closeModal(); diffSelection = []; if (currentModule === 'weights') renderVersionTable(document.querySelector('.module-view')); });
}

/* ═══ recalibration fit (coordinate descent, MAE-minimising) ═ */
function fitWeights(params) {
  const data = getOutcomes().filter(o => o.dataQuality === 'GOOD' && Array.isArray(o.normalisedVector));
  if (data.length < 8) return null;
  const sig = x => 1 / (1 + Math.exp(-x));
  const pred = (v, w) => params.baseBuffer + sig(10 * (v.reduce((a, x, k) => a + x * w[k], 0) - 0.5)) * params.maxAdditional;
  const mae = w => data.reduce((a, o) => a + Math.abs(pred(o.normalisedVector, w) - o.actualBuffer), 0) / data.length;
  let w = params.weights.slice(); let best = mae(w);
  for (const step of [0.08, 0.04, 0.02]) {
    let improved = true, guard = 0;
    while (improved && guard++ < 300) {
      improved = false;
      for (let i = 0; i < 5; i++) for (let j = 0; j < 5; j++) {
        if (i === j || w[i] - step < 0) continue;
        const cand = w.slice(); cand[i] -= step; cand[j] += step;
        const m = mae(cand); if (m < best - 1e-9) { best = m; w = cand; improved = true; }
      }
    }
  }
  const s = w.reduce((a, b) => a + b, 0) || 1; w = w.map(x => +(x / s).toFixed(3));
  const currentMae = +mae(params.weights).toFixed(2);
  return {
    weights: w, mae: +best.toFixed(2), currentMae, n: data.length,
    improvement: currentMae > 0 ? +((currentMae - best) / currentMae * 100).toFixed(1) : 0
  };
}

/* ═══ S9 — ACCURACY ANALYTICS (key: analytics) ═════════════ */
let analyticsRange = 30, analyticsAnon = true;
function renderAnalytics(el) {
  const cutoff = analyticsRange === 0 ? 0 : Date.now() - analyticsRange * 864e5;
  const all = getOutcomes();
  const data = all.filter(o => new Date(o.loggedAt) >= cutoff);
  const errs = data.map(o => o.error);
  const abs = errs.map(Math.abs);
  const mae = abs.length ? +(abs.reduce((a, b) => a + b, 0) / abs.length).toFixed(1) : 0;
  const sorted = errs.slice().sort((a, b) => a - b);
  const median = sorted.length ? +sorted[Math.floor(sorted.length / 2)].toFixed(1) : 0;
  const within5 = abs.length ? Math.round(abs.filter(x => x <= 5).length / abs.length * 100) : 0;

  el.innerHTML = `
    <div class="mod-wide">
      <div class="mod-head"><div><h1 class="mod-title">Accuracy Analytics</h1>
        <p class="mod-sub">${data.length} outcomes · the system proving whether it works</p></div>
        <div class="an-range">${[[7, '7d'], [30, '30d'], [90, '90d'], [0, 'All']].map(([v, l]) => `<button class="rg-btn ${analyticsRange === v ? 'on' : ''}" data-range="${v}" type="button">${l}</button>`).join('')}</div></div>

      <div class="kpi-strip">
        <div class="kpi"><span class="kpi-num mono" data-count="${mae}" data-dec="1" data-suffix=" min">0</span><span class="kpi-lbl">Mean abs error</span></div>
        <div class="kpi"><span class="kpi-num mono">${fmtSigned(median)} min</span><span class="kpi-lbl">Median error</span></div>
        <div class="kpi"><span class="kpi-num mono" data-count="${within5}" data-suffix="%">0</span><span class="kpi-lbl">Within ±5 min</span></div>
        <div class="kpi"><span class="kpi-num mono" data-count="${data.length}">0</span><span class="kpi-lbl">Outcomes</span></div>
      </div>

      <div class="mgr-grid">
        <section class="card"><h3 class="card-h">MAE over time</h3><div class="an-chart">${maeLineSVG(data)}</div></section>
        <section class="card"><h3 class="card-h">Predicted vs actual</h3><div class="an-chart">${scatterSVG(data)}</div>
          <p class="an-cap mono">diagonal = perfect prediction · colour = risk</p></section>
      </div>

      <div class="mgr-grid">
        <section class="card"><h3 class="card-h">Error distribution</h3><div class="an-chart">${errorHistSVG(errs)}</div>
          <p class="an-cap mono">signed error, centred on zero</p></section>
        <section class="card"><h3 class="card-h">MAE by risk &amp; driver</h3>
          <div class="brk">${maeByGroup(data, 'riskLevel', ['RED', 'AMBER', 'GREEN'])}</div>
          <div class="brk" style="margin-top:10px">${maeByGroup(data, 'dominantVariable', ENGINE.VAR_NAMES)}</div></section>
      </div>

      <section class="card"><div class="an-sup-head"><h3 class="card-h" style="margin:0">Per-supervisor accuracy</h3>
        <label class="switch-inline"><span>Anonymise</span><label class="switch"><input type="checkbox" id="an-anon" ${analyticsAnon ? 'checked' : ''}/><span class="slider"></span></label></label></div>
        <p class="an-note">This dataset links a named individual to every prediction error — useful operationally but personally sensitive, so the identified view is opt-in.</p>
        <div id="an-sup">${supervisorTable(data, analyticsAnon)}</div>
      </section>

      <section class="card recalib-card"><h3 class="card-h">Recalibration proposal</h3>
        <div id="recalib-body"></div></section>

      <div class="an-export">
        <button class="btn btn-ghost btn-sm" id="an-csv" type="button">Export CSV</button>
        <button class="btn btn-ghost btn-sm" id="an-json" type="button">Export JSON</button>
      </div>
    </div>`;

  el.querySelectorAll('.kpi-num[data-count]').forEach(node => {
    const target = Number(node.dataset.count), suffix = node.dataset.suffix || '', dec = Number(node.dataset.dec || 0);
    const start = performance.now();
    (function frame(now) {
      const p = Math.min((now - start) / 700, 1); const v = target * (1 - Math.pow(1 - p, 3));
      node.textContent = (dec ? v.toFixed(dec) : Math.round(v)) + suffix;
      if (p < 1) requestAnimationFrame(frame); else node.textContent = (dec ? target.toFixed(dec) : target) + suffix;
    })(start);
  });

  el.querySelector('.an-range').onclick = e => { const b = e.target.closest('[data-range]'); if (b) { analyticsRange = Number(b.dataset.range); showModule('analytics'); } };
  el.querySelector('#an-anon').onchange = e => { analyticsAnon = e.target.checked; el.querySelector('#an-sup').innerHTML = supervisorTable(getOutcomes().filter(o => new Date(o.loggedAt) >= cutoff), analyticsAnon); };
  el.querySelector('#an-csv').onclick = exportOutcomesCSV;
  el.querySelector('#an-json').onclick = exportOutcomesJSON;

  renderRecalibPanel(el.querySelector('#recalib-body'));
}

function maeByGroup(data, key, order) {
  const groups = {};
  data.forEach(o => { const g = o[key]; (groups[g] = groups[g] || []).push(Math.abs(o.error)); });
  const rows = order.filter(k => groups[k]).map(k => ({ k, mae: groups[k].reduce((a, b) => a + b, 0) / groups[k].length, n: groups[k].length }));
  const max = Math.max(1, ...rows.map(r => r.mae));
  if (!rows.length) return '<p class="rs-none">No data.</p>';
  return rows.map(r => `<div class="brk-row"><span class="brk-lbl">${escapeHtml(r.k)}</span>
    <span class="brk-bar"><span style="width:${(r.mae / max * 100).toFixed(0)}%"></span></span>
    <span class="mono brk-val">${r.mae.toFixed(1)} <span class="brk-n">(${r.n})</span></span></div>`).join('');
}

function supervisorTable(data, anon) {
  const groups = {};
  data.forEach(o => { (groups[o.supervisor] = groups[o.supervisor] || []).push(o); });
  const names = Object.keys(groups).sort();
  if (!names.length) return '<p class="rs-none">No data.</p>';
  const labels = {}; names.forEach((n, i) => labels[n] = 'Supervisor ' + String.fromCharCode(65 + i));
  return `<table class="sup-tbl"><thead><tr><th>Supervisor</th><th>Outcomes</th><th>MAE</th><th>Within ±5</th></tr></thead><tbody>${names.map(n => {
    const g = groups[n]; const mae = g.reduce((a, o) => a + Math.abs(o.error), 0) / g.length;
    const w5 = Math.round(g.filter(o => Math.abs(o.error) <= 5).length / g.length * 100);
    return `<tr><td>${anon ? labels[n] : escapeHtml(n)}</td><td class="mono">${g.length}</td><td class="mono">${mae.toFixed(1)} min</td><td class="mono">${w5}%</td></tr>`;
  }).join('')
    }</tbody></table>`;
}

function renderRecalibPanel(host) {
  const active = getActiveWeightVersion();
  const fit = fitWeights(active.params);
  if (!fit) { host.innerHTML = '<p class="rs-none">Not enough GOOD-quality outcomes to propose a recalibration yet.</p>'; return; }
  const material = fit.improvement >= 5;
  host.innerHTML = `
    <div class="recalib-metrics">
      <div class="rcm"><span class="rcm-k">Current MAE</span><span class="rcm-v mono">${fit.currentMae} min</span></div>
      <div class="rcm"><span class="rcm-k">Proposed MAE</span><span class="rcm-v mono">${fit.mae} min</span></div>
      <div class="rcm"><span class="rcm-k">Improvement</span><span class="rcm-v mono ${material ? 'good' : ''}">${fit.improvement}%</span></div>
      <div class="rcm"><span class="rcm-k">GOOD outcomes</span><span class="rcm-v mono">${fit.n}</span></div>
    </div>
    ${material ? `
      <table class="cmp-tbl" style="margin-top:12px"><thead><tr><th>Variable</th><th>Current</th><th>Proposed</th></tr></thead><tbody>
        ${ENGINE.VAR_NAMES.map((n, i) => `<tr><td>${escapeHtml(n)}</td><td class="mono">${active.params.weights[i].toFixed(3)}</td><td class="mono changed">${fit.weights[i].toFixed(3)}</td></tr>`).join('')}
      </tbody></table>
      <button class="btn btn-primary btn-sm" id="recalib-approve" type="button" style="margin-top:12px">Approve &amp; create version</button>`
      : `<div class="recalib-nochange">No material improvement · current weights retained (improvement below the 5% threshold).</div>`}`;
  if (material) {
    host.querySelector('#recalib-approve').onclick = () => {
      const params = JSON.parse(JSON.stringify(active.params)); params.weights = fit.weights.slice();
      const nv = saveNewWeightVersion(params, `Recalibration from analytics · MAE ${fit.currentMae}→${fit.mae} min (${fit.improvement}% better).`, true);
      showToast(`Recalibrated weights saved as ${nv.id}`, 'success');
      showModule('analytics');
    };
  }
}

/* analytics charts */
function scatterSVG(data) {
  const W = 300, H = 180, pad = 30, lo = 15, hi = 55;
  const sx = v => pad + (ENGINE.clamp(v, lo, hi) - lo) / (hi - lo) * (W - pad - 8);
  const sy = v => (H - pad) - (ENGINE.clamp(v, lo, hi) - lo) / (hi - lo) * (H - pad - 8);
  if (!data.length) return '<p class="rs-none">No data.</p>';
  return `<svg viewBox="0 0 ${W} ${H}" width="100%">
    <line x1="${sx(lo)}" y1="${sy(lo)}" x2="${sx(hi)}" y2="${sy(hi)}" class="scat-diag"/>
    ${data.map(o => `<circle cx="${sx(o.predictedBuffer).toFixed(1)}" cy="${sy(o.actualBuffer).toFixed(1)}" r="3.4" fill="${riskColor(o.riskLevel)}" opacity="0.72" class="scat-pt"/>`).join('')}
    <text x="${W / 2}" y="${H - 4}" text-anchor="middle" class="an-axis mono">predicted →</text>
    <text x="8" y="14" class="an-axis mono">actual ↑</text></svg>`;
}
function errorHistSVG(errs) {
  const W = 300, H = 170, pad = 24, lo = -25, hi = 25, nb = 20;
  const bins = new Array(nb).fill(0);
  errs.forEach(e => { let idx = Math.floor((ENGINE.clamp(e, lo, hi) - lo) / (hi - lo) * nb); bins[ENGINE.clamp(idx, 0, nb - 1)]++; });
  const max = Math.max(1, ...bins), bw = (W - pad) / nb;
  if (!errs.length) return '<p class="rs-none">No data.</p>';
  const zeroX = pad + (0 - lo) / (hi - lo) * (W - pad);
  return `<svg viewBox="0 0 ${W} ${H}" width="100%">
    <line x1="${zeroX.toFixed(1)}" y1="6" x2="${zeroX.toFixed(1)}" y2="${H - pad}" class="eh-zero"/>
    ${bins.map((b, i) => {
    const bh = b / max * (H - pad - 8); const x = pad + i * bw;
    return `<rect x="${(x + 1).toFixed(1)}" y="${(H - pad - bh).toFixed(1)}" width="${(bw - 2).toFixed(1)}" height="${bh.toFixed(1)}" rx="1" class="hist-bar" style="fill:var(--primary);animation-delay:${i * 16}ms"/>`;
  }).join('')}
    <text x="${zeroX.toFixed(1)}" y="${H - 6}" text-anchor="middle" class="an-axis mono">0</text>
    <text x="${pad}" y="${H - 6}" class="an-axis mono">${lo}</text><text x="${W - 6}" y="${H - 6}" text-anchor="end" class="an-axis mono">+${hi}</text></svg>`;
}
function maeLineSVG(data) {
  const days = {};
  data.forEach(o => { const d = o.loggedAt.slice(0, 10); (days[d] = days[d] || []).push(Math.abs(o.error)); });
  const keys = Object.keys(days).sort();
  if (keys.length < 2) return '<p class="rs-none">Not enough days of data.</p>';
  const series = keys.map(k => ({ d: k, mae: days[k].reduce((a, b) => a + b, 0) / days[k].length }));
  const W = 300, H = 170, padL = 26, padB = 22, padT = 10, padR = 8;
  const maxM = Math.max(12, ...series.map(s => s.mae));
  const x = i => padL + (series.length === 1 ? 0.5 : i / (series.length - 1)) * (W - padL - padR);
  const y = m => padT + (1 - m / maxM) * (H - padT - padB);
  const pts = series.map((s, i) => [x(i), y(s.mae)]);
  const trend = series[series.length - 1].mae - series[0].mae;
  return `<svg viewBox="0 0 ${W} ${H}" width="100%">
    ${[0, maxM / 2, maxM].map(v => `<line x1="${padL}" y1="${y(v).toFixed(1)}" x2="${W - padR}" y2="${y(v).toFixed(1)}" class="tl-grid"/><text x="2" y="${(y(v) + 3).toFixed(1)}" class="an-axis mono">${v.toFixed(0)}</text>`).join('')}
    <path d="${polyPath(pts)}" class="tl-line" style="stroke:var(--primary)"/>
    ${pts.map(p => `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="3" fill="var(--primary)"/>`).join('')}
    <text x="${W - 6}" y="14" text-anchor="end" class="an-axis mono ${trend <= 0 ? 'trend-good' : 'trend-bad'}">${trend <= 0 ? '▼ improving' : '▲ worsening'}</text></svg>`;
}

function outcomeColumns() { return ['id', 'flightNumber', 'predictedBuffer', 'actualBuffer', 'error', 'riskLevel', 'dominantVariable', 'supervisor', 'dataQuality', 'weightVersionId', 'delayReasonCode', 'loggedAt']; }
function exportOutcomesCSV() {
  const cols = outcomeColumns(); const esc = v => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  const csv = [cols.join(','), ...getOutcomes().map(o => cols.map(c => esc(o[c])).join(','))].join('\r\n');
  download('orbis-outcomes.csv', csv, 'text/csv'); showToast('Outcomes exported as CSV', 'success');
}
function exportOutcomesJSON() { download('orbis-outcomes.json', JSON.stringify(getOutcomes(), null, 2), 'application/json'); showToast('Outcomes exported as JSON', 'success'); }

/* ═══ S10 — LOADSHEET (key: loadsheet) ═══════════════════════ */
let loadsheetSelectedFlightId = null;
let loadsheetTab = 'ls';

function lsStatusInfo(status) {
  return {
    DRAFT: { label: 'Draft', cls: 'ls-st-DRAFT' },
    PREPARED: { label: 'Prepared', cls: 'ls-st-PREPARED' },
    APPROVED: { label: 'Approved', cls: 'ls-st-APPROVED' },
    SUPERSEDED_BY_LMC: { label: 'Superseded by LMC', cls: 'ls-st-SUPERSEDED' }
  }[status] || { label: status, cls: '' };
}
function lsBadge(status) { const s = lsStatusInfo(status); return `<span class="ls-badge ${s.cls}">${escapeHtml(s.label)}</span>`; }

function buildFreshLoadsheet(f) {
  const ref = lsRefFor(f.aircraftType);
  return {
    id: uid('ls'), flightId: f.id, flightNumber: f.flightNumber,
    acReg: '', acType: f.aircraftType, version: 'A', from: 'MUX', to: '', crew: '',
    priorityAddresses: '', originator: '', recharge: 'N', initials: '',
    status: 'DRAFT', preparedBy: null, preparedByUserId: null, preparedAt: null,
    approvedBy: null, approvedByUserId: null, approvedAt: null,
    weightBuildup: {
      basicWeight: ref.dowDefault.basicWeight, crewWeight: ref.dowDefault.crewWeight, pantryWeight: ref.dowDefault.pantryWeight,
      takeoffFuel: ref.fuelDefault.takeoffFuel, tripFuel: ref.fuelDefault.tripFuel,
      maxZeroFuelWeight: ref.mzfw, maxTakeoffWeight: ref.mtow, maxLandingWeight: ref.mlw
    },
    destinations: [{
      dest: '', pax: { male: 0, female: 0, child: 0, infant: 0 }, cabBag: 0,
      distributionWeights: [0, 0, 0, 0, 0, 0], rows: { tr: 0, b: 0, c: 0, m: 0 },
      remarks: { pax: 'Y', pad: 'N' }
    }],
    notes: '',
    lastMinuteChanges: [],
    loadAndTrim: { dryOperatingWeightHArm: ref.dowHArmDefault, weightDeviation: { E: 0, F: 0, G: 0, H: 0 } }
  };
}

function lsTimelineHtml(ls) {
  const stages = [
    { label: 'Draft', done: true, at: null },
    { label: 'Prepared', done: !!ls.preparedAt, at: ls.preparedAt },
    { label: 'Approved', done: !!ls.approvedAt, at: ls.approvedAt }
  ];
  if (ls.lastMinuteChanges && ls.lastMinuteChanges.length) {
    const lastLmc = ls.lastMinuteChanges[ls.lastMinuteChanges.length - 1];
    stages.push({ label: 'LMC applied', done: true, at: lastLmc.enteredAt });
    stages.push({ label: 'Re-approved', done: ls.status === 'APPROVED' && ls.approvedAt && new Date(ls.approvedAt) > new Date(lastLmc.enteredAt), at: null });
  }
  return `<div class="ls-timeline">${stages.map((s, i) => `
    ${i ? '<span class="ls-tl-conn"></span>' : ''}
    <div class="ls-tl-stage ${s.done ? 'done' : 'pending'}">
      <span class="ls-tl-dot"></span><span class="ls-tl-label">${escapeHtml(s.label)}</span>
      ${s.at ? `<span class="ls-tl-time mono">${fmtDateTime(s.at)}</span>` : ''}
    </div>`).join('')}</div>`;
}

function lsSeatingCondLabel(ref, mac, weightKg) {
  const env = ref.envelope;
  if (!lsPointInPolygon(mac, weightKg, env)) return 'OUT OF LIMITS';
  const frac = (weightKg - env[5].weightKg) / Math.max(1, env[1].weightKg - env[5].weightKg);
  const fwdAt = env[0].mac + (env[1].mac - env[0].mac) * ENGINE.clamp(frac, 0, 1);
  const aftAt = env[5].mac + (env[4].mac - env[5].mac) * ENGINE.clamp(frac, 0, 1);
  const mid = (fwdAt + aftAt) / 2, span = Math.max(1, aftAt - fwdAt);
  const pos = (mac - mid) / (span / 2);
  if (pos < -0.35) return 'FWD-BIASED';
  if (pos > 0.35) return 'AFT-BIASED';
  return 'NORMAL';
}

function renderLoadsheet(el) {
  const flights = getFlights().slice().sort((a, b) => a.flightNumber.localeCompare(b.flightNumber));
  if (!flights.length) { el.innerHTML = emptyState('No flights', 'There are no flights to prepare a loadsheet for yet.'); return; }
  if (!loadsheetSelectedFlightId || !flights.some(x => x.id === loadsheetSelectedFlightId)) {
    const withLs = flights.find(x => getLoadsheetByFlight(x.id));
    loadsheetSelectedFlightId = (withLs || flights[0]).id;
  }
  const f = getFlight(loadsheetSelectedFlightId);
  const ref = lsRefFor(f.aircraftType);
  const lsAll = getLoadsheets();
  let ls = lsAll.find(x => x.flightId === f.id);
  if (!ls) { ls = buildFreshLoadsheet(f); lsAll.push(ls); saveLoadsheets(lsAll); }

  const locked = ls.status !== 'DRAFT';
  const validation = lsValidate(ls, ref);

  el.innerHTML = `
    <div class="mod-wide ls-mod">
      <div class="mod-head">
        <div><h1 class="mod-title">Loadsheet</h1>
          <p class="mod-sub">Loadsheet &amp; Load Message + Load and Trim Sheet · <strong>prototype/demo document — not a certified regulatory instrument</strong></p></div>
        <select class="ls-flight-select" id="ls-flight-select">
          ${flights.map(x => `<option value="${x.id}" ${x.id === f.id ? 'selected' : ''}>${escapeHtml(x.flightNumber)} · ${escapeHtml(x.aircraftType)}${getLoadsheetByFlight(x.id) ? '' : ' (new)'}</option>`).join('')}
        </select>
      </div>

      ${lsTimelineHtml(ls)}

      <div class="ls-workflow-bar">
        <div class="ls-validation-block">
          <div class="ls-validation ${validation.ok ? 'ok' : 'bad'}" id="ls-validation">${validation.ok ? '✓ All safety checks passed — approvable.' : `VALIDATION_FAILED · ${validation.issues.length} issue${validation.issues.length > 1 ? 's' : ''}`}</div>
          ${!validation.ok ? `<ul class="ls-issues" id="ls-issues">${validation.issues.map(i => `<li>${escapeHtml(i)}</li>`).join('')}</ul>` : `<ul class="ls-issues" id="ls-issues" hidden></ul>`}
        </div>
        <div class="ls-workflow-actions">
          ${ls.status === 'DRAFT' ? `<button class="btn btn-primary" id="ls-prepare-btn" type="button">Mark as Prepared</button>` : ''}
          ${ls.status === 'PREPARED' ? `<button class="btn btn-ghost" id="ls-unlock-btn" type="button">Unlock (revert to Draft)</button>` : ''}
          ${(ls.status === 'PREPARED' || ls.status === 'SUPERSEDED_BY_LMC') ? `<button class="btn btn-primary" id="ls-approve-btn" type="button" ${validation.ok ? '' : 'disabled'}>${ls.status === 'SUPERSEDED_BY_LMC' ? 'Re-approve' : 'Approve'}</button>` : ''}
        </div>
      </div>

      <div class="ls-tabbar">
        <button class="gct-tab ls-tab-btn ${loadsheetTab === 'ls' ? 'active' : ''}" data-lstab="ls" type="button">Loadsheet &amp; Load Message</button>
        <button class="gct-tab ls-tab-btn ${loadsheetTab === 'lt' ? 'active' : ''}" data-lstab="lt" type="button">Load and Trim Sheet</button>
      </div>

      <div class="ls-pane" id="ls-pane-ls" ${loadsheetTab === 'ls' ? '' : 'hidden'}>${lsTab1Html(f, ls, ref, locked)}</div>
      <div class="ls-pane" id="ls-pane-lt" ${loadsheetTab === 'lt' ? '' : 'hidden'}>${lsTab2Html(ls, ref)}</div>
    </div>`;

  wireLoadsheet(el, ls, ref, lsAll, f);
}

function lsTab1Html(f, ls, ref, locked) {
  const wt = computeWeightTotals(ls);
  const dis = locked ? 'disabled' : '';
  return `
    <section class="card ls-header-strip">
      <div class="ls-hdr-cap mono">ALL WEIGHTS IN KILOGRAMS</div>
      <div class="ls-hdr-grid">
        <div class="ls-hf"><label>Flight</label><span class="mono">${escapeHtml(ls.flightNumber)}</span></div>
        <div class="ls-hf"><label>A/C Reg.</label><input class="mono" type="text" data-lsf="acReg" value="${escapeHtml(ls.acReg)}" ${dis}/></div>
        <div class="ls-hf"><label>Version</label><input class="mono" type="text" data-lsf="version" value="${escapeHtml(ls.version)}" ${dis} maxlength="4"/></div>
        <div class="ls-hf"><label>Crew</label><input class="mono" type="text" data-lsf="crew" value="${escapeHtml(ls.crew)}" ${dis}/></div>
        <div class="ls-hf"><label>Date</label><span class="mono">${fmtDate(f.std || f.eibt)}</span></div>
        <div class="ls-hf"><label>From / To</label><span class="mono"><input class="mono ls-inline-sm" type="text" data-lsf="from" value="${escapeHtml(ls.from)}" ${dis}/> → <input class="mono ls-inline-sm" type="text" data-lsf="to" value="${escapeHtml(ls.to)}" ${dis}/></span></div>
        <div class="ls-hf"><label>Prepared By</label><span class="mono">${ls.preparedBy ? `${escapeHtml(ls.preparedBy)} · ${fmtDateTime(ls.preparedAt)}` : '—'}</span></div>
        <div class="ls-hf"><label>Approved By</label><span class="mono">${ls.approvedBy ? `${escapeHtml(ls.approvedBy)} · ${fmtDateTime(ls.approvedAt)}` : '—'}</span></div>
        <div class="ls-hf"><label>Originator</label><input class="mono" type="text" data-lsf="originator" value="${escapeHtml(ls.originator)}" ${dis}/></div>
        <div class="ls-hf"><label>Priority Addresses</label><input class="mono" type="text" data-lsf="priorityAddresses" value="${escapeHtml(ls.priorityAddresses)}" ${dis}/></div>
        <div class="ls-hf"><label>Recharge</label>
          <select data-lsf="recharge" ${dis}><option value="N" ${ls.recharge === 'N' ? 'selected' : ''}>N</option><option value="Y" ${ls.recharge === 'Y' ? 'selected' : ''}>Y</option></select></div>
        <div class="ls-hf"><label>Initials</label><input class="mono" type="text" data-lsf="initials" value="${escapeHtml(ls.initials)}" ${dis} maxlength="6"/></div>
      </div>
    </section>

    <section class="card ls-wb-card">
      <h3 class="card-h">Weight buildup</h3>
      <div class="ls-wb-grid">
        <div class="ls-wb-col">
          <div class="ls-wb-row"><span>Basic Weight</span><input type="number" data-lsf="weightBuildup.basicWeight" value="${ls.weightBuildup.basicWeight}" ${dis}/></div>
          <div class="ls-wb-row"><span>Crew</span><input type="number" data-lsf="weightBuildup.crewWeight" value="${ls.weightBuildup.crewWeight}" ${dis}/></div>
          <div class="ls-wb-row"><span>Pantry</span><input type="number" data-lsf="weightBuildup.pantryWeight" value="${ls.weightBuildup.pantryWeight}" ${dis}/></div>
          <div class="ls-wb-row computed"><span>= Dry Operating Weight</span><span class="mono" id="ls-dow">${lsKg(wt.dryOperatingWeight)}</span></div>
          <div class="ls-wb-row"><span>Take-off Fuel (+)</span><input type="number" data-lsf="weightBuildup.takeoffFuel" value="${ls.weightBuildup.takeoffFuel}" ${dis}/></div>
          <div class="ls-wb-row computed"><span>= Operating Weight</span><span class="mono" id="ls-ow">${lsKg(wt.operatingWeight)}</span></div>
        </div>
        <div class="ls-wb-col">
          <div class="ls-wb-row"><span>Max Weight — Zero Fuel</span><input type="number" data-lsf="weightBuildup.maxZeroFuelWeight" value="${ls.weightBuildup.maxZeroFuelWeight}" ${dis}/></div>
          <div class="ls-wb-row"><span>Max Weight — Takeoff</span><input type="number" data-lsf="weightBuildup.maxTakeoffWeight" value="${ls.weightBuildup.maxTakeoffWeight}" ${dis}/></div>
          <div class="ls-wb-row"><span>Max Weight — Landing</span><input type="number" data-lsf="weightBuildup.maxLandingWeight" value="${ls.weightBuildup.maxLandingWeight}" ${dis}/></div>
          <div class="ls-wb-row"><span>Take-off Fuel</span><span class="mono" id="ls-of-fuel">${lsKg(ls.weightBuildup.takeoffFuel)}</span></div>
          <div class="ls-wb-row computed"><span>= Allowed Weight for Takeoff <span class="mono ls-bind-tag" id="ls-awt-bind" title="${escapeHtml(wt.bindingLabel)}">(${wt.binding})</span></span><span class="mono" id="ls-awt">${lsKg(wt.allowedWeightForTakeoff)}</span></div>
          <div class="ls-wb-row"><span>Operating Weight (−)</span><span class="mono" id="ls-ow2">${lsKg(wt.operatingWeight)}</span></div>
          <div class="ls-wb-row computed"><span>= Allowed Traffic Load</span><span class="mono" id="ls-atl">${lsKg(wt.allowedTrafficLoad)}</span></div>
          <div class="ls-wb-row"><span>Trip Fuel</span><input type="number" data-lsf="weightBuildup.tripFuel" value="${ls.weightBuildup.tripFuel}" ${dis}/></div>
        </div>
      </div>
    </section>

    <section class="card ls-dest-card">
      <h3 class="card-h">Destination / traffic distribution ${!locked ? `<button class="btn btn-ghost btn-sm" id="ls-add-dest" type="button" style="margin-left:auto">+ Add destination</button>` : ''}</h3>
      <div id="ls-dest-list">${ls.destinations.map((d, i) => lsDestinationBlockHtml(d, i, locked, ls.destinations.length)).join('')}</div>
    </section>

    <section class="card ls-totals-card">
      <h3 class="card-h">Totals</h3>
      <div id="ls-totals-ledger">${lsTotalsLedgerHtml(ls, wt)}</div>
    </section>

    <section class="card ls-lmc-card">
      <h3 class="card-h">Last minute changes</h3>
      <div id="ls-lmc-block">${lsLmcBlockHtml(ls)}</div>
    </section>

    <section class="card ls-notes-card">
      <h3 class="card-h">Notes &amp; balance / seating condition</h3>
      <div class="ls-notes-grid">
        <textarea class="ls-notes" data-lsf="notes" ${dis} placeholder="Notes…">${escapeHtml(ls.notes || '')}</textarea>
        <div class="ls-balance-box" id="ls-balance-box">${lsBalanceBoxHtml(ls, ref, wt)}</div>
      </div>
    </section>`;
}

function lsDestinationBlockHtml(d, i, locked, count) {
  const dis = locked ? 'disabled' : '';
  const paxTotal = (Number(d.pax.male) || 0) + (Number(d.pax.female) || 0) + (Number(d.pax.child) || 0) + (Number(d.pax.infant) || 0);
  const rowTotal = (Number(d.rows.tr) || 0) + (Number(d.rows.b) || 0) + (Number(d.rows.c) || 0) + (Number(d.rows.m) || 0);
  return `<div class="ls-dest-block">
    <div class="ls-dest-head">
      <span class="ls-dest-tag">${i + 1}</span>
      <input class="mono ls-dest-name" type="text" placeholder="Destination" data-lsf="destinations.${i}.dest" value="${escapeHtml(d.dest)}" ${dis}/>
      ${count > 1 && !locked ? `<button class="ls-dest-remove" data-remove-dest="${i}" type="button" title="Remove destination">×</button>` : ''}
    </div>

    <div class="ls-dest-sub">
      <div class="ls-dest-subhead"><span>Passengers</span><span class="ls-dest-total">Total <span class="mono" id="ls-dpax-${i}">${paxTotal}</span></span></div>
      <div class="ls-dest-pax-row">
        <label class="ls-pax-tile">Male<input type="number" data-lsf="destinations.${i}.pax.male" value="${d.pax.male}" ${dis}/></label>
        <label class="ls-pax-tile">Female<input type="number" data-lsf="destinations.${i}.pax.female" value="${d.pax.female}" ${dis}/></label>
        <label class="ls-pax-tile">Child<input type="number" data-lsf="destinations.${i}.pax.child" value="${d.pax.child}" ${dis}/></label>
        <label class="ls-pax-tile">Infant<input type="number" data-lsf="destinations.${i}.pax.infant" value="${d.pax.infant}" ${dis}/></label>
        <span class="ls-pax-divider"></span>
        <label class="ls-pax-tile ls-pax-tile-bag">Cab Bag (kg)<input type="number" data-lsf="destinations.${i}.cabBag" value="${d.cabBag}" ${dis}/></label>
      </div>
    </div>

    <div class="ls-dest-sub">
      <div class="ls-dest-subhead"><span>Distribution weights</span></div>
      <div class="ls-dist-row">
        ${d.distributionWeights.map((w, wi) => `<label>DW${wi + 1}<input type="number" data-lsf="destinations.${i}.distributionWeights.${wi}" value="${w}" ${dis}/></label>`).join('')}
      </div>
    </div>

    <div class="ls-dest-sub">
      <div class="ls-dest-subhead"><span>Compartments &amp; remarks</span><span class="ls-dest-total">T <span class="mono" id="ls-dtot-${i}">${lsKg(rowTotal)}</span></span></div>
      <div class="ls-cat-row">
        <label>Tr<input type="number" data-lsf="destinations.${i}.rows.tr" value="${d.rows.tr}" ${dis}/></label>
        <label>B<input type="number" data-lsf="destinations.${i}.rows.b" value="${d.rows.b}" ${dis}/></label>
        <label>C<input type="number" data-lsf="destinations.${i}.rows.c" value="${d.rows.c}" ${dis}/></label>
        <label>M<input type="number" data-lsf="destinations.${i}.rows.m" value="${d.rows.m}" ${dis}/></label>
        <label class="ls-remark">PAX <select data-lsf="destinations.${i}.remarks.pax" ${dis}><option ${d.remarks.pax === 'Y' ? 'selected' : ''}>Y</option><option ${d.remarks.pax === 'N' ? 'selected' : ''}>N</option></select></label>
        <label class="ls-remark">PAD <select data-lsf="destinations.${i}.remarks.pad" ${dis}><option ${d.remarks.pad === 'Y' ? 'selected' : ''}>Y</option><option ${d.remarks.pad === 'N' ? 'selected' : ''}>N</option></select></label>
      </div>
    </div>
  </div>`;
}

function lsKg(n) { return Math.round(n || 0).toLocaleString() + ' kg'; }

function lsTotalsLedgerHtml(ls, wt) {
  const zfwLmc = wt.zeroFuelWeight, towLmc = wt.takeoffWeight, lwLmc = wt.landingWeight;
  const zfwBad = zfwLmc > ls.weightBuildup.maxZeroFuelWeight, towBad = towLmc > ls.weightBuildup.maxTakeoffWeight, lwBad = lwLmc > ls.weightBuildup.maxLandingWeight, tlBad = (wt.totalTrafficLoad + wt.lmcTotal) > wt.allowedTrafficLoad;
  return `
    <div class="ls-ledger-row"><span>Total Passenger Weight (+)</span><span class="mono">${lsKg(wt.totalPassengerWeight)}</span></div>
    <div class="ls-ledger-row ${tlBad ? 'bad' : ''}"><span>= Total Traffic Load</span><span class="mono">${lsKg(wt.totalTrafficLoad)}</span></div>
    <div class="ls-ledger-row"><span>Dry Operating Weight (+)</span><span class="mono">${lsKg(wt.dryOperatingWeight)}</span></div>
    <div class="ls-ledger-row ${zfwBad ? 'bad' : ''}"><span>= Zero Fuel Weight ${wt.lmcTotal ? `<span class="ls-lmc-tag">± LMC ${fmtSigned(wt.lmcTotal)}</span>` : ''}</span><span class="mono">${lsKg(zfwLmc)}</span></div>
    <div class="ls-ledger-row"><span>Take-off Fuel (+)</span><span class="mono">${lsKg(ls.weightBuildup.takeoffFuel)}</span></div>
    <div class="ls-ledger-row ${towBad ? 'bad' : ''}"><span>= Take-off Weight ${wt.lmcTotal ? `<span class="ls-lmc-tag">± LMC ${fmtSigned(wt.lmcTotal)}</span>` : ''}</span><span class="mono">${lsKg(towLmc)}</span></div>
    <div class="ls-ledger-row"><span>Trip Fuel (−)</span><span class="mono">${lsKg(ls.weightBuildup.tripFuel)}</span></div>
    <div class="ls-ledger-row ${lwBad ? 'bad' : ''}"><span>= Landing Weight ${wt.lmcTotal ? `<span class="ls-lmc-tag">± LMC ${fmtSigned(wt.lmcTotal)}</span>` : ''}</span><span class="mono">${lsKg(lwLmc)}</span></div>
    <div class="ls-ledger-divider"></div>
    <div class="ls-ledger-row"><span>Allowed Traffic Load</span><span class="mono">${lsKg(wt.allowedTrafficLoad)}</span></div>
    <div class="ls-ledger-row ${wt.underloadBeforeLMC < 0 ? 'bad' : ''}"><span>Underload Before LMC</span><span class="mono">${lsKg(wt.underloadBeforeLMC)}</span></div>
    <div class="ls-ledger-row"><span>Total Passengers</span><span class="mono">${wt.totalPassengers}</span></div>`;
}

function lsLmcBlockHtml(ls) {
  const rows = ls.lastMinuteChanges || [];
  const enabled = ls.status !== 'DRAFT';
  return `
    <table class="cmp-tbl ls-lmc-tbl">
      <thead><tr><th>Dest</th><th>Specification</th><th>Compartment</th><th>± Weight</th><th>By</th><th>At</th></tr></thead>
      <tbody>
        ${rows.map(r => `<tr><td>${escapeHtml(r.dest)}</td><td>${escapeHtml(r.specification)}</td><td class="mono">${escapeHtml(r.compartment)}</td><td class="mono">${fmtSigned(r.weightDelta)} kg</td><td>${escapeHtml(r.enteredBy)}</td><td class="mono">${hhmm(r.enteredAt)}</td></tr>`).join('')}
        <tr class="ls-lmc-total-row"><td colspan="3">LMC Total</td><td class="mono" id="ls-lmc-total">${fmtSigned(lsSum(rows.map(x => x.weightDelta)))} kg</td><td colspan="2"></td></tr>
      </tbody>
    </table>
    ${enabled ? `
    <div class="ls-lmc-add">
      <input class="mono" type="text" id="ls-lmc-dest" placeholder="Dest"/>
      <input type="text" id="ls-lmc-spec" placeholder="Specification"/>
      <input class="mono" type="text" id="ls-lmc-comp" placeholder="Compartment"/>
      <input class="mono" type="number" id="ls-lmc-wt" placeholder="± kg"/>
      <button class="btn btn-primary btn-sm" id="ls-lmc-add-btn" type="button">Add LMC</button>
    </div>` : `<p class="rs-none">Available once the loadsheet has been prepared.</p>`}`;
}

function lsBalanceBoxHtml(ls, ref, wt) {
  const lat = computeLoadAndTrim(ls, ref);
  const cond = lsSeatingCondLabel(ref, lat.cgPercentMacTakeoff, wt.takeoffWeight);
  return `
    <div class="ls-bal-row"><span>ZFW %MAC</span><span class="mono">${lat.cgPercentMacZFW}%</span></div>
    <div class="ls-bal-row"><span>TOW %MAC</span><span class="mono">${lat.cgPercentMacTakeoff}%</span></div>
    <div class="ls-bal-row"><span>Seating Cond.</span><span class="mono ${cond === 'OUT OF LIMITS' ? 'bad' : ''}">${cond}</span></div>`;
}

/* ──────── TAB 2 · LOAD AND TRIM SHEET ──────── */
function lsTab2Html(ls, ref) {
  const lat = computeLoadAndTrim(ls, ref);
  const dev = ls.loadAndTrim.weightDeviation;
  return `
    <section class="card">
      <h3 class="card-h">Dry operating weight conditions</h3>
      <div class="ls-dow-box">
        <div class="ls-dow-inputs">
          <label>DOW H-arm (cm)<input type="number" data-lsf="loadAndTrim.dryOperatingWeightHArm" value="${ls.loadAndTrim.dryOperatingWeightHArm}"/></label>
          <span class="mono ls-dow-static">Weight: ${lsKg(computeWeightTotals(ls).dryOperatingWeight)}</span>
        </div>
        <div class="ls-formula mono">I = ((H-arm − ${ref.indexConstant}) × W / 2500) + 100</div>
        <div class="ls-dow-result" id="lt-dow-index">Dry Operating Weight Index = <strong>${lat.dryOperatingWeightIndex}</strong></div>
      </div>
    </section>

    <section class="card">
      <h3 class="card-h">Weight deviation &amp; basic index correction</h3>
      <div class="ls-dev-flow">
        <table class="cmp-tbl ls-dev-tbl">
          <thead><tr><th></th>${['E', 'F', 'G', 'H'].map(z => `<th>${z}</th>`).join('')}</tr></thead>
          <tbody>
            <tr><td>Deviation (kg)</td>${['E', 'F', 'G', 'H'].map(z => `<td><input type="number" class="mono ls-dev-input" data-lsf="loadAndTrim.weightDeviation.${z}" value="${dev[z]}"/></td>`).join('')}</tr>
            <tr><td>Corr. @ +100kg</td>${['E', 'F', 'G', 'H'].map(z => `<td class="mono">${ref.basicIndexCorrection.plus100[z]}</td>`).join('')}</tr>
            <tr><td>Corr. @ −100kg</td>${['E', 'F', 'G', 'H'].map(z => `<td class="mono">${ref.basicIndexCorrection.minus100[z]}</td>`).join('')}</tr>
          </tbody>
        </table>
        <span class="ls-dev-arrow">→</span>
        <div class="ls-corrected-box" id="lt-corrected">Corrected Index<br/><strong>${lat.correctedIndex}</strong></div>
      </div>
    </section>

    <section class="card">
      <h3 class="card-h">Aircraft schematic</h3>
      <div id="lt-schematic">${lsSchematicSVG(ref, lat)}</div>
    </section>

    <section class="card">
      <h3 class="card-h">Zones / index table</h3>
      <div id="lt-zones-table">${lsZonesTableHtml(lat)}</div>
    </section>

    <section class="card">
      <h3 class="card-h">Fuel index &amp; index summary</h3>
      <div id="lt-summary-strip">${lsSummaryStripHtml(ls, lat)}</div>
    </section>

    <div class="ls-cg-grid">
      <section class="card">
        <h3 class="card-h">CG envelope chart</h3>
        <div id="lt-chart">${lsEnvelopeChartSVG(ref, lat, computeWeightTotals(ls))}</div>
        <p class="an-cap mono">dashed = take-off limit · solid = ZFW limit</p>
      </section>
      <section class="card">
        <div id="lt-cg-readouts">${lsCgReadoutsHtml(lat)}</div>
        <h3 class="card-h" style="margin-top:16px">Pitch trim</h3>
        <div id="lt-trim">${lsTrimBlockHtml(lat)}</div>
      </section>
    </div>`;
}

function lsZonesTableHtml(lat) {
  return `<table class="cmp-tbl">
    <thead><tr><th>Zone</th><th>Kind</th><th>Nbr</th><th>Weight (kg)</th><th>Index</th></tr></thead>
    <tbody>${lat.zones.map(z => `<tr><td>${escapeHtml(z.label)}</td><td>${z.kind}</td><td class="mono">${z.paxCount != null ? z.paxCount : '—'}</td><td class="mono">${Math.round(z.weightKg)}</td><td class="mono">${z.indexUnit}</td></tr>`).join('')}</tbody>
  </table>`;
}

function lsSummaryStripHtml(ls, lat) {
  return `
    <div class="kpi-strip ls-summary-strip">
      <div class="kpi"><span class="kpi-num mono">${lat.fuelIndex}</span><span class="kpi-lbl">Fuel Index</span></div>
      <div class="kpi"><span class="kpi-num mono">${lat.deadLoadIndex}</span><span class="kpi-lbl">Dead Load Index</span></div>
      <div class="kpi"><span class="kpi-num mono">${lat.loadedIndexZFW}</span><span class="kpi-lbl">Loaded Index ZFW</span></div>
      <div class="kpi"><span class="kpi-num mono">${lat.loadedIndexTOW}</span><span class="kpi-lbl">Loaded Index TOW</span></div>
    </div>`;
}

function lsCgReadoutsHtml(lat) {
  return `
    <h3 class="card-h">Takeoff CG %MAC</h3>
    <div class="ls-cg-big ${lat.towInEnvelope ? '' : 'bad'}">${lat.cgPercentMacTakeoff}%</div>
    <div class="ls-cdu-box ${lat.zfwInEnvelope ? '' : 'bad'}">
      <div class="ls-cdu-title">ZFW CDU Input</div>
      <div class="ls-cdu-row"><span>Weight</span><span class="mono">${(lat._zfwK || 0)}</span></div>
      <div class="ls-cdu-row"><span>CG %MAC</span><span class="mono">${lat.cgPercentMacZFW}%</span></div>
    </div>`;
}

function lsTrimBlockHtml(lat) {
  const dirLabel = lat.pitchTrimDirection === 'CONSTANT' ? 'CONSTANT' : `${lat.pitchTrimDegrees}° ${lat.pitchTrimDirection}`;
  return `${lsTrimGaugeSVG(lat)}<div class="ls-trim-readout mono">${dirLabel}</div>`;
}

function lsSchematicSVG(ref, lat) {
  const W = 640, H = 190;
  const cabin = lat.zones.filter(z => z.kind === 'CABIN');
  const cargo = lat.zones.filter(z => z.kind === 'CARGO');
  const fuseX = 40, fuseW = W - 80, fuseY = 30, fuseH = 60;
  const cabinW = fuseW / Math.max(1, cabin.length);
  const cargoY = fuseY + fuseH + 30, cargoH = 40;
  const cargoW = fuseW / Math.max(1, cargo.length);
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" class="ls-schematic-svg">
    <path d="M${fuseX} ${fuseY} h${fuseW} a15 15 0 0 1 0 ${fuseH} h-${fuseW} a15 15 0 0 1 0 -${fuseH} Z" class="ls-fuse"/>
    ${cabin.map((z, i) => {
    const x = fuseX + i * cabinW; const rz = ref.cabinZones[i] || {};
    return `<g class="ls-cabin-zone">
        <rect x="${x.toFixed(1)}" y="${fuseY}" width="${cabinW.toFixed(1)}" height="${fuseH}" class="ls-cabin-rect"/>
        <text x="${(x + cabinW / 2).toFixed(1)}" y="${fuseY + 20}" text-anchor="middle" class="ls-zone-code">${escapeHtml(z.code)}</text>
        <text x="${(x + cabinW / 2).toFixed(1)}" y="${fuseY + 36}" text-anchor="middle" class="ls-zone-sub mono">${z.paxCount} pax · rows ${escapeHtml(rz.rowRange || '')}</text>
        <text x="${(x + cabinW / 2).toFixed(1)}" y="${fuseY + 50}" text-anchor="middle" class="ls-zone-sub mono">${Math.round(z.weightKg)} kg</text>
      </g>`;
  }).join('')}
    ${cargo.map((z, i) => {
    const x = fuseX + i * cargoW;
    return `<g class="ls-cargo-zone">
        <rect x="${x.toFixed(1)}" y="${cargoY}" width="${cargoW.toFixed(1)}" height="${cargoH}" rx="4" class="ls-cargo-rect"/>
        <text x="${(x + cargoW / 2).toFixed(1)}" y="${cargoY + 16}" text-anchor="middle" class="ls-zone-code">${escapeHtml(z.label)}</text>
        <text x="${(x + cargoW / 2).toFixed(1)}" y="${cargoY + 31}" text-anchor="middle" class="ls-zone-sub mono">${Math.round(z.weightKg)}/${z.capacityKg} kg</text>
      </g>`;
  }).join('')}
  </svg>`;
}

function lsEnvelopeChartSVG(ref, lat, wt) {
  const W = 400, H = 300, padL = 50, padR = 16, padT = 14, padB = 30;
  const macLo = 8, macHi = 40, wLo = 0, wHi = ref.mtow * 1.05;
  const sx = mac => padL + (mac - macLo) / (macHi - macLo) * (W - padL - padR);
  const sy = w => (H - padB) - (w - wLo) / (wHi - wLo) * (H - padT - padB);
  const envPts = ref.envelope.map(p => [sx(p.mac), sy(p.weightKg)]);
  const refLines = [{ w: ref.mzfw, label: 'MZFW' }, { w: ref.mlw, label: 'MLW' }, { w: ref.mtow, label: 'MTOW' }];
  const zfwPt = [sx(lat.cgPercentMacZFW), sy(wt.zeroFuelWeight)];
  const towPt = [sx(lat.cgPercentMacTakeoff), sy(wt.takeoffWeight)];
  const bad = !lat.zfwInEnvelope || !lat.towInEnvelope;
  const traceLen = Math.max(1, Math.hypot(towPt[0] - zfwPt[0], towPt[1] - zfwPt[1])).toFixed(1);
  lat._zfwK = (wt.zeroFuelWeight / 1000).toFixed(1);
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" class="ls-cg-svg">
    <polygon points="${envPts.map(p => p.join(',')).join(' ')}" class="ls-env-fill"/>
    <polyline points="${envPts.slice(0, 3).map(p => p.join(',')).join(' ')}" class="ls-env-line ls-env-dashed"/>
    <polyline points="${envPts.slice(3, 6).map(p => p.join(',')).join(' ')}" class="ls-env-line ls-env-solid"/>
    ${refLines.map(r => `<line x1="${padL}" y1="${sy(r.w).toFixed(1)}" x2="${W - padR}" y2="${sy(r.w).toFixed(1)}" class="ls-ref-line"/><text x="${W - padR}" y="${(sy(r.w) - 3).toFixed(1)}" text-anchor="end" class="ls-axis-lbl mono">${r.label} ${(r.w / 1000).toFixed(0)}k</text>`).join('')}
    <line x1="${padL}" y1="${padT}" x2="${padL}" y2="${H - padB}" class="ls-axis"/>
    <line x1="${padL}" y1="${H - padB}" x2="${W - padR}" y2="${H - padB}" class="ls-axis"/>
    <text x="${((padL + W - padR) / 2).toFixed(1)}" y="${H - 6}" text-anchor="middle" class="ls-axis-lbl mono">Aircraft CG (%MAC)</text>
    <path d="M${zfwPt[0].toFixed(1)} ${zfwPt[1].toFixed(1)} L${towPt[0].toFixed(1)} ${towPt[1].toFixed(1)}" class="ls-trace ${bad ? 'bad' : ''}" stroke-dasharray="${traceLen}" stroke-dashoffset="${traceLen}"/>
    <circle cx="${zfwPt[0].toFixed(1)}" cy="${zfwPt[1].toFixed(1)}" r="4" class="ls-trace-pt ${lat.zfwInEnvelope ? '' : 'bad'}"/>
    <circle cx="${towPt[0].toFixed(1)}" cy="${towPt[1].toFixed(1)}" r="4" class="ls-trace-pt ${lat.towInEnvelope ? '' : 'bad'}"/>
    <text x="${zfwPt[0].toFixed(1)}" y="${(zfwPt[1] - 8).toFixed(1)}" text-anchor="middle" class="ls-trace-lbl mono ${lat.zfwInEnvelope ? '' : 'bad'}">ZFW ${lat.cgPercentMacZFW}%</text>
    <text x="${towPt[0].toFixed(1)}" y="${(towPt[1] - 8).toFixed(1)}" text-anchor="middle" class="ls-trace-lbl mono ${lat.towInEnvelope ? '' : 'bad'}">TOW ${lat.cgPercentMacTakeoff}%</text>
  </svg>`;
}

function lsTrimGaugeSVG(lat) {
  const W = 300, H = 60, lo = -6, hi = 6;
  const signedDeg = lat.pitchTrimDirection === 'DOWN' ? -lat.pitchTrimDegrees : lat.pitchTrimDegrees;
  const clamped = Math.max(lo, Math.min(hi, signedDeg));
  const x = 20 + (clamped - lo) / (hi - lo) * (W - 40);
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" class="ls-trim-svg">
    <line x1="20" y1="30" x2="${W - 20}" y2="30" class="ls-trim-track"/>
    <text x="20" y="48" class="ls-trim-tick mono">NOSE DOWN</text>
    <text x="${W / 2}" y="48" text-anchor="middle" class="ls-trim-tick mono">CONSTANT</text>
    <text x="${W - 20}" y="48" text-anchor="end" class="ls-trim-tick mono">NOSE UP</text>
    <circle cx="${x.toFixed(1)}" cy="30" r="7" class="ls-trim-marker"/>
  </svg>`;
}

function lsSetDeep(obj, path, value) {
  const parts = path.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) { const k = /^\d+$/.test(parts[i]) ? Number(parts[i]) : parts[i]; cur = cur[k]; }
  const last = parts[parts.length - 1]; const lastKey = /^\d+$/.test(last) ? Number(last) : last;
  cur[lastKey] = value;
}

/* apply an approved loadsheet's confirmed passenger count to the flight's
   risk-engine inputs — same recalc + fresh-alert pattern as recalcSequence,
   scoped to just this one flight rather than the whole active fleet */
function applyLoadsheetToFlight(ls, wt) {
  const flight = getFlight(ls.flightId);
  if (!flight) return null;
  const seating = (AIRCRAFT_SPECS[flight.aircraftType] || {}).seating;
  const pct = seating ? +((wt.totalPassengers / seating) * 100).toFixed(1) : flight.rawInputs.loadFactorPercent;
  const old = { risk: flight.calculation.riskLevel, buffer: flight.calculation.bufferMinutes };
  flight.rawInputs.loadFactorPercent = pct;
  flight.rawInputs.passengerTotal = wt.totalPassengers;
  const p = flight.inputProvenance.perVariable.loadFactorPercent;
  p.quality = 'MEASURED'; p.source = `Loadsheet ${ls.flightNumber}`; p.timestamp = nowISO(); delete p._autoD;
  flight.calculation = calculateFlightRisk(flight);
  updateFlight(flight.id, { rawInputs: flight.rawInputs, inputProvenance: flight.inputProvenance, calculation: flight.calculation });
  if (flight.calculation.riskLevel === 'RED' && old.risk !== 'RED') {
    const alerts = getAlerts(); const al = makeAlertRecord(flight); al.createdAt = nowISO();
    flight.alertId = al.id; flight.ackStatus = 'REQUIRED'; flight.ackAt = null; flight.ackBy = null;
    alerts.push(al); saveAlerts(alerts);
    updateFlight(flight.id, { alertId: flight.alertId, ackStatus: flight.ackStatus, ackAt: flight.ackAt, ackBy: flight.ackBy });
  }
  return { old, next: { risk: flight.calculation.riskLevel, buffer: flight.calculation.bufferMinutes }, loadFactorPercent: pct };
}

function wireLoadsheet(el, ls, ref, lsAll, f) {
  function repaint() {
    const wt = computeWeightTotals(ls);
    const lat = computeLoadAndTrim(ls, ref);
    const validation = lsValidate(ls, ref);
    saveLoadsheets(lsAll);

    const set = (id, html) => { const n = el.querySelector('#' + id); if (n) n.textContent = html; };
    set('ls-dow', lsKg(wt.dryOperatingWeight));
    set('ls-ow', lsKg(wt.operatingWeight));
    set('ls-ow2', lsKg(wt.operatingWeight));
    set('ls-of-fuel', lsKg(ls.weightBuildup.takeoffFuel));
    set('ls-awt', lsKg(wt.allowedWeightForTakeoff));
    set('ls-atl', lsKg(wt.allowedTrafficLoad));
    const bindEl = el.querySelector('#ls-awt-bind'); if (bindEl) { bindEl.textContent = `(${wt.binding})`; bindEl.title = wt.bindingLabel; }

    ls.destinations.forEach((d, i) => {
      const paxTotal = (Number(d.pax.male) || 0) + (Number(d.pax.female) || 0) + (Number(d.pax.child) || 0) + (Number(d.pax.infant) || 0);
      const rowTotal = (Number(d.rows.tr) || 0) + (Number(d.rows.b) || 0) + (Number(d.rows.c) || 0) + (Number(d.rows.m) || 0);
      set(`ls-dpax-${i}`, paxTotal); set(`ls-dtot-${i}`, lsKg(rowTotal));
    });

    const ledger = el.querySelector('#ls-totals-ledger'); if (ledger) ledger.innerHTML = lsTotalsLedgerHtml(ls, wt);
    const lmcTotalEl = el.querySelector('#ls-lmc-total'); if (lmcTotalEl) lmcTotalEl.textContent = fmtSigned(lsSum((ls.lastMinuteChanges || []).map(x => x.weightDelta))) + ' kg';
    const balBox = el.querySelector('#ls-balance-box'); if (balBox) balBox.innerHTML = lsBalanceBoxHtml(ls, ref, wt);

    const valEl = el.querySelector('#ls-validation');
    if (valEl) { valEl.className = 'ls-validation ' + (validation.ok ? 'ok' : 'bad'); valEl.textContent = validation.ok ? '✓ All safety checks passed — approvable.' : `VALIDATION_FAILED · ${validation.issues.length} issue${validation.issues.length > 1 ? 's' : ''}`; }
    const issuesEl = el.querySelector('#ls-issues');
    if (issuesEl) { issuesEl.hidden = validation.ok; issuesEl.innerHTML = validation.issues.map(i => `<li>${escapeHtml(i)}</li>`).join(''); }
    const approveBtn = el.querySelector('#ls-approve-btn'); if (approveBtn) approveBtn.disabled = !validation.ok;

    const dowIdxEl = el.querySelector('#lt-dow-index'); if (dowIdxEl) dowIdxEl.innerHTML = `Dry Operating Weight Index = <strong>${lat.dryOperatingWeightIndex}</strong>`;
    const dowStatic = el.querySelector('.ls-dow-static'); if (dowStatic) dowStatic.textContent = `Weight: ${lsKg(wt.dryOperatingWeight)}`;
    const corrBox = el.querySelector('#lt-corrected'); if (corrBox) corrBox.innerHTML = `Corrected Index<br/><strong>${lat.correctedIndex}</strong>`;
    const schem = el.querySelector('#lt-schematic'); if (schem) schem.innerHTML = lsSchematicSVG(ref, lat);
    const zt = el.querySelector('#lt-zones-table'); if (zt) zt.innerHTML = lsZonesTableHtml(lat);
    const sstrip = el.querySelector('#lt-summary-strip'); if (sstrip) sstrip.innerHTML = lsSummaryStripHtml(ls, lat);
    const trim = el.querySelector('#lt-trim'); if (trim) trim.innerHTML = lsTrimBlockHtml(lat);
    const chart = el.querySelector('#lt-chart');
    if (chart) { chart.innerHTML = lsEnvelopeChartSVG(ref, lat, wt); animateLsTrace(chart); }
    /* lsEnvelopeChartSVG sets lat._zfwK (the ZFW CDU readout) as a side
       effect, so the CG readouts must be painted after the chart above */
    const cgReadouts = el.querySelector('#lt-cg-readouts'); if (cgReadouts) cgReadouts.innerHTML = lsCgReadoutsHtml(lat);
  }

  function animateLsTrace(scope) {
    const trace = (scope || el).querySelector('.ls-trace');
    if (!trace) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { trace.style.strokeDashoffset = '0'; return; }
    requestAnimationFrame(() => { trace.style.transition = 'stroke-dashoffset 1.1s var(--ease)'; trace.style.strokeDashoffset = '0'; });
  }
  animateLsTrace(el);

  el.querySelector('#ls-flight-select').onchange = e => { loadsheetSelectedFlightId = e.target.value; showModule('loadsheet'); };
  el.querySelectorAll('.ls-tab-btn').forEach(btn => btn.onclick = () => {
    loadsheetTab = btn.dataset.lstab;
    el.querySelectorAll('.ls-tab-btn').forEach(b => b.classList.toggle('active', b === btn));
    el.querySelector('#ls-pane-ls').hidden = loadsheetTab !== 'ls';
    el.querySelector('#ls-pane-lt').hidden = loadsheetTab !== 'lt';
  });

  el.addEventListener('input', e => {
    const t = e.target; if (!t.dataset.lsf) return;
    const value = t.type === 'number' ? (Number(t.value) || 0) : t.value;
    lsSetDeep(ls, t.dataset.lsf, value);
    repaint();
  });
  el.addEventListener('change', e => {
    const t = e.target; if (t.tagName !== 'SELECT' || !t.dataset.lsf) return;
    lsSetDeep(ls, t.dataset.lsf, t.value); repaint();
  });

  const addDestBtn = el.querySelector('#ls-add-dest');
  if (addDestBtn) addDestBtn.onclick = () => {
    ls.destinations.push({ dest: '', pax: { male: 0, female: 0, child: 0, infant: 0 }, cabBag: 0, distributionWeights: [0, 0, 0, 0, 0, 0], rows: { tr: 0, b: 0, c: 0, m: 0 }, remarks: { pax: 'Y', pad: 'N' } });
    saveLoadsheets(lsAll); showModule('loadsheet');
  };
  el.querySelectorAll('[data-remove-dest]').forEach(btn => btn.onclick = () => {
    ls.destinations.splice(Number(btn.dataset.removeDest), 1); saveLoadsheets(lsAll); showModule('loadsheet');
  });

  const lmcAddBtn = el.querySelector('#ls-lmc-add-btn');
  if (lmcAddBtn) lmcAddBtn.onclick = () => {
    const dest = el.querySelector('#ls-lmc-dest').value.trim();
    const spec = el.querySelector('#ls-lmc-spec').value.trim();
    const comp = el.querySelector('#ls-lmc-comp').value.trim();
    const wtd = Number(el.querySelector('#ls-lmc-wt').value);
    if (!spec || !wtd) { showToast('Enter a specification and a non-zero weight change', 'error'); return; }
    const session = getSession();
    ls.lastMinuteChanges.push({ dest, specification: spec, compartment: comp, weightDelta: wtd, enteredBy: session ? session.name : 'System', enteredAt: nowISO() });
    if (ls.status === 'APPROVED') ls.status = 'SUPERSEDED_BY_LMC';
    saveLoadsheets(lsAll);
    logActivity({ action: `added LMC (${fmtSigned(wtd)} kg)`, target: ls.flightNumber, category: 'loadsheet', severity: 'warn' });
    showToast(`LMC added to ${ls.flightNumber}${ls.status === 'SUPERSEDED_BY_LMC' ? ' — now requires re-approval' : ''}`, 'notice');
    showModule('loadsheet');
  };

  const prepareBtn = el.querySelector('#ls-prepare-btn');
  if (prepareBtn) prepareBtn.onclick = () => {
    const session = getSession();
    ls.status = 'PREPARED'; ls.preparedBy = session ? session.name : 'System'; ls.preparedByUserId = session ? session.userId : null; ls.preparedAt = nowISO();
    if (!ls.initials && session) ls.initials = session.name.split(' ').map(n => n[0]).join('').toUpperCase();
    saveLoadsheets(lsAll);
    logActivity({ action: 'marked loadsheet as prepared', target: ls.flightNumber, category: 'loadsheet', severity: 'info' });
    showToast(`Loadsheet for ${ls.flightNumber} prepared and locked`, 'success');
    showModule('loadsheet');
  };

  const unlockBtn = el.querySelector('#ls-unlock-btn');
  if (unlockBtn) unlockBtn.onclick = async () => {
    const ok = await confirmDialog({ title: 'Unlock loadsheet?', message: `Revert the loadsheet for ${ls.flightNumber} back to Draft? It will need to be re-prepared before it can be approved.`, confirmLabel: 'Unlock', danger: false });
    if (!ok) return;
    ls.status = 'DRAFT'; ls.preparedBy = null; ls.preparedByUserId = null; ls.preparedAt = null;
    saveLoadsheets(lsAll);
    logActivity({ action: 'unlocked loadsheet to Draft', target: ls.flightNumber, category: 'loadsheet', severity: 'info' });
    showToast(`Loadsheet for ${ls.flightNumber} unlocked`, 'notice');
    showModule('loadsheet');
  };

  const approveBtn = el.querySelector('#ls-approve-btn');
  if (approveBtn) approveBtn.onclick = async () => {
    const validation = lsValidate(ls, ref);
    if (!validation.ok) { showToast('Cannot approve — validation issues remain', 'error'); return; }
    const session = getSession();
    if (session && ls.preparedByUserId && ls.preparedByUserId === session.userId) { showToast('Approval requires a different user than the preparer', 'error'); return; }
    const ok = await confirmDialog({ title: `${ls.status === 'SUPERSEDED_BY_LMC' ? 'Re-approve' : 'Approve'} loadsheet?`, message: `Confirm the load figures for ${ls.flightNumber}? This updates the flight's risk-engine load factor input.`, confirmLabel: ls.status === 'SUPERSEDED_BY_LMC' ? 'Re-approve' : 'Approve', danger: false });
    if (!ok) return;
    ls.status = 'APPROVED'; ls.approvedBy = session ? session.name : 'System'; ls.approvedByUserId = session ? session.userId : null; ls.approvedAt = nowISO();
    saveLoadsheets(lsAll);
    logActivity({ action: 'approved loadsheet', target: ls.flightNumber, category: 'loadsheet', severity: 'success' });
    const wt = computeWeightTotals(ls);
    const hook = applyLoadsheetToFlight(ls, wt);
    showToast(`Loadsheet approved for ${ls.flightNumber}${hook ? ` · load factor confirmed at ${hook.loadFactorPercent}%` : ''}`, 'success');
    showModule('loadsheet');
  };
}

/* ── seed 5 loadsheets across DRAFT / PREPARED (valid + invalid) /
   APPROVED / SUPERSEDED_BY_LMC, matching the "real data to demonstrate the
   re-approval flow" requirement — every computed field below is produced
   by the pure calc functions above, not hand-typed */
function seedLoadsheets() {
  if (getLoadsheets().length) return;
  const flights = getFlights(); if (!flights.length) return;
  const now = Date.now(); const iso = ms => new Date(ms).toISOString(); const ago = h => iso(now - h * 3600000);
  const byNum = num => flights.find(f => f.flightNumber === num);

  function base(f, over) {
    const ref = lsRefFor(f.aircraftType);
    return Object.assign(buildFreshLoadsheet(f), over);
  }

  const seeds = [];

  /* PK-301 · Airbus A320 · DRAFT */
  const pk301 = byNum('PK-301');
  if (pk301) seeds.push(base(pk301, {
    acReg: 'AP-301', crew: '2 / 4', to: 'LHE', originator: '', initials: '', priorityAddresses: 'MUXOPXH',
    weightBuildup: { basicWeight: 42000, crewWeight: 600, pantryWeight: 700, takeoffFuel: 8000, tripFuel: 6000, maxZeroFuelWeight: 62500, maxTakeoffWeight: 78000, maxLandingWeight: 66000 },
    destinations: [{ dest: 'LHE', pax: { male: 55, female: 45, child: 15, infant: 5 }, cabBag: 250, distributionWeights: [300, 250, 200, 0, 0, 0], rows: { tr: 100, b: 650, c: 200, m: 50 }, remarks: { pax: 'Y', pad: 'N' } }],
    notes: 'Standard load, no special handling.',
    loadAndTrim: { dryOperatingWeightHArm: 1000.0, weightDeviation: { E: 0, F: 0, G: 0, H: 0 } }
  }));

  /* PA-204 · Boeing 777-200ER · PREPARED — deliberately overloaded, demonstrates the blocking validation */
  const pa204 = byNum('PA-204');
  if (pa204) seeds.push(base(pa204, {
    acReg: 'A6-204', crew: '2 / 6', to: 'JED', originator: 'Bilal Ahmed', initials: 'BA', priorityAddresses: 'MUXOPXH JEDOPXH',
    status: 'PREPARED', preparedBy: 'Bilal Ahmed', preparedByUserId: null, preparedAt: ago(3),
    weightBuildup: { basicWeight: 138000, crewWeight: 1200, pantryWeight: 3000, takeoffFuel: 45000, tripFuel: 38000, maxZeroFuelWeight: 195000, maxTakeoffWeight: 297500, maxLandingWeight: 213000 },
    destinations: [{ dest: 'JED', pax: { male: 140, female: 110, child: 20, infant: 10 }, cabBag: 2000, distributionWeights: [8500, 7500, 7500, 6500, 0, 0], rows: { tr: 2000, b: 20000, c: 8000, m: 2000 }, remarks: { pax: 'Y', pad: 'Y' } }],
    notes: 'Overweight — awaiting load reduction before this can be approved.',
    loadAndTrim: { dryOperatingWeightHArm: 1000.0, weightDeviation: { E: 0, F: 0, G: 0, H: 0 } }
  }));

  /* PK-305 · Boeing 747-400 (Hajj Peak) · APPROVED — clean, risk-engine hook applied */
  const pk305 = byNum('PK-305');
  if (pk305) seeds.push(base(pk305, {
    acReg: 'AP-305', crew: '3 / 8', to: 'JED', originator: 'Sana Malik', initials: 'SM', priorityAddresses: 'MUXOPXH JEDOPXH',
    status: 'APPROVED', preparedBy: 'Ayesha Raza', preparedByUserId: null, preparedAt: ago(6),
    approvedBy: 'Sana Malik', approvedByUserId: null, approvedAt: ago(5),
    weightBuildup: { basicWeight: 180000, crewWeight: 1800, pantryWeight: 4500, takeoffFuel: 60000, tripFuel: 50000, maxZeroFuelWeight: 242000, maxTakeoffWeight: 396890, maxLandingWeight: 285760 },
    destinations: [{ dest: 'JED', pax: { male: 150, female: 130, child: 70, infant: 20 }, cabBag: 2500, distributionWeights: [4000, 3800, 3600, 3400, 3000, 0], rows: { tr: 2300, b: 12000, c: 5000, m: 1000 }, remarks: { pax: 'Y', pad: 'N' } }],
    notes: 'Hajj charter — full catering config.',
    loadAndTrim: { dryOperatingWeightHArm: 1000.0, weightDeviation: { E: 50, F: -30, G: 20, H: 80 } }
  }));

  /* 9P-220 · Airbus A321 · SUPERSEDED_BY_LMC — approved, then a late LMC pushed it over allowed traffic load by 50kg */
  const p220 = byNum('9P-220');
  if (p220) seeds.push(base(p220, {
    acReg: '9P-220', crew: '2 / 5', to: 'DXB', originator: 'Ayesha Raza', initials: 'AR', priorityAddresses: 'MUXOPXH DXBOPXH',
    status: 'SUPERSEDED_BY_LMC', preparedBy: 'Ayesha Raza', preparedByUserId: null, preparedAt: ago(4),
    approvedBy: 'Sana Malik', approvedByUserId: null, approvedAt: ago(3),
    weightBuildup: { basicWeight: 45500, crewWeight: 700, pantryWeight: 800, takeoffFuel: 9500, tripFuel: 7200, maxZeroFuelWeight: 68000, maxTakeoffWeight: 89000, maxLandingWeight: 77800 },
    destinations: [{ dest: 'DXB', pax: { male: 90, female: 80, child: 30, infant: 10 }, cabBag: 800, distributionWeights: [1200, 1100, 900, 0, 0, 0], rows: { tr: 400, b: 2800, c: 700, m: 100 }, remarks: { pax: 'Y', pad: 'N' } }],
    notes: 'Late cargo tender received after approval — see LMC.',
    lastMinuteChanges: [{ dest: 'DXB', specification: 'Late cargo tender — engine part', compartment: '2', weightDelta: 150, enteredBy: 'Bilal Ahmed', enteredAt: ago(1) }],
    loadAndTrim: { dryOperatingWeightHArm: 1000.0, weightDeviation: { E: 0, F: 0, G: 40, H: 60 } }
  }));

  /* ER-540 · Airbus A330-300 · PREPARED — clean, awaiting approval */
  const er540 = byNum('ER-540');
  if (er540) seeds.push(base(er540, {
    acReg: 'ER-540', crew: '2 / 6', to: 'DXB', originator: 'Ayesha Raza', initials: 'AR', priorityAddresses: 'MUXOPXH DXBOPXH',
    status: 'PREPARED', preparedBy: 'Ayesha Raza', preparedByUserId: null, preparedAt: ago(2),
    weightBuildup: { basicWeight: 122000, crewWeight: 1100, pantryWeight: 2600, takeoffFuel: 38000, tripFuel: 31000, maxZeroFuelWeight: 170000, maxTakeoffWeight: 242000, maxLandingWeight: 187000 },
    destinations: [{ dest: 'DXB', pax: { male: 120, female: 100, child: 50, infant: 10 }, cabBag: 1000, distributionWeights: [3000, 2800, 2600, 2400, 0, 0], rows: { tr: 1000, b: 8000, c: 2300, m: 500 }, remarks: { pax: 'Y', pad: 'N' } }],
    notes: 'Standard load, awaiting supervisor approval.',
    loadAndTrim: { dryOperatingWeightHArm: 1000.0, weightDeviation: { E: 20, F: 0, G: 0, H: 0 } }
  }));

  saveLoadsheets(seeds);

  /* the two sheets that reached APPROVED historically (PK-305, and 9P-220
     before its LMC) already fed the risk engine at the time — apply that
     same hook now so the seed data is internally consistent on first load */
  [pk305, p220].filter(Boolean).forEach(f => {
    const rec = seeds.find(s => s.flightId === f.id);
    if (rec) applyLoadsheetToFlight(rec, computeWeightTotals(rec));
  });
}

document.addEventListener('DOMContentLoaded', init);
