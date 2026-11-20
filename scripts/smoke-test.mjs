// End-to-end check against a running `wrangler dev` (default http://localhost:8787).
// Uses the codes in .dev.vars. Run: npm run dev  (in one terminal), then npm test.
const BASE = process.env.BASE || 'http://localhost:8787';
const CODE = process.env.FAMILY_CODE || 'TESTCODE', ADMIN = process.env.ADMIN_TOKEN || 'local-admin-password';
let pass = 0, failures = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { failures++; console.log('  ✗', m); } };
const j = (r) => r.json();
const admin = { authorization: 'Bearer ' + ADMIN };

let r = await fetch(BASE + '/api/tree'); ok(r.status === 401, 'tree is closed without the family link');
r = await fetch(BASE + '/api/join', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: 'WRONG' }) });
ok(r.status === 403, 'wrong family code is refused');
r = await fetch(BASE + '/api/join', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: ' testcode ' }) });
const cookie = (r.headers.get('set-cookie') || '').split(';')[0]; ok(r.ok && cookie.startsWith('fam='), 'family code works (case and spaces ignored)');
const fam = { cookie };
const t0 = await (await fetch(BASE + '/api/tree', { headers: fam })).json();
ok(Object.keys(t0.people).length === 44 && Object.keys(t0.unions).length === 7, 'tree has 44 people and 7 marriages');
ok(t0.people['p-madison-clark'].parentUnion === 'u-anthony-mary', 'Madison is under Anthony & Mary');

r = await fetch(BASE + '/api/admin/submissions', { headers: fam }); ok(r.status === 401, 'family link cannot reach organizer pages');
r = await fetch(BASE + '/api/admin/write', { method: 'POST', headers: { ...fam, 'content-type': 'application/json' }, body: JSON.stringify({ ops: [{ col: 'people', op: 'delete', id: 'p-madison-clark' }] }) });
ok(r.status === 401, 'family link cannot delete anyone');

// tiny valid JPEG
const jpg = Uint8Array.from(atob('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q=='), (c) => c.charCodeAt(0));
r = await fetch(BASE + '/api/photos', { method: 'POST', headers: { ...fam, 'content-type': 'image/jpeg' }, body: jpg });
const ph = await r.json(); ok(r.ok && ph.id, 'photo uploads');
r = await fetch(BASE + '/_blob/' + ph.id, { headers: fam }); ok(r.status === 404, 'unapproved photo is hidden from family');
r = await fetch(BASE + '/api/photos', { method: 'POST', headers: { ...fam, 'content-type': 'text/html' }, body: '<script>' }); ok(r.status === 400, 'non-image upload refused');

const intake = { kind: 'intake', submitter: 'Test Helper', helper: true,
  person: { first: 'Test', last: 'Grandchild', born: '1990', photo: ph.id },
  parents: ['p-betty-clark'], mother: 'p-betty-clark', father: null, fatherText: 'John Doe', spouse: 'p-centennial-clark',
  heirloom: { title: 'Pocket watch', story: 'Came from Vredenburgh.', photo: null } };
r = await fetch(BASE + '/api/submissions', { method: 'POST', headers: { ...fam, 'content-type': 'application/json' }, body: JSON.stringify(intake) });
const sub = await r.json(); ok(r.ok && sub.id, 'guided entry is accepted for review');
const t1 = await (await fetch(BASE + '/api/tree', { headers: fam })).json();
ok(Object.keys(t1.people).length === 44, 'nothing appears on the tree before approval');

