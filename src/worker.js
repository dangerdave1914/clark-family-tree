// Clark Family Tree — Cloudflare Worker
// Serves the static site (public/) and a small JSON API backed by D1.
//
// Who can do what
//   Family members  — anyone who opened the family link / QR code (it sets a cookie).
//                     They can read the tree and SUBMIT additions. Nothing they send
//                     appears on the tree until the organizer approves it.
//   Organizer       — sends `Authorization: Bearer <ADMIN_TOKEN>`. Approves/declines
//                     submissions and can edit the tree directly.
//
// Secrets (set in the Cloudflare dashboard or with `wrangler secret put`):
//   FAMILY_CODE  — the code inside the family link / QR code
//   ADMIN_TOKEN  — the organizer's password for /admin

// The pages are built into the Worker (no separate static-assets upload to go missing).
import indexHtml from '../public/index.html';
import joinHtml from '../public/join.html';
import addHtml from '../public/add.html';
import adminHtml from '../public/admin.html';
import familyCss from '../public/family.css';
import shimJs from '../public/shim.js';

const PAGES = {
  '/': [indexHtml, 'text/html; charset=utf-8'], '/index.html': [indexHtml, 'text/html; charset=utf-8'],
  '/join': [joinHtml, 'text/html; charset=utf-8'], '/join.html': [joinHtml, 'text/html; charset=utf-8'],
  '/add': [addHtml, 'text/html; charset=utf-8'], '/add.html': [addHtml, 'text/html; charset=utf-8'],
  '/admin': [adminHtml, 'text/html; charset=utf-8'], '/admin.html': [adminHtml, 'text/html; charset=utf-8'],
  '/family.css': [familyCss, 'text/css; charset=utf-8'],
  '/shim.js': [shimJs, 'text/javascript; charset=utf-8'],
};
const PAGE_HEADERS = { 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin', 'x-robots-tag': 'noindex' };

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...headers } });
const fail = (message, status = 400) => json({ error: message }, status);
const newId = (prefix) => `${prefix}-${crypto.randomUUID().replace(/-/g, '').slice(0, 14)}`;

const PERSON_FIELDS = ['first', 'last', 'nick', 'born', 'died', 'notes', 'verify', 'photo'];
const MAX_PHOTO_BYTES = 1_500_000; // the pages shrink photos before upload; this is a safety cap
const MAX_SUBMISSION_BYTES = 20_000;
const SUBMISSION_KINDS = new Set(['intake', 'person', 'edit', 'heirloom', 'link']);

// ---------- auth helpers ----------
async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
const normalizeCode = (c) => String(c || '').trim().toUpperCase().replace(/[\s-]/g, '');
async function memberCookieValue(env) { return hmacHex(normalizeCode(env.FAMILY_CODE), 'clark-family-member-v1'); }
function readCookie(request, name) {
  const raw = request.headers.get('cookie') || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}
async function isMember(request, env) {
  if (!env.FAMILY_CODE) return false;
  const c = readCookie(request, 'fam');
  return !!c && safeEqual(c, await memberCookieValue(env));
}
function isAdmin(request, env) {
  if (!env.ADMIN_TOKEN) return false;
  const h = request.headers.get('authorization') || '';
  return h.startsWith('Bearer ') && safeEqual(h.slice(7), env.ADMIN_TOKEN);
}

