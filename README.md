# EasyInstall

Pick Windows apps on [easyinstall.dev](https://easyinstall.dev), download one small `.cmd` file, run it, and every app installs silently. Run the same file again later and it updates them.

## How it works

- **Site** (`public/`): the app grid, presets and the "Get installer" dialog. Presets are saved in the browser, and synced through Google sign-in when that's set up.
- **Worker** (`src/worker.js`): serves the catalog, builds installers, handles sign-in and the admin API. It runs on Cloudflare Workers with a D1 database.
- **Installer** (`src/installer.js`): `GET /i/<app>+<app>+...` returns a PowerShell script for those apps. `GET /dl/<app>+<app>.cmd` returns a launcher that asks for admin rights and runs that script. Each app installs one of these ways:
  - `winget`: Windows Package Manager. The script sets up winget if it's missing.
  - `msstore`: Microsoft Store apps, installed through winget.
  - `choco`: Chocolatey, set up only when one of these apps is picked.
  - `direct`: a vendor download, either a fixed link or the first link on a page that matches a pattern (cached for 6 hours). The app's `args` are its silent-install switches.
  - `manual`: the site only links to it.
- Already-installed apps are updated instead of reinstalled. Apps marked with `requires` (for example `gpu:nvidia`) are skipped on PCs without that hardware.
- Add `?dry=1` to a script URL to see what it would do without changing anything: `irm https://easyinstall.dev/i/vlc+7-zip?dry=1 | iex`

## Managing apps

Open `https://easyinstall.dev/admin` to show or hide apps, edit them, or add new ones. Changes are live immediately; there's nothing to redeploy. Find package IDs with `winget search <name>`, or at community.chocolatey.org/packages.

`migrations/0002_seed.sql` is the starting catalog. `scripts/make-seed.cjs` generated it once; after launch, the admin page is the source of truth.

## Running locally

```
npm install
npm run db:local
npm run dev            # http://localhost:8787, admin at /admin
```

`.dev.vars` (not committed) sets `DEV_ADMIN=1`, which skips the admin login locally only.

## Deploying

1. `npx wrangler login`
2. `npx wrangler d1 create easyinstall`, then paste the printed `database_id` into `wrangler.toml`.
3. `npm run db:remote` creates the tables and the starting catalog.
4. `npx wrangler secret put SESSION_SECRET`, and paste a long random string (`node -e "console.log(crypto.randomBytes(32).toString('hex'))"`).
5. Put your Ko-fi link in `KOFI_URL` in `wrangler.toml`.
6. `npm run deploy`. The route in `wrangler.toml` attaches `easyinstall.dev`, because the domain is on the same Cloudflare account.

### Lock down /admin (Cloudflare Access, free)

1. Cloudflare dashboard → **Zero Trust** → **Access** → **Applications** → **Add an application** → **Self-hosted**.
2. Add two public hostnames: `easyinstall.dev` with path `admin`, and `easyinstall.dev` with path `api/admin`.
3. Add a policy: **Allow**, **Emails**, your email address.
4. Copy the application's **Audience (AUD) tag** into `ACCESS_AUD`, and your team domain (`<team>.cloudflareaccess.com`) into `ACCESS_TEAM_DOMAIN`, then deploy again.

The Worker checks the Access token itself as well, so `/admin` stays closed even if the Access app is misconfigured.

### Google sign-in for synced presets (optional)

1. Google Cloud Console → **APIs & Services** → **OAuth consent screen**: set it up as External, with the app name EasyInstall.
2. **Credentials** → **Create credentials** → **OAuth client ID** → **Web application**. Under Authorized JavaScript origins, add `https://easyinstall.dev` and `http://localhost:8787`.
3. Put the client ID in `GOOGLE_CLIENT_ID` and deploy. The sign-in button appears in the Presets dialog. Until then, presets are saved in the browser only.
