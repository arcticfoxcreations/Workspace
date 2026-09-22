# AI Workspace v2 — deploy guide

Build number: **2026-09-20.3** (the redeploy banner appears if your Worker and site disagree).

## 1. What changed in the file layout

19 script/style files became 9 JS + 1 CSS. Nothing was rewritten; files were concatenated in their original load order.

```
index.html  manifest.json  worker.js  wrangler.toml
css/style.css                 (style + customization + sync/viewer styles)
icons/icon.svg
js/core.js      toast + logger (now persisted) + auth + icons
js/db.js        gzip compression + IndexedDB (now emits change events)
js/providers.js js/router.js  js/settings.js  js/app.js
js/files.js     fileHandler + fileViewer + exporter
js/sync.js      NEW: encrypted sync, pairing, backup file, live-share push, viewer
js/console.js   console + consoleCommands
tests/          optional - not needed to run the site
```

**Delete these old files from your repo** (they are now merged, and stale copies just waste space):
`css/customization.css`, `js/toast.js`, `js/logger.js`, `js/auth.js`, `js/icons.js`, `js/fileHandler.js`,
`js/fileViewer.js`, `js/exporter.js`, `js/consoleCommands.js`, `js/compression.js`.

## 2. Deploy

**Worker (do this first)** — Cloudflare dashboard → your Worker → *Edit code* → replace everything with `worker.js` → *Deploy*.
- No new bindings are required. It uses the same `WORKSPACE_KV` and `APP_PASSWORD` you already have.
- Optional: an R2 bucket named `WORKSPACE_R2` (see `wrangler.toml`) moves synced *files* out of KV. R2 has to be enabled on your account first, and I could not verify from here whether that needs a payment method on file — check before relying on it.
- Optional: variable `ALLOWED_ORIGIN=https://arcticfoxcreations.github.io` makes the Worker answer only your site.

**Site** — replace `index.html`, `manifest.json`, `css/`, `js/`, `icons/` in the repo, delete the old files above, commit. Hard-refresh once (the page is cached aggressively by GitHub Pages / the browser).

**Check** — open the site; there should be no "redeploy" banner. If there is, one side is stale.

**Do this today:** the OpenRouter key that was pasted into an earlier chat is compromised. Revoke it at openrouter.ai/keys and add a new one in Settings.

## 3. Your PIN can now contain letters

The password field was forced to a digits-only mobile keypad (`inputmode="numeric"`); the Worker never restricted characters. Any string works now (verified with letters, digits, symbols and a space). Because a letters PIN is much harder to brute-force, keep it long — the Worker now also locks an IP out for 15 minutes after 10 wrong attempts.

## 4. Cross-device sync (Settings → Sync & backup)

Three separate secrets — don't mix them up:

| Secret | What it does | Where it lives |
|---|---|---|
| **Master PIN** (`APP_PASSWORD`) | Full control: provider keys, pairing, revoking, wiping cloud data | Cloudflare secret + your trusted devices |
| **Pairing code** `7K4P-92XM` | Lets *one* new device in, once, within 5 minutes | Shown on screen, then gone |
| **Sync passphrase** | Decrypts your synced chats. Never sent anywhere | Your head / password manager |
| Device token | A paired device's own revocable credential | That device only (stored hashed on the Worker) |

**Set up (main device):** Settings → Sync & backup → choose a passphrase (use *generate*; save it in a password manager) → *enable sync*. The first upload runs immediately.

**Add a device:** on the main device press *generate pairing code*. On the new device open the site → Settings → Sync & backup → enter the code, the passphrase and a name → *pair & restore*. Sessions, messages, settings, per-session AI target and compiled context arrive; file contents download the first time you open each file.

**Revoke:** Settings → Sync & backup → Devices → revoke (needs the master PIN). The device is cut off on its next request; it keeps its own local copy of the chats.

**What syncs:** sessions + messages (one encrypted item per session), attachments (one item each), nicknames, profile, Auto lineup, greeting, keybinds, share-link list, and — if you tick it — appearance. **Never synced:** provider API keys (they only exist in the Worker), the PIN, device tokens, the sync key, the background image, the console log.

