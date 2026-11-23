# Evergreen shared-household sync server

A tiny, free, **zero-knowledge** sync server for Evergreen's shared Household space. It only ever stores ciphertext keyed by a public household id — it cannot read anything you put in it. You host it once on Cloudflare's free tier; after that it just works.

## Deploy it (no command line needed, ~5 minutes)

1. Create a free account at **cloudflare.com** and open the **Workers & Pages** section.
2. **Create application → Create Worker.** Give it a name (e.g. `evergreen-sync`), then **Deploy**.
3. **Edit code**, delete the sample, paste the contents of `worker.js` from this folder, and **Deploy** again.
4. Create the storage: in the left menu, **Workers & Pages → KV → Create a namespace**, name it `HOUSEHOLD`.
5. Back in your Worker → **Settings → Bindings → Add → KV namespace**: Variable name **`HOUSEHOLD`**, namespace **HOUSEHOLD**. Save.
6. Copy your Worker's URL (looks like `https://evergreen-sync.<you>.workers.dev`).

Give that URL to Evergreen (Settings → Shared Household → sync server URL) on both phones, and share the one household code between you. That's it.

## Why it's private

- Both phones derive the encryption key from the shared code; the key never leaves either device.
- Items are encrypted (AES-256-GCM) before they're sent. The server stores only `{iv, ct}` blobs and timestamps.
- The household id the server sees is a one-way hash of the code, so the server can't derive the key from it.

## Free-tier limits

Cloudflare's free plan allows ~100,000 requests/day and plenty of KV storage — far more than two people syncing a few lists will ever use.