const list = await (await fetch(BASE + '/api/admin/submissions', { headers: admin })).json();
ok(list.submissions.some((s) => s.id === sub.id && s.submitter === 'Test Helper'), 'organizer sees the entry and who sent it');
r = await fetch(BASE + `/api/admin/submissions/${sub.id}/approve`, { method: 'POST', headers: admin });
const ap = await r.json(); ok(r.ok && ap.person, 'organizer approves');
r = await fetch(BASE + `/api/admin/submissions/${sub.id}/approve`, { method: 'POST', headers: admin }); ok(r.status === 404, 'cannot approve twice');
const t2 = await (await fetch(BASE + '/api/tree', { headers: fam })).json();
const np = t2.people[ap.person];
ok(np && np.first === 'Test' && np.born === '1990', 'new person is on the tree');
const pu = t2.unions[np.parentUnion]; ok(pu && (pu.a === 'p-betty-clark' || pu.b === 'p-betty-clark'), 'placed as Betty Clark’s child');
ok(/John Doe/.test(np.verify || ''), 'typed-in father is flagged for the organizer to check');
ok(Object.values(t2.unions).some((u) => (u.a === 'p-centennial-clark' && u.b === ap.person) || (u.b === 'p-centennial-clark' && u.a === ap.person)), 'marriage to Centennial recorded');
ok(Object.values(t2.heirlooms).some((h) => h.person === ap.person && h.title === 'Pocket watch' && h.by === 'Test Helper'), 'keepsake recorded with who attested it');
r = await fetch(BASE + '/_blob/' + ph.id, { headers: fam }); ok(r.ok && r.headers.get('content-type') === 'image/jpeg', 'approved photo now visible to family');

// relative added from the tree page, then declined
r = await fetch(BASE + '/api/submissions', { method: 'POST', headers: { ...fam, 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'person', rel: 'sibling', anchor: 'p-eva-clark', data: { first: 'Nobody' } }) });
const s2 = await r.json();
r = await fetch(BASE + `/api/admin/submissions/${s2.id}/decline`, { method: 'POST', headers: admin }); ok(r.ok, 'organizer declines');
const t3 = await (await fetch(BASE + '/api/tree', { headers: fam })).json();
ok(!Object.values(t3.people).some((p) => p.first === 'Nobody'), 'declined entry never reaches the tree');

// organizer direct edit, then clean up the test person
r = await fetch(BASE + '/api/admin/write', { method: 'POST', headers: { ...admin, 'content-type': 'application/json' }, body: JSON.stringify({ ops: [{ col: 'people', op: 'update', id: ap.person, data: { nick: 'Tester' } }] }) });
const t4 = await (await fetch(BASE + '/api/tree', { headers: admin })).json(); ok(t4.people[ap.person].nick === 'Tester', 'organizer edits directly');
r = await fetch(BASE + '/api/admin/write', { method: 'POST', headers: { ...admin, 'content-type': 'application/json' }, body: JSON.stringify({ ops: [{ col: 'people', op: 'set; DROP TABLE people', id: 'x' }] }) });
ok(r.status === 500 || r.status === 400, 'malformed write is refused');
r = await fetch(BASE + '/api/admin/write', { method: 'POST', headers: { ...admin, 'content-type': 'application/json' }, body: JSON.stringify({ ops: [{ col: 'sqlite_master', op: 'delete', id: 'x' }] }) });
ok(r.status >= 400, 'writes outside the family tables are refused');

// ---- linking people who are already on the tree ----
const W = (ops) => fetch(BASE + '/api/admin/write', { method: 'POST', headers: { ...admin, 'content-type': 'application/json' }, body: JSON.stringify({ ops }) });
const link = (b) => fetch(BASE + '/api/admin/link', { method: 'POST', headers: { ...admin, 'content-type': 'application/json' }, body: JSON.stringify(b) });
const tree = async () => (await fetch(BASE + '/api/tree', { headers: admin })).json();
const parentsOf = (t, id) => { const u = t.unions[t.people[id].parentUnion]; return u ? [u.a, u.b].filter(Boolean).sort() : []; };
// Recreate the real situation: Dad under Moses; kid under Dad alone; Mom married to Dad separately.
await W([{ col: 'people', op: 'set', id: 'p-t-dad', data: { first: 'Dad', last: 'T', parentUnion: null } },
  { col: 'unions', op: 'set', id: 'u-t-solo', data: { a: 'p-t-dad', b: null } },
  { col: 'people', op: 'set', id: 'p-t-kid', data: { first: 'Kid', last: 'T', parentUnion: 'u-t-solo' } },
  { col: 'people', op: 'set', id: 'p-t-mom', data: { first: 'Mom', last: 'T' } },
  { col: 'unions', op: 'set', id: 'u-t-married', data: { a: 'p-t-dad', b: 'p-t-mom' } }]);
