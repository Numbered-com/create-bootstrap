import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as p from '@clack/prompts'

/**
 * @param {{ projectName: string, template: { repo: string, branch: string, label: string }, grid: object, installDeps: boolean }} options
 */
export async function scaffold({ projectName, template, grid, installDeps }) {
	const targetDir = resolve(process.cwd(), projectName)

	if (existsSync(targetDir)) {
		p.log.error(`Directory "${projectName}" already exists.`)
		process.exit(1)
	}

	// Clone the template repo
	const s = p.spinner()
	s.start(`Cloning ${template.label} template...`)

	const httpsRepo = template.repo.replace(/^git@github\.com:/, 'https://github.com/')
	let cloned = false

	try {
		execSync(`git clone --depth 1 --branch ${template.branch} ${template.repo} ${projectName}`, {
			stdio: 'pipe',
		})
		cloned = true
	} catch {
		s.message('SSH clone failed, trying HTTPS...')
		try {
			execSync(`git clone --depth 1 --branch ${template.branch} ${httpsRepo} ${projectName}`, {
				stdio: 'pipe',
			})
			cloned = true
		} catch (err) {
			s.stop('Clone failed.')
			p.log.error(`Failed to clone template repo.\n${err.stderr?.toString() || err.message}`)
			p.log.info('Make sure you have access to the Numbered-com GitHub org.')
			process.exit(1)
		}
	}

	s.stop('Template cloned.')

	// Remove .git history and reinitialize
	rmSync(resolve(targetDir, '.git'), { recursive: true, force: true })
	execSync('git init', { cwd: targetDir, stdio: 'pipe' })
	p.log.success('Git initialized (clean history).')

	// Update project name in package.json files
	s.start('Configuring project...')
	updatePackageName(targetDir, projectName)

	// Write grid configuration
	writeGridConfig(targetDir, grid)

	// Remove .env files (secrets)
	removeSecrets(targetDir)

	s.stop('Project configured.')

	// Install dependencies
	if (installDeps) {
		s.start('Installing dependencies with bun...')
		try {
			execSync('bun install', { cwd: targetDir, stdio: 'pipe', timeout: 120_000 })
			s.stop('Dependencies installed.')
		} catch {
			s.stop('Install failed.')
			p.log.warn('bun install failed. Run it manually after setup.')
		}
	}

	// Summary
	p.log.info(`\nProject created at ${targetDir}`)
	p.note(
		[
			`cd ${projectName}`,
			!installDeps ? 'bun install' : null,
			'cp .env.sample .env.local  # configure your env vars',
			'bun run dev',
		]
			.filter(Boolean)
			.join('\n'),
		'Next steps',
	)
}

function updatePackageName(targetDir, projectName) {
	const rootPkg = resolve(targetDir, 'package.json')
	if (existsSync(rootPkg)) {
		const pkg = JSON.parse(readFileSync(rootPkg, 'utf-8'))
		pkg.name = projectName
		writeFileSync(rootPkg, JSON.stringify(pkg, null, '\t') + '\n')
	}
}

function writeGridConfig(targetDir, grid) {
	const gridPath = resolve(targetDir, 'packages/config/tailwind/preset/grid.js')
	if (!existsSync(gridPath)) return

	const content = `/**
 * Grid system configuration from Figma
 * Desktop: ${grid.desktop.columns} columns, ${grid.desktop.gutter}px gutter, ${grid.desktop.margin}px margin
 * Mobile: ${grid.mobile.columns} columns, ${grid.mobile.gutter}px gutter, ${grid.mobile.margin}px margin
 * Tablet uses mobile grid system
 */
export default ${JSON.stringify(grid, null, '\t')}
`
	writeFileSync(gridPath, content)
}

function removeSecrets(targetDir) {
	const patterns = ['.env', '.env.local', '.env.production', '.env.development']
	for (const pattern of patterns) {
		const filePath = resolve(targetDir, pattern)
		if (existsSync(filePath)) {
			rmSync(filePath)
		}
	}
}
