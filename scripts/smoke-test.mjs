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

console.log(`\n${pass} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