r = await link({ rel: 'child', anchor: 'p-t-mom', target: 'p-t-kid' });
let t5 = await tree();
ok(r.ok && JSON.stringify(parentsOf(t5, 'p-t-kid')) === JSON.stringify(['p-t-dad', 'p-t-mom']), 'linking Mom → Kid makes Kid the child of Mom and Dad');
ok(t5.people['p-t-kid'].parentUnion === 'u-t-married' && !t5.unions['u-t-solo'], 'Kid moves to the existing marriage; the leftover one-parent entry is tidied away');
r = await link({ rel: 'child', anchor: 'p-t-mom', target: 'p-t-kid' }); ok((await r.json()).result === 'already', 'linking again is harmless');
r = await link({ rel: 'parent', anchor: 'p-t-dad', target: 'p-t-kid' }); ok(r.status >= 400, 'cannot make a child their own parent’s parent (no loops)');
// Lone parent marries: children can become shared
await W([{ col: 'people', op: 'set', id: 'p-t-p1', data: { first: 'Pat' } }, { col: 'unions', op: 'set', id: 'u-t-p1', data: { a: 'p-t-p1', b: null } },
  { col: 'people', op: 'set', id: 'p-t-c1', data: { first: 'Cam', parentUnion: 'u-t-p1' } }, { col: 'people', op: 'set', id: 'p-t-p2', data: { first: 'Robin' } }]);
await link({ rel: 'spouse', anchor: 'p-t-p1', target: 'p-t-p2', shareChildren: true });
t5 = await tree(); ok(JSON.stringify(parentsOf(t5, 'p-t-c1')) === JSON.stringify(['p-t-p1', 'p-t-p2']), 'marrying with “also the parent of” shares the existing children');
// siblings
await W([{ col: 'people', op: 'set', id: 'p-t-sib', data: { first: 'Sib' } }]);
await link({ rel: 'sibling', anchor: 'p-t-sib', target: 'p-t-kid' });
t5 = await tree(); ok(t5.people['p-t-sib'].parentUnion === t5.people['p-t-kid'].parentUnion, 'linking a sibling puts them under the same parents');
// duplicates
await W([{ col: 'people', op: 'set', id: 'p-t-dup', data: { first: 'Mom', last: 'T', born: '1967', parentUnion: null } },
  { col: 'heirlooms', op: 'set', id: 'h-t-1', data: { person: 'p-t-dup', title: 'Ring', by: 'x', at: 1 } }]);
r = await link({ rel: 'same', anchor: 'p-t-dup', target: 'p-t-mom' });
t5 = await tree();
ok(r.ok && !t5.people['p-t-dup'] && t5.people['p-t-mom'].born === '1967', 'merging a duplicate keeps one person and fills in missing details');
ok(t5.heirlooms['h-t-1'] && t5.heirlooms['h-t-1'].person === 'p-t-mom', 'the duplicate’s keepsakes move to the kept person');
// relatives can only ask
r = await fetch(BASE + '/api/admin/link', { method: 'POST', headers: { ...fam, 'content-type': 'application/json' }, body: JSON.stringify({ rel: 'spouse', anchor: 'p-t-kid', target: 'p-t-sib' }) });
ok(r.status === 401, 'family link cannot link people directly');
r = await fetch(BASE + '/api/submissions', { method: 'POST', headers: { ...fam, 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'link', rel: 'other', anchor: 'p-t-kid', text: 'cousin through Ida' }) });
const ls = await r.json();
r = await fetch(BASE + `/api/admin/submissions/${ls.id}/approve`, { method: 'POST', headers: admin });
t5 = await tree(); ok(r.ok && /cousin through Ida/.test(t5.people['p-t-kid'].verify || ''), '“other relative” requests are noted on the profile for the organizer');
r = await fetch(BASE + '/api/submissions', { method: 'POST', headers: { ...fam, 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'link', rel: 'same', anchor: 'p-t-kid', target: 'p-t-sib' }) });
const ms = await r.json(); r = await fetch(BASE + `/api/admin/submissions/${ms.id}/approve`, { method: 'POST', headers: admin });
ok(r.status >= 400 && (await tree()).people['p-t-sib'], 'only the organizer can merge; a relative’s merge request cannot delete anyone');
await fetch(BASE + `/api/admin/submissions/${ms.id}/decline`, { method: 'POST', headers: admin });
// clean up
await W(['p-t-dad', 'p-t-kid', 'p-t-mom', 'p-t-p1', 'p-t-p2', 'p-t-c1', 'p-t-sib'].map((id) => ({ col: 'people', op: 'delete', id })));

console.log(`\n${pass} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
