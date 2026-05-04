import { execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import * as p from '@clack/prompts'
import pc from 'picocolors'
import { scaffold } from './scaffold.js'

const require = createRequire(import.meta.url)
const { version } = require('../package.json')

function checkPrerequisites() {
	const missing = []
	for (const cmd of ['git', 'bun']) {
		try {
			execSync(`which ${cmd}`, { stdio: 'pipe' })
		} catch {
			missing.push(cmd)
		}
	}
	if (missing.length > 0) {
		p.log.error(`Missing required tools: ${missing.join(', ')}`)
		p.log.info('Install bun: https://bun.sh')
		process.exit(1)
	}
}

const BANNER = `
${pc.cyan(`  _   _                 _                       _
 | \\ | |_   _ _ __ ___ | |__   ___ _ __ ___  __| |
 |  \\| | | | | '_ \` _ \\| '_ \\ / _ \\ '__/ _ \\/ _\` |
 | |\\  | |_| | | | | | | |_) |  __/ | |  __/ (_| |
 |_| \\_|\\__,_|_| |_| |_|_.__/ \\___|_|  \\___|\\__,_|`)}
`

const TEMPLATES = {
	nextjs: {
		label: 'Next.js + Sanity',
		repo: 'git@github.com:Numbered-com/bootstrap.git',
		branch: 'staging',
	},
	// Add more templates here:
	shopify: {
		label: 'Shopify Liquid',
		repo: 'git@github.com:Numbered-com/jolie.git',
		branch: 'staging',
	},
}

function slugify(str) {
	return str
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[\u0300-\u036f]/g, '')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
}

function detectTemplate(targetDir) {
	if (existsSync(resolve(targetDir, 'apps/sanity'))) return 'nextjs'
	if (existsSync(resolve(targetDir, 'config.yml')) || existsSync(resolve(targetDir, 'shopify.theme.toml'))) return 'shopify'
	const pkgPath = resolve(targetDir, 'package.json')
	if (existsSync(pkgPath)) {
		try {
			const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
			if (pkg.workspaces) return 'nextjs'
		} catch {}
	}
	return null
}

function getSanityProjectId(targetDir) {
	const envPath = resolve(targetDir, '.env.local')
	if (!existsSync(envPath)) return null
	const match = readFileSync(envPath, 'utf-8').match(/^NEXT_PUBLIC_SANITY_PROJECT_ID=(.+)$/m)
	const id = match?.[1].trim()
	return id || null
}