// ---------- data helpers ----------
const clean = (v, max = 2000) => (v === undefined || v === null ? null : String(v).trim().slice(0, max) || null);
function personRow(r) {
  const o = { first: r.first, last: r.last };
  for (const k of ['nick', 'born', 'died', 'notes', 'verify', 'photo']) if (r[k]) o[k] = r[k];
  if (r.parent_union) o.parentUnion = r.parent_union;
  if (r.ord !== null && r.ord !== undefined) o.order = r.ord;
  return o;
}
async function loadTree(env) {
  const [p, u, h] = await env.DB.batch([
    env.DB.prepare('SELECT * FROM people'),
    env.DB.prepare('SELECT * FROM unions'),
    env.DB.prepare('SELECT * FROM heirlooms ORDER BY created_at'),
  ]);
  const people = {}, unions = {}, heirlooms = {};
  for (const r of p.results) people[r.id] = personRow(r);
  for (const r of u.results) { const o = { a: r.a, b: r.b }; if (r.notes) o.notes = r.notes; if (r.ord !== null) o.order = r.ord; unions[r.id] = o; }
  for (const r of h.results) heirlooms[r.id] = { person: r.person, title: r.title, story: r.story, photo: r.photo, by: r.attested_by, at: r.created_at };
  return { people, unions, heirlooms };
}
async function getPerson(env, id) { return id ? env.DB.prepare('SELECT * FROM people WHERE id=?').bind(id).first() : null; }
async function getUnion(env, id) { return id ? env.DB.prepare('SELECT * FROM unions WHERE id=?').bind(id).first() : null; }
async function insertPerson(env, id, data, parentUnion) {
  await env.DB.prepare('INSERT INTO people (id,first,last,nick,born,died,notes,verify,photo,parent_union,ord,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,NULL,?)')
    .bind(id, clean(data.first, 80) || 'Unnamed', clean(data.last, 80), clean(data.nick, 80), clean(data.born, 10), clean(data.died, 10),
      clean(data.notes), clean(data.verify, 500), clean(data.photo, 80), parentUnion || null, Date.now()).run();
}
async function approvePhotos(env, ids) {
  for (const pid of ids.filter(Boolean)) await env.DB.prepare('UPDATE photos SET approved=1 WHERE id=?').bind(pid).run();
}
const addNote = (base, extra) => [base, extra].filter(Boolean).join('\n');

// Mirrors the tree page's own "add relative" rules.
async function applyRelative(env, rel, anchorId, unionChoice, data) {
  const pid = newId('p');
  if (!rel) { await insertPerson(env, pid, data, null); return pid; }
  const anchor = await getPerson(env, anchorId);
  if (!anchor) throw new Error('That relative is no longer on the tree.');
  if (rel === 'child') {
    let uid = unionChoice && unionChoice !== '__new' && (await getUnion(env, unionChoice)) ? unionChoice : null;
    if (!uid) { uid = newId('u'); await env.DB.prepare('INSERT INTO unions (id,a,b) VALUES (?,?,NULL)').bind(uid, anchorId).run(); }
    await insertPerson(env, pid, data, uid);
  } else if (rel === 'spouse') {
    await insertPerson(env, pid, data, null);
    await env.DB.prepare('INSERT INTO unions (id,a,b) VALUES (?,?,?)').bind(newId('u'), anchorId, pid).run();
  } else if (rel === 'parent') {
    const u = await getUnion(env, anchor.parent_union);
    if (u) {
      const slot = !u.a ? 'a' : !u.b ? 'b' : null;
      if (!slot) throw new Error('This person already has two parents recorded.');
      await insertPerson(env, pid, data, null);
      await env.DB.prepare(`UPDATE unions SET ${slot}=? WHERE id=?`).bind(pid, u.id).run();
    } else {
      await insertPerson(env, pid, data, null);
      const uid = newId('u');
      await env.DB.prepare('INSERT INTO unions (id,a,b) VALUES (?,?,NULL)').bind(uid, pid).run();
      await env.DB.prepare('UPDATE people SET parent_union=? WHERE id=?').bind(uid, anchorId).run();
    }
  } else if (rel === 'sibling') {
    let uid = anchor.parent_union && (await getUnion(env, anchor.parent_union)) ? anchor.parent_union : null;
    if (!uid) {
      uid = newId('u');
      await env.DB.prepare("INSERT INTO unions (id,a,b,notes) VALUES (?,NULL,NULL,'Parents unknown')").bind(uid).run();
      await env.DB.prepare('UPDATE people SET parent_union=? WHERE id=?').bind(uid, anchorId).run();
    }
    await insertPerson(env, pid, data, uid);
  } else throw new Error('Unknown relationship.');
  return pid;
}

