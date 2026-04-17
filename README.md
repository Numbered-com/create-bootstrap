# create-bootstrap

CLI to scaffold a new Numbered Studio project — Next.js + Sanity or Shopify Liquid, with Figma grid config baked in. Creates the project locally and wires it up end-to-end: Sanity project, GitHub repo, Vercel deployment, env vars, and preview domain.

## Usage

```bash
npx github:Numbered-com/create-bootstrap
```

Re-run it on an existing directory to resume setup — the CLI detects the project type and skips steps that are already done (Sanity project, GitHub repo, etc.).

## What it does

Prompts:

1. **Project name** — any string; internally slugified (e.g. `My Project` → `my-project`)
2. **Template** — Next.js + Sanity or Shopify Liquid (skipped if existing project)
3. **Shopify ecommerce support** — for `nextjs` only; removes ~100 ecommerce files when disabled (default: no)
4. **Grid configuration** — defaults to 24col desktop / 6col mobile
5. **Install dependencies** — via bun
6. **Create Sanity project** — creates remote project, injects all IDs/secrets into `.env.local`, prompts for `SANITY_API_TOKEN`
7. **Create GitHub repo** — private repo under `Numbered-com`, initial commit on `main`, auto-push, then checkout `staging` branch
8. **Link Vercel project** — under `numbered-sandbox` scope, sets `apps/web` as root, pushes env vars to all environments (parallel), adds `{slug}.numbered.studio` preview domain targeting `staging`

Each step is idempotent and skippable — re-running only runs what's missing.

## Prerequisites

- [bun](https://bun.sh) `>=1.0`
- [git](https://git-scm.com) + access to the `Numbered-com` GitHub org
- [gh](https://cli.github.com) (only for GitHub repo creation) — run `gh auth login`
- Vercel CLI ≥ v51 (auto-installed globally if missing)
- Sanity account — browser login on first run

Node.js `>=22`.

## Templates

| Key       | Label            | Repo                      |
| --------- | ---------------- | ------------------------- |
| `nextjs`  | Next.js + Sanity | `Numbered-com/bootstrap`  |
| `shopify` | Shopify Liquid   | `Numbered-com/jolie`      |

## Next steps after scaffolding

```bash
cd my-project
bun run dev
```

If you skipped the Sanity step, copy `.env.sample` to `.env.local` and fill in the values manually.