**Conflicts:** messages are merged by id (union), so two devices chatting at once keep everything, in time order. Deletes travel as tombstones. Renames/pins/settings: newest write wins. If the *same message* was edited differently on two devices, the newer one stays and the other is kept as a visible "(other version)" copy. If a session was deleted on one device but edited on another afterwards, it is kept rather than deleted.

**Offline:** everything works locally; changes queue and push when you're back (status chip in the sidebar: Local only / Syncing… / Synced / Offline / Sync error / Sync paused / Sync locked).

**Encrypted backup file:** *export backup* gives a `.awbackup` file (AES-256-GCM, its own passphrase) with all chats, files and settings. *Restore* merges — importing the same file twice does not duplicate anything. Keep one somewhere that isn't this browser.

**"Clear everything" is local-only** — it does not delete your other devices' or the cloud's copy.

## 5. Encryption — what it does and doesn't protect

- Chats/files/settings are gzip-compressed then encrypted **in the browser** with AES-256-GCM. The key comes from your passphrase via PBKDF2-SHA-256 (600,000 iterations). Each item's id is bound into the ciphertext, so blobs can't be swapped between ids.
- The Worker stores ciphertext plus plain metadata: item ids, sizes, timestamps, device ids, item count. It cannot read titles, text, or file names.
- **A weak passphrase weakens everything**: anyone who could copy the ciphertext can guess offline. Use the generator or 5+ random words.
- **Lost passphrase = the cloud copy is unrecoverable.** Local copies and backup files (which have their own passphrase) are unaffected.
- **Not covered:** when you chat, your messages go through the Worker in plain text to reach the AI provider — that is how any proxy works. Encryption protects the *stored* sync copy, not that live request, and not from someone who can edit your Worker code.
- The unlocked key is kept in IndexedDB as a **non-extractable** CryptoKey so you don't retype the passphrase each visit. Scripts on your site's origin could still *use* it (not read it). "Lock this device" deletes it.

## 6. Cloudflare limits that shape the design (free plan)

| Limit | Value | Effect |
|---|---|---|
| Worker requests | 100,000/day | shared by everything |
| KV reads | 100,000/day | polling is 1 tiny request/min per open tab |
| **KV writes** | **1,000/day** | sync pauses at ~850; one changed session = 2 writes; each new file = 1 write (0 with R2) |
| KV storage | 1 GB | ~ your total encrypted chats + files |
| KV value | 25 MiB | files over ~18 MB sync as text only |
| KV consistency | ~60 s between locations | why sync is per-item + merge-based, not "last write wins on everything" |

Practical meaning: ~450 pushes/day. A normal day of chatting uses a few dozen. Bulk-uploading years of history the first time may take a couple of days to finish; it resumes automatically. Files are the biggest cost — bind R2 if you upload many.

**"How many users?"** Still one workspace with one owner. Paired devices are separate, individually revocable credentials into the *same* data; there are no separate user accounts or per-user quotas. Everything shares the free-tier quotas above and your providers' own rate limits.

## 7. Shared chats are now live

- Sharing a session creates a link that stays valid; every new message is pushed to the same link (≈6 s after you stop typing, one write per push). Viewers open a **read-only live view** — no PIN, no access to anything else.
- Viewers poll for changes (8 s while active → 90 s when idle, paused in background tabs); an unchanged poll is a tiny response. They handle new messages, edits, deletes, reconnects and a revoked link ("sharing stopped").
- Viewers see what you see in the bubbles: for your turns, the text you typed plus file **names** only — extracted file contents and error messages are not shared (they were before).
- **Behaviour change:** opening a share link no longer auto-imports a copy. It opens the live view with a **Save a copy to my workspace** button. Links created by the old version still open (as a snapshot; they can't live-update because they don't record which session they came from — re-share to get a live link).
- Share links use 256-bit random tokens.

## 8. Providers

**OmniRoute** is self-hosted gateway software (github.com/diegosouzapw/OmniRoute), so there is no fixed URL. Run your own instance over **https**, then in Settings → Providers → OmniRoute paste its URL (a bare origin gets `/v1` appended) and an API key. It's a normal provider after that: `@omniroute`, manual target, key failover, model list, compile eligibility. It is *not* in the Auto lineup until you tick it. Its context ceiling is set to a conservative 24,000 tokens in `app.js` (`PROVIDER_TOKEN_CEILING.omniroute`) because the real limit depends on the model it routes to.