// ---------- linking people who are already on the tree ----------
// rel says what TARGET is to ANCHOR: 'parent' | 'child' | 'spouse' | 'sibling' | 'same' | 'other'
const fullName = (p) => (p ? `${p.first || ''} ${p.last || ''}`.trim() : 'someone');
async function ancestorsOf(env, id, seen = new Set()) {
  const p = await getPerson(env, id);
  if (!p || !p.parent_union) return seen;
  const u = await getUnion(env, p.parent_union);
  for (const q of [u && u.a, u && u.b]) if (q && !seen.has(q)) { seen.add(q); await ancestorsOf(env, q, seen); }
  return seen;
}
async function unionOf(env, x, y) {
  return env.DB.prepare('SELECT * FROM unions WHERE (a=?1 AND b=?2) OR (a=?2 AND b=?1)').bind(x, y).first();
}
// Remove unions that no longer mean anything: no children and fewer than two partners.
async function tidyUnions(env) {
  await env.DB.prepare(`DELETE FROM unions WHERE (a IS NULL OR b IS NULL)
    AND id NOT IN (SELECT parent_union FROM people WHERE parent_union IS NOT NULL)`).run();
}
async function linkChild(env, parentId, childId, unionChoice) {
  if (parentId === childId) throw new Error('Someone can’t be their own parent.');
  if ((await ancestorsOf(env, parentId)).has(childId)) throw new Error('That would make someone their own ancestor. Check who is the parent and who is the child.');
  const parent = await getPerson(env, parentId), child = await getPerson(env, childId);
  let chosen = unionChoice && unionChoice !== '__alone' ? await getUnion(env, unionChoice) : null;
  if (chosen && chosen.a !== parentId && chosen.b !== parentId) chosen = null;
  const cu = child.parent_union ? await getUnion(env, child.parent_union) : null;
  if (cu) {
    const partners = [cu.a, cu.b].filter(Boolean);
    if (partners.includes(parentId) && (!chosen || chosen.id === cu.id)) return 'already';
    // The child's current parents all belong to the chosen couple: move the child to that couple.
    if (chosen && partners.every((q) => q === chosen.a || q === chosen.b)) {
      await env.DB.prepare('UPDATE people SET parent_union=? WHERE id=?').bind(chosen.id, childId).run();
      return 'moved';
    }
    // The child has room for another parent: add this one.
    if (partners.length < 2 && !partners.includes(parentId)) {
      const slot = !cu.a ? 'a' : 'b';
      const other = partners[0];
      // If these two parents are already a couple elsewhere, use that couple instead of a second one.
      const existing = other ? await unionOf(env, parentId, other) : null;
      if (existing) await env.DB.prepare('UPDATE people SET parent_union=? WHERE id=?').bind(existing.id, childId).run();
      else await env.DB.prepare(`UPDATE unions SET ${slot}=? WHERE id=?`).bind(parentId, cu.id).run();
      return 'added';
    }
    const names = await Promise.all(partners.map((q) => getPerson(env, q)));
    throw new Error(`${fullName(child)} already has two parents recorded (${names.map(fullName).join(' and ')}). Fix those first.`);
  }
  let uid = chosen && chosen.id;
  if (!uid) {
    const solo = await env.DB.prepare('SELECT id FROM unions WHERE (a=?1 AND b IS NULL) OR (b=?1 AND a IS NULL)').bind(parentId).first();
    uid = solo ? solo.id : newId('u');
    if (!solo) await env.DB.prepare('INSERT INTO unions (id,a,b) VALUES (?,?,NULL)').bind(uid, parentId).run();
  }
  await env.DB.prepare('UPDATE people SET parent_union=? WHERE id=?').bind(uid, childId).run();
  return 'linked';
}
async function mergePeople(env, keepId, dupId) {
  if (keepId === dupId) throw new Error('That’s the same entry.');
  const keep = await getPerson(env, keepId), dup = await getPerson(env, dupId);
  // Fill gaps in the kept record from the duplicate.
  const sets = [], vals = [];
  for (const k of ['last', 'nick', 'born', 'died', 'notes', 'photo']) if (!keep[k] && dup[k]) { sets.push(`${k}=?`); vals.push(dup[k]); }
  if (!keep.parent_union && dup.parent_union) { sets.push('parent_union=?'); vals.push(dup.parent_union); }
  else if (keep.parent_union && dup.parent_union && keep.parent_union !== dup.parent_union) {
    const a = await getUnion(env, keep.parent_union), b = await getUnion(env, dup.parent_union);
    const pa = [a && a.a, a && a.b].filter(Boolean), pb = [b && b.a, b && b.b].filter(Boolean);
    if (pb.length > pa.length) { sets.push('parent_union=?'); vals.push(dup.parent_union); }
  }
  if (sets.length) await env.DB.prepare(`UPDATE people SET ${sets.join(',')} WHERE id=?`).bind(...vals, keepId).run();
  // Re-point the duplicate's marriages and keepsakes.
  for (const col of ['a', 'b']) {
    const rows = (await env.DB.prepare(`SELECT * FROM unions WHERE ${col}=?`).bind(dupId).all()).results;
    for (const u of rows) {
      const other = col === 'a' ? u.b : u.a;
      const same = other ? await unionOf(env, keepId, other) : null;
      if (other === keepId) { await env.DB.prepare(`UPDATE unions SET ${col}=NULL WHERE id=?`).bind(u.id).run(); continue; }
      if (same && same.id !== u.id) {
        await env.DB.prepare('UPDATE people SET parent_union=? WHERE parent_union=?').bind(same.id, u.id).run();
        await env.DB.prepare('DELETE FROM unions WHERE id=?').bind(u.id).run();
      } else await env.DB.prepare(`UPDATE unions SET ${col}=? WHERE id=?`).bind(keepId, u.id).run();
    }
  }
  await env.DB.prepare('UPDATE heirlooms SET person=? WHERE person=?').bind(keepId, dupId).run();
  await env.DB.prepare('DELETE FROM people WHERE id=?').bind(dupId).run();
  return 'merged';
}
async function applyLink(env, s) {
  const anchorId = s.anchor, targetId = s.target;
  const anchor = await getPerson(env, anchorId);
  if (!anchor) throw new Error('That person is no longer on the tree.');
  if (s.rel === 'other') {
    const note = `Says they are related to ${clean(s.text, 300) || 'someone'}${s.target ? '' : ''} — needs placing.`;
    await env.DB.prepare('UPDATE people SET verify=? WHERE id=?').bind(addNote(anchor.verify, note), anchorId).run();
    return 'noted';
  }
  const target = await getPerson(env, targetId);
  if (!target) throw new Error('The person they picked is no longer on the tree.');
  let r;
  if (s.rel === 'parent') r = await linkChild(env, targetId, anchorId, s.union);
  else if (s.rel === 'child') r = await linkChild(env, anchorId, targetId, s.union);
  else if (s.rel === 'spouse') {
    if (anchorId === targetId) throw new Error('Someone can’t marry themselves.');
    if (await unionOf(env, anchorId, targetId)) r = 'already';
    else {
      // If one of them is a lone parent, make that the couple so existing children get both parents.
      const solo = await env.DB.prepare('SELECT id,a,b FROM unions WHERE ((a=?1 AND b IS NULL) OR (b=?1 AND a IS NULL)) AND id IN (SELECT parent_union FROM people)').bind(anchorId).first();
      if (solo && s.shareChildren) await env.DB.prepare(`UPDATE unions SET ${solo.a ? 'b' : 'a'}=? WHERE id=?`).bind(targetId, solo.id).run();
      else await env.DB.prepare('INSERT INTO unions (id,a,b) VALUES (?,?,?)').bind(newId('u'), anchorId, targetId).run();
      r = 'linked';
    }
  } else if (s.rel === 'sibling') {
    if (anchorId === targetId) throw new Error('That’s the same person.');
    const ua = anchor.parent_union, ut = target.parent_union;
    if (ua && ut && ua === ut) r = 'already';
    else if (ua && !ut) { await env.DB.prepare('UPDATE people SET parent_union=? WHERE id=?').bind(ua, targetId).run(); r = 'linked'; }
    else if (!ua && ut) { await env.DB.prepare('UPDATE people SET parent_union=? WHERE id=?').bind(ut, anchorId).run(); r = 'linked'; }
    else if (!ua && !ut) {
      const uid = newId('u');
      await env.DB.prepare("INSERT INTO unions (id,a,b,notes) VALUES (?,NULL,NULL,'Parents unknown')").bind(uid).run();
      await env.DB.batch([env.DB.prepare('UPDATE people SET parent_union=? WHERE id=?').bind(uid, anchorId), env.DB.prepare('UPDATE people SET parent_union=? WHERE id=?').bind(uid, targetId)]);
      r = 'linked';
    } else {
      const a = await getUnion(env, ua), t = await getUnion(env, ut);
      const na = [a.a, a.b].filter(Boolean).length, nt = [t.a, t.b].filter(Boolean).length;
      if (na === 0) { await env.DB.prepare('UPDATE people SET parent_union=? WHERE parent_union=?').bind(ut, ua).run(); r = 'linked'; }
      else if (nt === 0) { await env.DB.prepare('UPDATE people SET parent_union=? WHERE parent_union=?').bind(ua, ut).run(); r = 'linked'; }
      else throw new Error('They each already have different parents recorded. Link them through their parents instead.');
    }
  } else if (s.rel === 'same') r = await mergePeople(env, targetId, anchorId);
  else throw new Error('Unknown relationship.');
  await tidyUnions(env);
  return r;
}