function getGithubRepo(targetDir) {
	if (!existsSync(resolve(targetDir, '.git'))) return null
	try {
		const url = execSync('git remote get-url origin', { cwd: targetDir, stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim()
		const match = url.match(/github\.com[:/]([^/]+\/[^/.]+)/)
		return match?.[1] || null
	} catch {
		return null
	}
}

const DEFAULT_GRID = {
	mobile: { columns: 6, gutter: 12, margin: 12, mockupWidth: 375, fontScalingMaxWidth: 475 },
	tablet: { columns: 6, gutter: 12, margin: 12, mockupWidth: 768, screenWidth: 768, screen: 'md' },
	desktop: { columns: 24, gutter: 24, margin: 24, mockupWidth: 1440, screenWidth: 1024, fontScalingMaxWidth: 1680, screen: 'lg' },
}

export async function main() {
	console.log(BANNER)
	p.intro(`${pc.bgCyan(pc.black(' create-bootstrap '))} ${pc.dim(`v${version}`)}`)

	checkPrerequisites()

	const projectNameInput = await p.text({
		message: 'Project name?',
		placeholder: 'My Project',
		validate: (value) => {
			if (!value?.trim()) return 'Project name is required'
			if (!slugify(value)) return 'Project name must contain alphanumeric characters'
		},
	})
	if (p.isCancel(projectNameInput)) {
		p.cancel('Cancelled.')
		process.exit(0)
	}

	const projectTitle = projectNameInput.trim()
	const projectSlug = slugify(projectTitle)
	const targetDir = resolve(process.cwd(), projectSlug)
	const isExisting = existsSync(targetDir)

	let template
	if (isExisting) {
		template = detectTemplate(targetDir)
		if (!template) {
			p.log.error(`Directory "${projectSlug}" exists but template could not be detected.`)
			process.exit(1)
		}
		p.log.info(`Existing ${TEMPLATES[template].label} project detected — skipping creation steps.`)
	} else {
		const selected = await p.select({
			message: 'Which template?',
			options: Object.entries(TEMPLATES).map(([value, { label }]) => ({ value, label })),
		})
		if (p.isCancel(selected)) {
			p.cancel('Cancelled.')
			process.exit(0)
		}
		template = selected
	}

	let ecommerceSupport = false
	let grid = DEFAULT_GRID
	let installDeps = false

	if (!isExisting) {
		if (template === 'nextjs') {
			ecommerceSupport = await p.confirm({
				message: 'Include Shopify ecommerce support?',
				initialValue: false,
			})
			if (p.isCancel(ecommerceSupport)) {
				p.cancel('Cancelled.')
				process.exit(0)
			}
		}

		const configureGrid = await p.confirm({
			message: 'Configure the grid system? (default: 24col desktop / 6col mobile)',
			initialValue: false,
		})
		if (p.isCancel(configureGrid)) {
			p.cancel('Cancelled.')
			process.exit(0)
		}

		if (configureGrid) {
			const gridAnswers = await p.group(
			{
				desktopColumns: () =>
					p.text({
						message: 'Desktop columns?',
						placeholder: '24',
						initialValue: '24',
						validate: (v) => (isNaN(Number(v)) ? 'Must be a number' : undefined),
					}),
				desktopGutter: () =>
					p.text({
						message: 'Desktop gutter (px)?',
						placeholder: '24',
						initialValue: '24',
						validate: (v) => (isNaN(Number(v)) ? 'Must be a number' : undefined),
					}),
				desktopMargin: () =>
					p.text({
						message: 'Desktop margin (px)?',
						placeholder: '24',
						initialValue: '24',
						validate: (v) => (isNaN(Number(v)) ? 'Must be a number' : undefined),
					}),
				desktopMockupWidth: () =>
					p.text({
						message: 'Desktop mockup width (px)?',
						placeholder: '1440',
						initialValue: '1440',
						validate: (v) => (isNaN(Number(v)) ? 'Must be a number' : undefined),
					}),
				mobileColumns: () =>
					p.text({
						message: 'Mobile columns?',
						placeholder: '6',
						initialValue: '6',
						validate: (v) => (isNaN(Number(v)) ? 'Must be a number' : undefined),
					}),
				mobileGutter: () =>
					p.text({
						message: 'Mobile gutter (px)?',
						placeholder: '12',
						initialValue: '12',
						validate: (v) => (isNaN(Number(v)) ? 'Must be a number' : undefined),
					}),
				mobileMargin: () =>
					p.text({
						message: 'Mobile margin (px)?',
						placeholder: '12',
						initialValue: '12',
						validate: (v) => (isNaN(Number(v)) ? 'Must be a number' : undefined),
					}),
				mobileMockupWidth: () =>
					p.text({
						message: 'Mobile mockup width (px)?',
						placeholder: '375',
						initialValue: '375',
						validate: (v) => (isNaN(Number(v)) ? 'Must be a number' : undefined),
					}),
			},
			{ onCancel: () => (p.cancel('Cancelled.'), process.exit(0)) },
		)

		grid = {
			mobile: {
				columns: Number(gridAnswers.mobileColumns),
				gutter: Number(gridAnswers.mobileGutter),
				margin: Number(gridAnswers.mobileMargin),
				mockupWidth: Number(gridAnswers.mobileMockupWidth),
				fontScalingMaxWidth: Number(gridAnswers.mobileMockupWidth) + 100,
			},
			tablet: {
				columns: Number(gridAnswers.mobileColumns),
				gutter: Number(gridAnswers.mobileGutter),
				margin: Number(gridAnswers.mobileMargin),
				mockupWidth: 768,
				screenWidth: 768,
				screen: 'md',
			},
			desktop: {
				columns: Number(gridAnswers.desktopColumns),
				gutter: Number(gridAnswers.desktopGutter),
				margin: Number(gridAnswers.desktopMargin),
				mockupWidth: Number(gridAnswers.desktopMockupWidth),
				screenWidth: 1024,
				fontScalingMaxWidth: Number(gridAnswers.desktopMockupWidth) + 240,
				screen: 'lg',
			},
		}
		}

		const installDepsAnswer = await p.confirm({
			message: 'Install dependencies with bun?',
			initialValue: true,
		})
		if (p.isCancel(installDepsAnswer)) {
			p.cancel('Cancelled.')
			process.exit(0)
		}
		installDeps = installDepsAnswer
	}

	const existingSanityId = isExisting ? getSanityProjectId(targetDir) : null
	if (existingSanityId) {
		p.log.info(`Sanity project ${pc.cyan(existingSanityId)} existing — skipping creation.`)
	}

	let createSanityProject = false
	if (template === 'nextjs' && !existingSanityId) {
		createSanityProject = await p.confirm({
			message: isExisting ? 'Create a Sanity project?' : 'Create a new Sanity project?',
			initialValue: true,
		})
		if (p.isCancel(createSanityProject)) {
			p.cancel('Cancelled.')
			process.exit(0)
		}
	}

	const existingGithubRepo = isExisting ? getGithubRepo(targetDir) : null
	if (existingGithubRepo) {
		p.log.info(`GitHub repo ${pc.cyan(existingGithubRepo)} existing — skipping creation.`)
	}

	let createGithubRepo = false
	if (template === 'nextjs' && !existingGithubRepo) {
		createGithubRepo = await p.confirm({
			message: `Create a GitHub repo under ${pc.cyan('Numbered-com')}?`,
			initialValue: true,
		})
		if (p.isCancel(createGithubRepo)) {
			p.cancel('Cancelled.')
			process.exit(0)
		}
	}

	let createVercelProject = false
	if (template === 'nextjs') {
		createVercelProject = await p.confirm({
			message: `Link to a Vercel project under ${pc.cyan('numbered-sandbox')} and push env vars?`,
			initialValue: true,
		})
		if (p.isCancel(createVercelProject)) {
			p.cancel('Cancelled.')
			process.exit(0)
		}
	}

	await scaffold({
		projectName: projectSlug,
		projectTitle,
		template: TEMPLATES[template],
		grid,
		installDeps,
		ecommerceSupport,
		createSanityProject,
		createGithubRepo,
		createVercelProject,
		isExisting,
	})

	p.outro(pc.green(`Done! cd ${projectSlug} and start building.`))
}