**OpenRouter free models:** IDs rotate, so the model list is read live, free models (price $0, usually `:free`) sorted first by context size and tagged "free". If the selected model disappears, the Worker looks up a currently-free one, retries once, and the reply's label tooltip shows which model actually answered. OpenRouter's documented free limits are 20 requests/minute and 50/day (1,000/day if you've bought ≥$10 credits) — account-wide, not per model; I did not verify the numbers against a live account. The two model names you listed weren't checked against the live catalogue — pick from the list in Settings.

**Timeouts:** quick chat 30 s per key, Research/Test/Outline/Compare and compile 58 s per key, actually enforced in the Worker now (the previous code sent the flag but the Worker ignored it).

## 9. Storage and the context limit (two different problems)

- **Storage:** message text and extracted file text are gzip-compressed in IndexedDB; big JPEG/PNG/WebP photos are shrunk to ≤2000 px on upload (originals under ~450 KB, GIFs and SVGs untouched; original kept if re-encoding wouldn't help). Settings → Sync & backup → *Storage on this device* shows usage and lets you ask the browser for persistent storage (**iOS/Safari can otherwise delete site data after ~a week unused** — sync/backup is your protection).
- **Context limit:** unchanged mechanism (an AI writes a recap of old turns; nothing is deleted), now also available on demand: type `/compile` (or `/compile gemini` to choose the summarizer). It is never sent to an AI as chat text. Compression can't help here — providers count tokens of plain text.
- **Per-session AI target:** the AI you pick (or Auto) is remembered per session, survives reload, and syncs.
- **Console:** last 200 entries persist across reloads. `/logs persist off` turns it off, `/logs clear` wipes it. New: `/sync [now|lock]`.

## 10. What I verified — and what I didn't

**Verified by running code** (`tests/`, `npm install && npm test` — 82 checks):
- The real `worker.js` in workerd (Miniflare): auth, lockout, pairing, revocation, owner-only actions, encrypted storage round-trips, R2 path, paging over 1,100 items, shares (create/update/rev polling/revoke/legacy tokens), OmniRoute URL rules and request shape, OpenRouter fallback and free-list, key failover, real-time 30 s / 58 s timeout behaviour.
- The real browser scripts in jsdom with fake IndexedDB and Node WebCrypto: two-device pairing with a wrong then right passphrase, server-side ciphertext-only check, lazy file download, concurrent edits, deletes, tombstones, same-message conflict copies, deleted-vs-edited, offline queueing, reload persistence, quota pause, revoke, vault reset, damaged items, encrypted backup round-trip (wrong passphrase / corrupted / duplicate import), live share end-to-end, viewer XSS handling, `/compile` interception, per-session target, OmniRoute registration, console persistence, and a full `App.init()` + Settings render.
- I checked the tests can fail: deliberately breaking tombstone handling and the vault check made the relevant tests fail.

**Not verified (no real browser here):** real IndexedDB/Safari/Firefox behaviour, real `CompressionStream` on older browsers (older Safari versions without CompressionStream can't read compressed items), the image-downscaling canvas code, non-extractable CryptoKey persistence in real IndexedDB, layout and touch behaviour on phone/tablet/desktop (CSS was added but never rendered), and any live call to OmniRoute/OpenRouter/other providers (all provider calls were against mocks). Please try: pair a phone, send a message on each, share a chat and watch it update, upload a photo, export/restore a backup.

## 11. Known trade-offs

- Sync is near-real-time, not instant: pushes wait ~20 s after your last change; other devices notice within ~1 minute while their tab is visible.
- Clock differences between devices can mis-order a rename or delete-vs-edit decision made within seconds of each other.
- Compressing then encrypting means blob *sizes* are visible to the server (not contents).
- Master-PIN devices (no pairing) can't be revoked individually — rotate `APP_PASSWORD` in Cloudflare to cut them off. The old "full access link" (`?pin=`) still works but puts the PIN in a URL; prefer pairing.
- Attachment text is stored twice (once inside the message the AI saw, once as the file's own text). Compression softens it; de-duplicating would change how files are re-read and I left it alone.
