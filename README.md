# WebGate — Browse Freely

A web proxy that lets you access blocked websites. Deploy to **Vercel** (free) — one deploy gives you both the frontend UI and the proxy backend.

## How It Works

```
Your Browser  →  Vercel (UI + API proxy)  →  Target Website (Google, etc.)
```

The frontend runs on Vercel. The `/api/proxy` serverless function fetches blocked pages on your behalf and returns the content to your browser.

## Deploy (5 minutes)

### Option A: One-Click Deploy

1. Push this repo to GitHub
2. Go to [vercel.com](https://vercel.com) → **New Project** → Import your GitHub repo
3. Click **Deploy** (no settings to change — it works out of the box)
4. Open your `https://your-project.vercel.app` URL and start browsing

### Option B: CLI Deploy

```bash
npm i -g vercel
cd google-mirror
vercel --prod
```

That's it. The proxy auto-detects when hosted on Vercel — no configuration needed.

## Features

- Google search — type search terms directly in the URL bar
- Link rewriting — stay inside the proxy while clicking links
- Images and CSS proxied through the API so pages render correctly
- Back/Forward navigation with history
- Quick-launch shortcuts (Google, Wikipedia, Reddit, YouTube, etc.)
- Settings to toggle link rewriting and script stripping
- Mobile responsive
- Keyboard shortcuts: `Alt+←` back, `Alt+→` forward, `Ctrl+L` focus URL bar

## Limitations

- Heavy SPAs (React/Vue apps) may not render perfectly
- WebSocket connections are not proxied
- Some sites detect and block proxied access
- Video streaming may hit Vercel's response size limits on free tier
- Vercel free tier: 100GB bandwidth/month, 10s function timeout (serverless)

## Using with GitHub Pages (split deploy)

If you prefer GitHub Pages for the frontend:

1. Deploy this repo to GitHub Pages (the Actions workflow is included)
2. Deploy just the `api/` folder separately to Vercel
3. Open your GitHub Pages site → Settings → paste your Vercel URL (`https://your-project.vercel.app/api/proxy`)
