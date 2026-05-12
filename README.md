# Calgary Indie Showtimes Web

Public web MVP for the Mac app, designed for free GitHub Pages hosting.

## What it does

- Scrapes The Plaza Theatre and Globe Cinema
- Generates a static `public/listings.json`
- Renders a filterable React table
- Deploys automatically to GitHub Pages

## Local commands

```bash
npm install
npm run generate:listings
npm test
npm run build
```

## Deployment flow

The GitHub Actions workflow:

1. Installs dependencies
2. Fetches fresh listings
3. Runs tests
4. Builds the Vite app
5. Deploys `dist/` to GitHub Pages
