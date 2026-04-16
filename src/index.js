import { execSync } from 'node:child_process'
import { createRequire } from 'node:module'
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
${pc.cyan(`  _   _                 _                        _
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
		branch: 'main',
	},
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

	const answers = await p.group(
		{
			projectName: () =>
				p.text({
					message: 'Project name?',
					placeholder: 'my-project',
					validate: (value) => {
						if (!value?.trim()) return 'Project name is required'
						if (!/^[a-z0-9-]+$/.test(value)) return 'Use lowercase letters, numbers, and hyphens only'
					},
				}),

			template: () =>
				p.select({
					message: 'Which template?',
					options: Object.entries(TEMPLATES).map(([value, { label }]) => ({ value, label })),
				}),

			configureGrid: () =>
				p.confirm({
					message: 'Configure the grid system? (default: 24col desktop / 6col mobile)',
					initialValue: false,
				}),
		},
		{ onCancel: () => (p.cancel('Cancelled.'), process.exit(0)) },
	)

	// Ecommerce support prompt (only for nextjs template)
	let ecommerceSupport = false
	if (answers.template === 'nextjs') {
		ecommerceSupport = await p.confirm({
			message: 'Include Shopify ecommerce support?',
			initialValue: false,
		})
		if (p.isCancel(ecommerceSupport)) {
			p.cancel('Cancelled.')
			process.exit(0)
		}
	}

	// Grid configuration
	let grid = DEFAULT_GRID
	if (answers.configureGrid) {
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

	const installDeps = await p.confirm({
		message: 'Install dependencies with bun?',
		initialValue: true,
	})
	if (p.isCancel(installDeps)) {
		p.cancel('Cancelled.')
		process.exit(0)
	}

	// Sanity project creation (only for nextjs template)
	let createSanityProject = false
	if (answers.template === 'nextjs') {
		createSanityProject = await p.confirm({
			message: 'Create a new Sanity project?',
			initialValue: true,
		})
		if (p.isCancel(createSanityProject)) {
			p.cancel('Cancelled.')
			process.exit(0)
		}
	}

	const templateConfig = TEMPLATES[answers.template]

	await scaffold({
		projectName: answers.projectName,
		template: templateConfig,
		grid,
		installDeps,
		ecommerceSupport,
		createSanityProject,
	})

	p.outro(pc.green(`Done! cd ${answers.projectName} and start building.`))
}
