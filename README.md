# WebGate — Browse the Web Freely

A free, open-source web proxy you can deploy in one click. Access Google, Wikipedia, YouTube, and any blocked website through your own private Vercel instance.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/amirhp-com/google-mirror)

## How It Works

```
Your Browser  →  Your Vercel App (UI + proxy)  →  Google / any website
```

Vercel serves both the frontend UI and a serverless proxy function (`/api/proxy`). When you enter a URL, the proxy fetches the page for you and sends it back — bypassing your ISP's filters entirely.

## Deploy Your Own (2 minutes)

### 1. Click the button

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/amirhp-com/google-mirror)

This will:
- Fork the repo to your GitHub account
- Create a Vercel project
- Deploy it automatically

### 2. Open your app

Once deployed, Vercel gives you a URL like `https://google-mirror-xxxxx.vercel.app`. Open it and start browsing. No configuration needed — the proxy auto-detects itself.

That's it. You're done.

---

### Alternative: CLI Deploy

If you prefer the command line:

```bash
git clone https://github.com/amirhp-com/google-mirror.git
cd google-mirror
npx vercel --prod
```

## Features

- **Search Google** — type search terms directly in the URL bar
- **Link rewriting** — clicking links keeps you inside the proxy
- **Full resource proxying** — images, CSS, and scripts load through the proxy
- **Navigation** — back, forward, reload with full history
- **Quick shortcuts** — Google, Wikipedia, Reddit, YouTube, Hacker News, Stack Overflow
- **Settings** — toggle link rewriting, script stripping
- **Mobile friendly** — fully responsive design
- **Keyboard shortcuts** — `Alt+←/→` navigate, `Ctrl+L` focus URL bar

## Limitations

- JavaScript-heavy SPAs (React, Vue) may not render perfectly
- WebSocket connections are not proxied
- Some sites detect and block proxy access
- Video streaming may hit size limits on Vercel's free tier

## Vercel Free Tier Limits

| Resource | Limit |
|----------|-------|
| Bandwidth | 100 GB/month |
| Serverless function duration | 10 seconds |
| Deployments | Unlimited |

More than enough for personal browsing.

## License

MIT — free to use, modify, and share.
