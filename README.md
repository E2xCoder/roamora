# Roamora

Your personal travel & hiking planner. Save places from TikTok/Instagram, discover hidden gems, plan trips with AI.

## Features

- **Link Paste** — Paste a TikTok or Instagram URL, auto-extract the place and pin it on the map
- **Hidden Gems** — Thousands of POIs from OpenStreetMap & Wikivoyage across Europe
- **AI Trip Planner** — Generate day-by-day itineraries with Ollama (local, free)
- **Hiking Trails** — European Wanderwege via Waymarked Trails API
- **Google Maps Import** — Import saved places from Google Takeout (CSV/JSON)

## Setup

```bash
npm install
echo 'DATABASE_URL="file:./dev.db"' > .env
npx tsx scripts/seed-places.ts
npm run dev
```

## Requirements

- Node.js 18+
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) (for TikTok/Instagram extraction)
- [Ollama](https://ollama.ai) with `llama3.1:8b` (for AI trip planning)