// The guided "add yourself" form: one person plus who their parents / spouse are.
async function applyIntake(env, s, submitter) {
  const person = s.person || {};
  const checks = [];
  const parents = (Array.isArray(s.parents) ? s.parents : []).filter(Boolean).slice(0, 2);
  for (const p of parents) if (!(await getPerson(env, p))) throw new Error('A parent they picked is no longer on the tree.');
  let parentUnion = null;
  if (parents.length === 2) {
    const u = await env.DB.prepare('SELECT id FROM unions WHERE (a=?1 AND b=?2) OR (a=?2 AND b=?1)').bind(parents[0], parents[1]).first();
    if (u) parentUnion = u.id;
    else { parentUnion = newId('u'); await env.DB.prepare('INSERT INTO unions (id,a,b) VALUES (?,?,?)').bind(parentUnion, parents[0], parents[1]).run(); }
  } else if (parents.length === 1) {
    const us = (await env.DB.prepare('SELECT * FROM unions WHERE a=?1 OR b=?1').bind(parents[0]).all()).results;
    if (us.length === 1) {
      parentUnion = us[0].id;
      const other = us[0].a === parents[0] ? us[0].b : us[0].a;
      if (other) { const o = await getPerson(env, other); checks.push(`Only one parent was picked; placed under ${o ? `${o.first} ${o.last || ''}`.trim() : 'their recorded partner'} as the other parent.`); }
    } else {
      parentUnion = newId('u');
      await env.DB.prepare('INSERT INTO unions (id,a,b) VALUES (?,?,NULL)').bind(parentUnion, parents[0]).run();
      if (us.length > 1) checks.push('Only one parent was picked and that parent had more than one partner — confirm the other parent.');
    }
  }
  if (s.motherText) checks.push(`Mother named as "${clean(s.motherText, 120)}" (not on the tree yet).`);
  if (s.fatherText) checks.push(`Father named as "${clean(s.fatherText, 120)}" (not on the tree yet).`);
  if (s.spouseText) checks.push(`Spouse named as "${clean(s.spouseText, 120)}" (not on the tree yet).`);
  const pid = newId('p');
  await insertPerson(env, pid, { ...person, verify: checks.join(' ') || null, notes: person.notes }, parentUnion);
  if (s.spouse && (await getPerson(env, s.spouse))) await env.DB.prepare('INSERT INTO unions (id,a,b) VALUES (?,?,?)').bind(newId('u'), s.spouse, pid).run();
  if (s.heirloom && clean(s.heirloom.title, 200)) {
    await env.DB.prepare('INSERT INTO heirlooms (id,person,title,story,photo,attested_by,created_at) VALUES (?,?,?,?,?,?,?)')
      .bind(newId('h'), pid, clean(s.heirloom.title, 200), clean(s.heirloom.story, 5000), clean(s.heirloom.photo, 80), submitter, Date.now()).run();
  }
  await approvePhotos(env, [person.photo, s.heirloom && s.heirloom.photo]);
  return pid;
}

