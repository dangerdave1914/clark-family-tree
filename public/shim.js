// Connects the tree page (index.html) to this site's API.
// The tree page was first built for claude.ai, where it talks to `claude.use('db'|'user'|'assets')`.
// This file provides the same three things, backed by the Cloudflare Worker, so the page itself
// doesn't need to change.  Load it BEFORE the page's main script.
(function () {
  const ADMIN_KEY = 'clarkTreeAdmin';
  let adminToken = null;
  try { adminToken = sessionStorage.getItem(ADMIN_KEY) || localStorage.getItem(ADMIN_KEY); } catch (e) {}
  const authHeaders = () => (adminToken ? { authorization: 'Bearer ' + adminToken } : {});

  async function api(path, opts = {}) {
    const res = await fetch(path, { ...opts, headers: { ...(opts.headers || {}), ...authHeaders() }, credentials: 'same-origin' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error(data.error || 'Something went wrong. Try again.'); e.status = res.status; throw e; }
    return data;
  }

  // ---- tree data, shared by every "collection" listener ----
  let tree = null, loading = null;
  const listeners = { people: [], unions: [], heirlooms: [], gallery: [], submissions: [] };
  function snapshot(col) {
    const obj = (tree && tree[col]) || {};
    const docs = Object.entries(obj).map(([id, v]) => ({ id, exists: true, data: () => v, metadata: { fromCache: false, hasPendingWrites: false } }));
    return { docs, size: docs.length, empty: !docs.length, metadata: { fromCache: false, hasPendingWrites: false }, docChanges: () => [] };
  }
  function emitAll() { for (const col in listeners) for (const [cb] of listeners[col]) cb(snapshot(col)); }
  async function refresh() {
    try {
      tree = await api('/api/tree'); tree.submissions = {};
      if (adminToken) { try { const r = await api('/api/admin/submissions'); for (const x of r.submissions) tree.submissions[x.id] = x; } catch (e) {} }
      emitAll();
    }
    catch (e) {
      if (e.status === 401) { location.href = '/join?next=' + encodeURIComponent(location.pathname); return; }
      for (const col in listeners) for (const [, err] of listeners[col]) err && err({ code: 'unavailable', message: e.message });
    }
  }
  function ensureLoaded() { if (!loading) loading = refresh(); return loading; }

  const COLLECTIONS = new Set(['people', 'unions', 'heirlooms', 'gallery']);
  const genId = (col) => ({ people: 'p', unions: 'u', heirlooms: 'h', gallery: 'g', submissions: 's' }[col] || 'x') + '-' + crypto.randomUUID().replace(/-/g, '').slice(0, 14);

  async function write(col, op, id, data) {
    if (!COLLECTIONS.has(col)) throw new Error('Not allowed.');
    if (!adminToken) throw new Error('Only the family organizer can change the tree directly. Your entry can be sent for review instead.');
    await api('/api/admin/write', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ops: [{ col, op, id, data }] }) });
    loading = refresh(); await loading;
  }

  function collection(col) {
    return {
      path: col,
      onSnapshot(next, error) {
        const entry = [next, error];
        (listeners[col] = listeners[col] || []).push(entry);
        if (tree) setTimeout(() => next(snapshot(col)), 0); else ensureLoaded();
        return () => { const l = listeners[col]; const i = l.indexOf(entry); if (i >= 0) l.splice(i, 1); };
      },
      doc(id) {
        const docId = id || genId(col);
        return {
          id: docId, path: col + '/' + docId,
          set: (data) => write(col, 'set', docId, data),
          update: (data) => write(col, 'update', docId, data),
          delete: () => write(col, 'delete', docId),
          get: async () => { await ensureLoaded(); const v = tree[col] && tree[col][docId]; return { id: docId, exists: !!v, data: () => v }; },
        };
      },
      async add(data) {
        if (col === 'submissions') {
          const who = (function () { try { return localStorage.getItem('clarkTreeName'); } catch (e) { return null; } })();
          const r = await api('/api/submissions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...data, submitter: data.submitter || who }) });
          return { id: r.id };
        }
        const id = genId(col); await write(col, 'set', id, data); return { id };
      },
    };
  }
  const db = { collection, doc: (p) => { const [c, id] = p.split('/'); return collection(c).doc(id); } };

  const user = {
    isOwner: () => !!adminToken, canEdit: () => !!adminToken, can: () => true,
    id: async () => null, me: async () => ({ id: null }),
    // Heirloom "attested by" values are stored as the person's name, so a name lookup is the identity.
    profiles: async (ids) => Object.fromEntries((ids || []).map((i) => [i, { name: i || '' }])),
  };

  // Phones take very large photos; shrink before upload so the family's photos stay quick to load.
  async function shrink(file, max = 1280, quality = 0.84) {
    try {
      const bmp = await createImageBitmap(file);
      const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
      const c = document.createElement('canvas'); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
      c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
      return await new Promise((ok) => c.toBlob(ok, 'image/jpeg', quality));
    } catch (e) { return file; }
  }
  const assets = {
    async upload(file) {
      const blob = await shrink(file);
      const r = await api('/api/photos', { method: 'POST', headers: { 'content-type': blob.type || 'image/jpeg' }, body: blob });
      return { id: r.id, url: '/_blob/' + r.id };
    },
  };
  window.ClarkTree = { api, shrink, refresh: () => { loading = refresh(); return loading; }, isAdmin: () => !!adminToken };
  window.claude = { use: async (name) => (name === 'db' ? db : name === 'user' ? user : name === 'assets' ? assets : null) };

  // Organizer: the "Review" button opens the review page; show how many entries are waiting.
  document.addEventListener('DOMContentLoaded', () => {
    const add = document.getElementById('addSelfBtn');
    if (add) add.classList.remove('hidden');
    if (!adminToken) return;
    const btn = document.getElementById('reviewBtn');
    if (btn) {
      btn.onclick = (e) => { e.preventDefault(); e.stopImmediatePropagation(); location.href = '/admin'; };
    }
  });
})();
