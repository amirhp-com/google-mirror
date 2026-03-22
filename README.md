# WebGate — Browse Freely via GitHub Pages

A web proxy that lets you access blocked websites through GitHub Pages + a free Cloudflare Worker backend.

## How It Works

```
Your Browser  →  GitHub Pages (UI)  →  Cloudflare Worker (proxy)  →  Target Website
```

GitHub Pages serves the frontend. The Cloudflare Worker (free tier, 100k requests/day) fetches blocked pages on your behalf and returns the content.

## Setup (10 minutes)

### Step 1: Deploy the Frontend (GitHub Pages)

1. Create a new GitHub repo (or use this one)
2. Push this code to the `main` branch
3. Go to **Settings → Pages → Source** → select **GitHub Actions**
4. The site auto-deploys on every push to `main`

### Step 2: Deploy the Proxy Worker (Cloudflare — Free)

1. Create a free account at [cloudflare.com](https://dash.cloudflare.com/sign-up)
2. Install Wrangler CLI:
   ```bash
   npm install -g wrangler
   ```
3. Login to Cloudflare:
   ```bash
   wrangler login
   ```
4. Deploy the worker:
   ```bash
   cd worker
   npx wrangler deploy
   ```
5. Wrangler will output your worker URL, something like:
   ```
   https://webgate-proxy.YOUR_SUBDOMAIN.workers.dev
   ```

### Step 3: Connect Frontend to Worker

1. Open your GitHub Pages site
2. Paste your Cloudflare Worker URL in the setup screen
3. Start browsing!

## Features

- Google search integration — type search terms directly
- Link rewriting — stay inside the proxy while clicking links
- Back/Forward navigation with history
- Quick-launch shortcuts (Google, Wikipedia, Reddit, etc.)
- Settings panel to adjust behavior
- Mobile responsive
- Keyboard shortcuts: `Alt+←` back, `Alt+→` forward, `Ctrl+L` focus URL bar

## Security Notes

- The Cloudflare Worker has CORS set to allow all origins by default. For production, edit `ALLOWED_ORIGINS` in `worker/proxy-worker.js` to only allow your GitHub Pages domain.
- The `BLOCKED_DOMAINS` array in the worker lets you block specific target domains if needed.
- The iframe uses `sandbox="allow-scripts allow-forms allow-same-origin"` to limit what proxied pages can do.

## Limitations

- JavaScript-heavy SPAs (React/Vue apps) may not work perfectly since resources load from different origins
- WebSocket connections are not proxied
- Some sites detect and block proxy access
- Videos/streaming may not work due to Cloudflare Worker size limits (10MB per response on free tier)

## Free Tier Limits

| Service | Free Limit |
|---------|------------|
| GitHub Pages | 100GB bandwidth/month |
| Cloudflare Workers | 100,000 requests/day |