async function approveSubmission(env, sub) {
  const s = JSON.parse(sub.payload);
  const who = sub.submitter || 'a family member';
  if (sub.kind === 'intake') return applyIntake(env, s, who);
  if (sub.kind === 'link') { if (s.rel === 'same') throw new Error('Only the organizer can merge duplicates.'); await applyLink(env, s); return s.anchor; }
  if (sub.kind === 'person') { const id = await applyRelative(env, s.rel, s.anchor, s.union, s.data || {}); await approvePhotos(env, [s.data && s.data.photo]); return id; }
  if (sub.kind === 'edit') {
    if (!(await getPerson(env, s.anchor))) throw new Error('That person is no longer on the tree.');
    const sets = [], vals = [];
    for (const k of PERSON_FIELDS) if (s.data && typeof s.data[k] === 'string' && s.data[k].trim()) { sets.push(`${k}=?`); vals.push(clean(s.data[k])); }
    if (sets.length) await env.DB.prepare(`UPDATE people SET ${sets.join(',')} WHERE id=?`).bind(...vals, s.anchor).run();
    await approvePhotos(env, [s.data && s.data.photo]);
    return s.anchor;
  }
  if (sub.kind === 'heirloom') {
    const d = s.data || {}; const person = s.anchor || d.person;
    if (!(await getPerson(env, person))) throw new Error('That person is no longer on the tree.');
    await env.DB.prepare('INSERT INTO heirlooms (id,person,title,story,photo,attested_by,created_at) VALUES (?,?,?,?,?,?,?)')
      .bind(newId('h'), person, clean(d.title, 200), clean(d.story, 5000), clean(d.photo, 80), who, Date.now()).run();
    await approvePhotos(env, [d.photo]);
    return person;
  }
  throw new Error('Unknown entry type.');
}

