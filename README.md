# create-numbered-studio

CLI to scaffold a new Numbered Studio project — Next.js + Sanity or Shopify Liquid, with Figma grid config baked in.

## Usage

```bash
npx github:Numbered-com/create-numbered-studio
```

## What it does

The CLI will ask you:

1. **Project name** — lowercase, numbers, hyphens only
2. **Template** — Next.js + Sanity or Shopify Liquid
3. **Grid configuration** — defaults to 24 columns desktop / 6 columns mobile
4. **Install dependencies** — via bun

It then:

- Clones the selected template repo
- Resets git history (clean start)
- Updates `package.json` with your project name
- Writes the grid config to `packages/config/tailwind/preset/grid.js`
- Removes any `.env` files
- Runs `bun install` if selected

## Next steps after scaffolding

```bash
cd my-project
cp .env.sample .env.local  # configure your env vars
bun i
bun run dev
```

## Templates

| Key | Label | Repo |
|-----|-------|------|
| `nextjs` | Next.js + Sanity | `Numbered-com/bootstrap` |
| `shopify` | Shopify Liquid | `Numbered-com/jolie` |
