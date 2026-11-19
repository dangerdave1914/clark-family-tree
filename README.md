# Clark Family Tree

A family tree website your relatives can add themselves to — built to be easy for older family members.

- **`/`** — the painted family tree (tree view and 3D view). Tap anyone to see their profile, parents, children and keepsakes.
- **`/join`** — where the family QR code points. Sets a cookie so the phone remembers the family.
- **`/add`** — the guided "add yourself" page: one question per screen, big text, a camera button, pick your mother/father/spouse from faces and names, optional keepsake story with voice typing. Has an "I'm helping someone" mode for grandkids filling it in for elders.
- **`/admin`** — the organizer's page: approve or decline what people send in, and print the QR card for reunions and weddings.

Nothing a family member sends appears on the tree until the organizer approves it.

## How it's built

- One Cloudflare Worker (`src/worker.js`) serves the pages in `public/` and a small API.
- A Cloudflare D1 database (`clark-family-tree`) holds people, marriages ("unions"), keepsakes, submissions and photos. Phones shrink photos before uploading, so they fit in the database.
- `public/index.html` is the same tree page as the claude.ai version; `public/shim.js` connects it to this API instead.

Data model: a **union** is a marriage or partnership (`a`, `b`). Children point at the union they were born to with `parent_union`. That's how one person can have two marriages, and how two families' trees touch at a wedding.

## Secrets (set once in Cloudflare)

| Name | What it is |
|---|---|
| `FAMILY_CODE` | The code in the family link / QR code. Changing it signs every phone out. |
| `ADMIN_TOKEN` | The organizer password for `/admin`. Keep it to yourself. |

## Deploy (first time)

1. In the Cloudflare dashboard, go to **Workers & Pages → Create → Import a repository**, pick this repo, and accept the defaults (deploy command `npx wrangler deploy`).
2. On the new Worker, add the two secrets above under its settings for **Variables and Secrets** (type: Secret), then redeploy.
3. Open `https://<your-worker-address>/admin`, sign in with `ADMIN_TOKEN`, and print the QR card.

After that, every push to `main` redeploys automatically.

The database already exists and already holds the family (`migrations/0001_schema.sql`, `migrations/0002_seed.sql`). Don't re-run the seed on the live database — it only inserts what's missing, but it's meant for a fresh one.

## Run it on your computer

```
npm install
cp .dev.vars.example .dev.vars
npm run db:local
npm run dev        # http://localhost:8787 — family code TESTCODE, organizer password local-admin-password
npm test           # in a second terminal: 26 end-to-end checks
```

## Notes for whoever works on it next (Claude, Gemini, anyone)

- **Art lives in `public/index.html`**: the `Paint` engine (painted meadow), `render()` (tree drawing) and `startOrchard()` (3D view). Change freely.
- **Leave alone unless you mean to change family logic**: `buildIndex()` / `computeLayout()` in `index.html`, and the 3D `data()` placement (it keeps cards from overlapping).
- **Security rules live in `src/worker.js`**: family members can read and submit; only the organizer writes. Keep it that way.
