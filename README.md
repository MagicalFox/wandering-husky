# Wandering Husky — static site

Replica of https://wanderinghusky.com, migrated off WordPress.com.

- **Stack**: [Astro](https://astro.build) (static site generator) + [Sveltia CMS](https://github.com/sveltia/sveltia-cms) for the `/admin` editing UI
- **Content**: one Markdown file per post/page in `src/content/posts/` and `src/content/pages/`
- **Site settings / menu bar**: `src/data/settings.json` and `src/data/menu.json` (editable via `/admin`)
- **Photos**: originals live only in `~/Documents/Adobe` (single source of truth); web-optimized `.webp` derivatives are generated into `public/images/`

## Everyday commands

```sh
npm run dev       # local dev server with live reload
npm run build     # build the static site into dist/
npm run preview   # serve the built site locally
```

## Editing content

Once published, go to **/admin** on the live site and sign in with GitHub.
Every save commits to the repo and the site rebuilds automatically (~1–2 min).
You can also just edit the Markdown files directly and `git push`.

## One-time publishing setup

### 1. GitHub repo

```sh
gh auth login                       # interactive, do this once in a terminal
cd wandering-husky
git init && git add -A && git commit -m "Initial import from WordPress.com"
gh repo create wandering-husky --public --source . --push
```

### 2. Hosting — Cloudflare Pages (free)

1. <https://dash.cloudflare.com> → sign up → **Workers & Pages → Create → Pages → Connect to Git** → pick the `wandering-husky` repo.
2. Build settings: framework preset **Astro** (build command `npm run build`, output `dist`).
3. The site goes live at `https://wandering-husky.pages.dev` on every push.
4. Later: **Custom domains → add `wanderinghusky.com`** (Cloudflare walks you through DNS; domain renewal ~$10–15/yr is then the only cost).

### 3. Admin login — auth worker (free)

The `/admin` UI needs a tiny OAuth gateway so GitHub can verify your login:

1. GitHub → **Settings → Developer settings → OAuth Apps → New OAuth App**:
   - Homepage URL: `https://wandering-husky.pages.dev`
   - Authorization callback URL: `https://wandering-husky-auth.<subdomain>.workers.dev/callback`
     (the `<subdomain>` shows on your Cloudflare Workers dashboard)
2. Deploy the worker (source vendored from <https://github.com/sveltia/sveltia-cms-auth>, MIT):
   ```sh
   cd auth-worker
   npm install -D wrangler
   npx wrangler login
   npx wrangler secret put GITHUB_CLIENT_ID      # from the OAuth App page
   npx wrangler secret put GITHUB_CLIENT_SECRET  # from the OAuth App page
   npx wrangler deploy
   ```
3. Fill the two placeholders in `public/admin/config.yml` (`repo`, `base_url`), commit, push.
4. Open `https://wandering-husky.pages.dev/admin` → Sign in with GitHub.

## Re-running the migration

`scripts/migrate.mjs` re-fetches everything from WordPress.com (read-only) and
regenerates Markdown + derivatives. It is idempotent: existing downloads and
`.webp` files are skipped. `migration-manifest.json` (git-ignored) maps every
site image back to its original file in `~/Documents/Adobe`.