// Direct edits by the organizer from the tree page (add / edit / remove).
const WRITABLE = {
  people: { cols: ['first', 'last', 'nick', 'born', 'died', 'notes', 'verify', 'photo', 'parentUnion', 'order'], map: { parentUnion: 'parent_union', order: 'ord' } },
  unions: { cols: ['a', 'b', 'notes', 'order'], map: { order: 'ord' } },
  heirlooms: { cols: ['person', 'title', 'story', 'photo', 'by', 'at'], map: { by: 'attested_by', at: 'created_at' } },
};
async function adminWrite(env, op) {
  const spec = WRITABLE[op.col];
  if (!spec || typeof op.id !== 'string' || !/^[\w.-]{1,80}$/.test(op.id)) throw new Error('Bad write.');
  if (op.op === 'delete') { await env.DB.prepare(`DELETE FROM ${op.col} WHERE id=?`).bind(op.id).run(); return; }
  const data = op.data || {};
  const cols = Object.keys(data).filter((k) => spec.cols.includes(k));
  const dbCols = cols.map((k) => spec.map[k] || k);
  const vals = cols.map((k) => (data[k] === null || data[k] === undefined || data[k] === '' ? null : typeof data[k] === 'number' ? data[k] : String(data[k]).slice(0, 5000)));
  if (op.op === 'set') {
    await env.DB.prepare(`DELETE FROM ${op.col} WHERE id=?`).bind(op.id).run();
    const extra = op.col === 'people' ? ',created_at' : '';
    await env.DB.prepare(`INSERT INTO ${op.col} (id${dbCols.map((c) => ',' + c).join('')}${extra}) VALUES (?${dbCols.map(() => ',?').join('')}${extra ? ',?' : ''})`)
      .bind(op.id, ...vals, ...(extra ? [Date.now()] : [])).run();
  } else if (op.op === 'update') {
    if (!cols.length) return;
    await env.DB.prepare(`UPDATE ${op.col} SET ${dbCols.map((c) => c + '=?').join(',')} WHERE id=?`).bind(...vals, op.id).run();
  } else throw new Error('Bad write.');
  if (op.col === 'people' && data.photo) await approvePhotos(env, [data.photo]);
  if (op.col === 'heirlooms' && data.photo) await approvePhotos(env, [data.photo]);
}

// ---------- router ----------
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    try {
      if (path === '/api/join' && method === 'POST') {
        const body = await request.json().catch(() => ({}));
        if (!env.FAMILY_CODE) return fail('The family code has not been set up yet.', 503);
        if (!safeEqual(normalizeCode(body.code), normalizeCode(env.FAMILY_CODE))) return fail('That code didn’t match. Check the card and try again.', 403);
        const v = await memberCookieValue(env);
        return json({ ok: true }, 200, { 'set-cookie': `fam=${v}; Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=Lax` });
      }
      if (path === '/api/me') return json({ member: await isMember(request, env), admin: isAdmin(request, env) });

      const member = await isMember(request, env);
      const admin = isAdmin(request, env);

      if (path === '/api/tree' && method === 'GET') {
        if (!member && !admin) return fail('Open the family link first.', 401);
        return json(await loadTree(env));
      }

      const blob = path.match(/^\/(?:api\/photos|_blob)\/([\w-]{1,80})$/);
      if (blob && method === 'GET') {
        if (!member && !admin) return fail('Open the family link first.', 401);
        const row = await env.DB.prepare('SELECT mime,data,approved FROM photos WHERE id=?').bind(blob[1]).first();
        if (!row || (!row.approved && !admin)) return new Response('Not found', { status: 404 });
        return new Response(new Uint8Array(row.data), { headers: { 'content-type': row.mime, 'cache-control': 'private, max-age=86400', 'x-content-type-options': 'nosniff' } });
      }

      if (path === '/api/photos' && method === 'POST') {
        if (!member && !admin) return fail('Open the family link first.', 401);
        const mime = (request.headers.get('content-type') || '').split(';')[0];
        if (!['image/jpeg', 'image/png', 'image/webp'].includes(mime)) return fail('Please send a photo (JPEG, PNG or WebP).');
        const buf = await request.arrayBuffer();
        if (!buf.byteLength) return fail('The photo was empty.');
        if (buf.byteLength > MAX_PHOTO_BYTES) return fail('That photo is too large.', 413);
        const id = newId('ph');
        await env.DB.prepare('INSERT INTO photos (id,mime,data,approved,created_at) VALUES (?,?,?,?,?)').bind(id, mime, buf, admin ? 1 : 0, Date.now()).run();
        return json({ id });
      }

      if (path === '/api/submissions' && method === 'POST') {
        if (!member && !admin) return fail('Open the family link first.', 401);
        const text = await request.text();
        if (text.length > MAX_SUBMISSION_BYTES) return fail('That entry is too long.', 413);
        let body; try { body = JSON.parse(text); } catch { return fail('Bad entry.'); }
        if (!SUBMISSION_KINDS.has(body.kind)) return fail('Bad entry type.');
        const submitter = clean(body.submitter, 100);
        const { submitter: _s, by: _b, at: _a, ...payload } = body;
        const id = newId('s');
        await env.DB.prepare("INSERT INTO submissions (id,kind,payload,submitter,status,created_at) VALUES (?,?,?,?,'pending',?)")
          .bind(id, body.kind, JSON.stringify(payload), submitter, Date.now()).run();
        return json({ ok: true, id });
      }

      // ----- organizer only -----
      if (path.startsWith('/api/admin/')) {
        if (!admin) return fail('Organizer password needed.', 401);
        if (path === '/api/admin/check') return json({ ok: true });
        if (path === '/api/admin/joinlink') return json({ code: env.FAMILY_CODE || null, url: `${url.origin}/join?code=${encodeURIComponent(env.FAMILY_CODE || '')}` });
        if (path === '/api/admin/submissions' && method === 'GET') {
          const rows = (await env.DB.prepare("SELECT * FROM submissions WHERE status='pending' ORDER BY created_at").all()).results;
          return json({ submissions: rows.map((r) => ({ id: r.id, kind: r.kind, submitter: r.submitter, at: r.created_at, payload: JSON.parse(r.payload) })) });
        }
        const act = path.match(/^\/api\/admin\/submissions\/([\w-]{1,80})\/(approve|decline)$/);
        if (act && method === 'POST') {
          const sub = await env.DB.prepare("SELECT * FROM submissions WHERE id=? AND status='pending'").bind(act[1]).first();
          if (!sub) return fail('That entry was already handled.', 404);
          let person = null;
          if (act[2] === 'approve') person = await approveSubmission(env, sub);
          await env.DB.prepare('UPDATE submissions SET status=? WHERE id=?').bind(act[2] === 'approve' ? 'approved' : 'declined', sub.id).run();
          return json({ ok: true, person });
        }
        if (path === '/api/admin/link' && method === 'POST') {
          const body = await request.json();
          const result = await applyLink(env, body);
          return json({ ok: true, result });
        }
        if (path === '/api/admin/write' && method === 'POST') {
          const body = await request.json();
          const ops = Array.isArray(body.ops) ? body.ops.slice(0, 20) : [];
          for (const op of ops) await adminWrite(env, op);
          return json({ ok: true });
        }
        return fail('Not found', 404);
      }

      if (path.startsWith('/api/')) return fail('Not found', 404);
      const page = PAGES[path] || PAGES[path.replace(/\/$/, '')];
      if (page && (method === 'GET' || method === 'HEAD')) return new Response(method === 'HEAD' ? null : page[0], { headers: { 'content-type': page[1], ...PAGE_HEADERS } });
      return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } });
    } catch (err) {
      return fail(err && err.message ? err.message : 'Something went wrong.', 500);
    }
  },
};
