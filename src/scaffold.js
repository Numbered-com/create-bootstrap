import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import * as p from "@clack/prompts";

const GITHUB_ORG = "Numbered-com";
const VERCEL_SCOPE = "numbered-sandbox";
const PREVIEW_DOMAIN_SUFFIX = "numbered.studio";
const LOCAL_BASE_URL = "https://web.localhost";
const VERCEL_ENV = { ...process.env, CI: "1" };
const MIN_VERCEL_VERSION = 51;

/**
 * @param {{ projectName: string, projectTitle: string, template: { repo: string, branch: string, label: string }, grid: object, installDeps: boolean, ecommerceSupport: boolean, createSanityProject: boolean, createGithubRepo: boolean, createVercelProject: boolean, isExisting: boolean }} options
 */
export async function scaffold({ projectName, projectTitle, template, grid, installDeps, ecommerceSupport, createSanityProject, createGithubRepo, createVercelProject, isExisting }) {
	const targetDir = resolve(process.cwd(), projectName);
	const s = p.spinner();

	if (!isExisting) {
		s.start(`Cloning ${template.label} template...`);

		const sshRepo = template.repo;
		const httpsRepo = sshRepo.replace(/^git@github\.com:/, "https://github.com/");
		const ghRepo = sshRepo.match(/github\.com[:/]([^/]+\/[^/.]+)/)?.[1];

		const cloneArgs = (url) => ["clone", "--depth", "1", "--branch", template.branch, url, projectName];
		const attempts = [
			{
				label: "SSH",
				args: cloneArgs(sshRepo),
				env: { ...process.env, GIT_SSH_COMMAND: "ssh -o BatchMode=yes" },
			},
			ghRepo && {
				label: "gh credentials",
				args: ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential", ...cloneArgs(httpsRepo)],
				env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
				canRun: isGhAuthed,
			},
			{
				label: "HTTPS",
				args: cloneArgs(httpsRepo),
				env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
			},
		].filter(Boolean);

		let lastErr;
		let cloned = false;
		let prev;
		for (const attempt of attempts) {
			if (attempt.canRun && !(await attempt.canRun())) continue;
			if (prev) {
				s.message(`${prev.label} clone failed, trying ${attempt.label}...`);
				rmSync(targetDir, { recursive: true, force: true });
			}
			const result = await spawnAsync("git", attempt.args, { env: attempt.env, timeout: 300_000 });
			if (result.status === 0) {
				cloned = true;
				break;
			}
			lastErr = result.stderr;
			prev = attempt;
		}

		if (!cloned) {
			s.error("Clone failed.");
			p.log.error(`Failed to clone template repo.\n${lastErr || "unknown error"}`);
			p.log.info(`Make sure you have access to the ${GITHUB_ORG} GitHub org — run \`gh auth login\` or set up a GitHub SSH key.`);
			process.exit(1);
		}

		s.message("Initializing git (clean history)...");
		rmSync(resolve(targetDir, ".git"), { recursive: true, force: true });
		await run("git", ["init"], { cwd: targetDir });
		s.stop("Template cloned, git initialized (clean history).");

		s.start("Configuring project...");
		const configSteps = [
			["Updating package name...", () => updatePackageName(targetDir, projectName)],
			["Setting Sanity studio title...", () => updateSanityTitle(targetDir, projectTitle)],
			["Writing grid config...", () => writeGridConfig(targetDir, grid)],
			["Removing secrets...", () => removeSecrets(targetDir)],
			!ecommerceSupport && ["Removing Shopify e-commerce files...", () => removeShopifyEcommerce(targetDir)],
		].filter(Boolean);
		for (const [message, run] of configSteps) {
			s.message(message);
			// Yield so the spinner can render between synchronous fs steps.
			await new Promise((r) => setImmediate(r));
			run();
		}
		s.stop("Project configured.");

		if (installDeps) {
			s.start("Installing dependencies with bun...");
			// Async spawn keeps the event loop free so the spinner animates during install.
			const install = await spawnAsync("bun", ["install"], { cwd: targetDir, timeout: 120_000 });
			if (install.status === 0) {
				s.stop("Dependencies installed.");
			} else {
				s.stop("Install failed.");
				p.log.warn("bun install failed. Run it manually after setup.");
			}
		}
	}

	if (createSanityProject) {
		p.log.step("Authenticating with Sanity...");

		const loginResult = spawnSync(
			"bunx",
			["sanity@latest", "login"],
			{ cwd: targetDir, stdio: "inherit", timeout: 300_000 },
		);

		if (loginResult.status !== 0) {
			p.log.error("Sanity login failed.");
			process.exit(1);
		}

		p.log.step("Creating Sanity project...");

		const result = spawnSync(
			"bunx",
			["sanity@latest", "projects", "create", projectTitle, "--dataset=production", "--json", "-y"],
			{ cwd: targetDir, stdio: ["inherit", "pipe", "inherit"], timeout: 120_000 },
		);

		if (result.status !== 0 || !result.stdout) {
			p.log.error("Sanity project creation failed.");
			process.exit(1);
		}

		const rawOutput = result.stdout.toString().trim();
		let projectId;
		try {
			const jsonMatch = rawOutput.match(/\{[\s\S]*\}/);
			const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : rawOutput);
			projectId = parsed.projectId || parsed.id;
		} catch {
			const idMatch = rawOutput.match(/[a-z0-9]{8,}/i);
			projectId = idMatch?.[0];
		}

		if (!projectId) {
			p.log.error("Could not parse Sanity output:");
			p.log.info(rawOutput || "(empty)");
			process.exit(1);
		}

		p.log.success(`Sanity project created: ${projectId}`);

		p.log.info(
			`Create a SANITY_API_READ_TOKEN (Viewer role — it is sent to editors' browsers during draft mode, never use a write-capable token) at:\nhttps://www.sanity.io/manage/project/${projectId}/api#tokens`,
		);
		const token = await p.password({
			message: "Paste SANITY_API_READ_TOKEN (or leave empty to skip):",
		});
		if (p.isCancel(token)) {
			p.cancel("Cancelled.");
			process.exit(0);
		}

		if (createEnvLocal(targetDir, projectName, projectId, token || undefined)) {
			p.log.success(`Created .env.local with project config`);
		}
	}

	if (createGithubRepo) {
		await createGithubRepository(targetDir, projectName);
	}

	if (createVercelProject) {
		await linkVercelProject(targetDir, projectName);
		const projectId = readVercelProjectId(targetDir);
		if (!projectId) {
			p.log.warn("Could not read Vercel projectId — skipping env/domain setup.");
		} else {
			s.start("Configuring Vercel project (root directory, env vars, preview domain)...");
			const logs = (
				await Promise.all([
					setVercelRootDirectory(targetDir, projectId, "apps/web"),
					pushEnvToVercel(targetDir, projectId, projectName),
					addVercelPreviewDomain(targetDir, projectId, projectName),
				])
			).flat();
			const failed = logs.some(([level]) => level === "warn");
			if (failed) s.error("Vercel project configured with warnings.");
			else s.stop("Vercel project configured.");
			for (const [level, message] of logs) p.log[level](message);
		}
	}

	p.log.info(`\nProject created at ${targetDir}`);
	p.note(
		[
			`cd ${projectName}`,
			!installDeps ? "bun install" : null,
			!createSanityProject ? "cp .env.sample .env.local  # configure your env vars" : null,
			"bun run dev",
		]
			.filter(Boolean)
			.join("\n"),
		"Next steps",
	);
}

function updatePackageName(targetDir, projectName) {
	const rootPkg = resolve(targetDir, "package.json");
	if (existsSync(rootPkg)) {
		const pkg = JSON.parse(readFileSync(rootPkg, "utf-8"));
		pkg.name = projectName;
		writeFileSync(rootPkg, JSON.stringify(pkg, null, "\t") + "\n");
	}
}

function updateSanityTitle(targetDir, title) {
	const escaped = title.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
	editFile(resolve(targetDir, "apps/sanity/sanity.config.tsx"), [
		[
			/(name:\s*['"]production['"],\s*title:\s*)['"][^'"]*['"]/,
			`$1'${escaped}'`,
		],
	]);
}

function editFile(filePath, replacements) {
	if (!existsSync(filePath)) return;
	let content = readFileSync(filePath, "utf-8");
	for (const [pattern, replacement] of replacements) {
		content = content.replace(pattern, replacement);
	}
	writeFileSync(filePath, content);
}

function writeGridConfig(targetDir, grid) {
	const gridPath = resolve(
		targetDir,
		"packages/config/tailwind/preset/grid.js",
	);
	if (!existsSync(gridPath)) return;

	const content = `/**
 * Grid system configuration from Figma
 * Desktop: ${grid.desktop.columns} columns, ${grid.desktop.gutter}px gutter, ${grid.desktop.margin}px margin
 * Mobile: ${grid.mobile.columns} columns, ${grid.mobile.gutter}px gutter, ${grid.mobile.margin}px margin
 * Tablet uses mobile grid system
 */
export default ${JSON.stringify(grid, null, "\t")}
`;
	writeFileSync(gridPath, content);
}

function removeSecrets(targetDir) {
	const patterns = [
		".env",
		".env.local",
		".env.production",
		".env.development",
	];
	for (const pattern of patterns) {
		const filePath = resolve(targetDir, pattern);
		if (existsSync(filePath)) {
			rmSync(filePath);
		}
	}
}

function removeShopifyEcommerce(targetDir) {
	const dirsToDelete = [
		"packages/shopify",
		"packages/services/shopify",
		"apps/sanity/schemas/objects/shopify",
		"apps/web/src/app/api/shopify",
	];

	const filesToDelete = [
		"packages/config/shopify.mjs",
		"packages/types/shopify-codegen.ts",
		"packages/types/storefront-api-types.d.ts",
		"packages/types/sanity/products.ts",
		"packages/utils/shopify.ts",
		"apps/sanity/utils/shopifyUrls.ts",
		"apps/sanity/plugins/customDocumentActions/shopifyLink.ts",
		"apps/sanity/plugins/customDocumentActions/shopifyDelete.tsx",
		"apps/sanity/plugins/customDocumentActions/types.ts",
		"apps/sanity/components/media/ShopifyDocumentStatus.tsx",
		"apps/sanity/components/inputs/ProductHidden.tsx",
		"apps/sanity/schemas/objects/module/product.tsx",
		"apps/sanity/schemas/objects/module/collection.tsx",
	];

	const shopifyPackages = ["@shopify/", "shopify-", "@local/shopify"];

	for (const dir of dirsToDelete) {
		const dirPath = resolve(targetDir, dir);
		if (existsSync(dirPath)) {
			rmSync(dirPath, { recursive: true, force: true });
		}
	}

	for (const file of filesToDelete) {
		const filePath = resolve(targetDir, file);
		if (existsSync(filePath)) {
			rmSync(filePath);
		}
	}

	for (const pkgPath of findPackageJsonFiles(targetDir)) {
		removeShopifyFromPackageJson(pkgPath, shopifyPackages);
	}

	editFile(resolve(targetDir, "apps/sanity/constants.js"), [
		[/export\s+const\s+SHOPIFY_DOCUMENT_TYPES\s*=\s*\[[^\]]*\];?\s*/g, ""],
		[/export\s+const\s+SHOPIFY_STORE_ID\s*=\s*['"][^'"]*['"];?\s*/g, ""],
	]);
	editFile(resolve(targetDir, "apps/sanity/schemas/index.ts"), [
		[/^.*import.*shopifyObjects.*$\n?/gm, ""],
		[/,?\s*\.\.\.shopifyObjects/g, ""],
		[/\.\.\.shopifyObjects,?\s*/g, ""],
	]);
	editFile(resolve(targetDir, "apps/sanity/plugins/customDocumentActions/index.ts"), [
		[/^.*import.*SHOPIFY_DOCUMENT_TYPES.*$\n?/gm, ""],
		[/^.*import.*shopifyLink.*$\n?/gm, ""],
		[/^.*import.*shopifyDelete.*$\n?/gm, ""],
		[/^.*SHOPIFY_DOCUMENT_TYPES.*$\n?/gm, ""],
		[/^.*shopifyLink.*$\n?/gm, ""],
		[/^.*shopifyDelete.*$\n?/gm, ""],
	]);
}

function findPackageJsonFiles(dir, files = []) {
	const entries = readdirSync(dir, { withFileTypes: true });
	for (const entry of entries) {
		if (entry.name === "node_modules") continue;
		const fullPath = resolve(dir, entry.name);
		if (entry.isDirectory()) {
			findPackageJsonFiles(fullPath, files);
		} else if (entry.name === "package.json") {
			files.push(fullPath);
		}
	}
	return files;
}

function removeShopifyFromPackageJson(pkgPath, patterns) {
	const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
	let modified = false;

	for (const depType of ["dependencies", "devDependencies", "peerDependencies"]) {
		if (!pkg[depType]) continue;
		for (const depName of Object.keys(pkg[depType])) {
			if (patterns.some((p) => depName.includes(p))) {
				delete pkg[depType][depName];
				modified = true;
			}
		}
	}

	if (modified) {
		writeFileSync(pkgPath, JSON.stringify(pkg, null, "\t") + "\n");
	}
}

async function isGhAuthed() {
	const { status } = await spawnAsync("gh", ["auth", "status"]);
	return status === 0;
}

async function createGithubRepository(targetDir, projectName) {
	const s = p.spinner();
	const fullRepo = `${GITHUB_ORG}/${projectName}`;
	s.start("Checking GitHub authentication...");

	if (!(await isGhAuthed())) {
		s.error("GitHub CLI not ready.");
		p.log.error("gh CLI not installed or not authenticated. Run 'gh auth login' and retry.");
		process.exit(1);
	}

	s.message("Committing on main...");
	if (!existsSync(resolve(targetDir, ".git"))) {
		await run("git", ["init", "-b", "main"], { cwd: targetDir });
	} else {
		await spawnAsync("git", ["symbolic-ref", "HEAD", "refs/heads/main"], { cwd: targetDir });
	}

	try {
		await run("git", ["add", "."], { cwd: targetDir });
		const staged = await spawnAsync("git", ["diff", "--cached", "--quiet"], { cwd: targetDir });
		if (staged.status !== 0) {
			await run("git", ["commit", "-m", "first commit"], { cwd: targetDir });
		}
	} catch (err) {
		s.error("Git commit failed.");
		p.log.error(err.message);
		process.exit(1);
	}

	s.message(`Creating private repo ${fullRepo} and pushing main...`);
	const result = await spawnAsync(
		"gh",
		["repo", "create", fullRepo, "--private", "--source=.", "--remote=origin", "--push"],
		{ cwd: targetDir, timeout: 120_000 },
	);
	if (result.status !== 0) {
		s.error("GitHub repo creation failed.");
		p.log.error(result.stderr.trim() || "unknown error");
		process.exit(1);
	}

	s.message("Creating staging branch...");
	try {
		await run("git", ["checkout", "-b", "staging"], { cwd: targetDir });
		await run("git", ["push", "-u", "origin", "staging"], { cwd: targetDir, timeout: 120_000 });
		s.stop(`Repo pushed: https://github.com/${fullRepo} (checked out on staging).`);
	} catch (err) {
		s.stop(`Repo pushed to main: https://github.com/${fullRepo}`);
		p.log.warn(`Could not create staging branch: ${err.message}`);
	}
}

async function ensureVercelInstalled(s) {
	const { status, stdout } = await spawnAsync("vercel", ["--version"]);
	if (status === 0 && parseInt(stdout.trim().split(".")[0], 10) >= MIN_VERCEL_VERSION) return;

	s.message("Installing Vercel CLI globally...");
	try {
		await run("bun", ["add", "-g", "vercel@latest"], { timeout: 180_000 });
	} catch (err) {
		s.error("Vercel CLI install failed.");
		p.log.error(`Failed to install Vercel CLI: ${err.message}`);
		process.exit(1);
	}
}

async function linkVercelProject(targetDir, projectName) {
	const s = p.spinner();
	s.start("Checking Vercel CLI...");
	await ensureVercelInstalled(s);

	s.message(`Linking Vercel project ${projectName} (scope: ${VERCEL_SCOPE})...`);
	const result = await spawnAsync(
		"vercel",
		["link", "--yes", "--project", projectName, "--scope", VERCEL_SCOPE],
		{ cwd: targetDir, timeout: 300_000, env: VERCEL_ENV },
	);
	if (result.status !== 0) {
		s.error("Vercel link failed.");
		p.log.error(result.stderr.trim() || "unknown error");
		process.exit(1);
	}
	s.stop(`Vercel project linked: ${projectName} (scope: ${VERCEL_SCOPE}).`);
}

function readVercelProjectId(targetDir) {
	const projectJsonPath = resolve(targetDir, ".vercel/project.json");
	try {
		return JSON.parse(readFileSync(projectJsonPath, "utf-8")).projectId || null;
	} catch {
		return null;
	}
}

// method: "GET"|"POST"|"PATCH"|...; body: object (sent as JSON via stdin) or array of ["-F", "k=v"] pairs
function vercelApi(targetDir, method, path, body) {
	const args = ["api", path, "-X", method, "--scope", VERCEL_SCOPE];
	let input;
	if (Array.isArray(body)) {
		args.push(...body);
	} else if (body) {
		args.push("--input", "-");
		input = JSON.stringify(body);
	}
	return spawnAsync("vercel", args, { cwd: targetDir, input, env: VERCEL_ENV });
}

// The Vercel setup helpers run concurrently under one spinner, so they return
// [level, message] log entries for the caller to print after the spinner stops.
async function setVercelRootDirectory(targetDir, projectId, rootDirectory) {
	// v9 endpoint: rootDirectory not yet supported on v10 PATCH
	const { status, stderr } = await vercelApi(targetDir, "PATCH", `/v9/projects/${projectId}`, { rootDirectory });
	if (status !== 0) {
		return [["warn", `Failed to set root directory: ${stderr.trim() || "unknown error"}`]];
	}
	return [["success", `Root directory set to ${rootDirectory}.`]];
}

async function addVercelPreviewDomain(targetDir, projectId, projectName) {
	const domain = `${projectName}.${PREVIEW_DOMAIN_SUFFIX}`;
	const { status, stderr } = await vercelApi(targetDir, "POST", `/v10/projects/${projectId}/domains`, [
		"-F", `name=${domain}`,
		"-F", "gitBranch=staging",
	]);
	if (status !== 0) {
		return [["warn", `Preview domain add failed: ${stderr.trim() || "unknown error"}`]];
	}
	return [["success", `Preview domain added (targets staging): https://${domain}`]];
}

async function pushEnvToVercel(targetDir, projectId, projectName) {
	const localPath = resolve(targetDir, ".env.local");
	if (!existsSync(localPath)) return [];

	const entries = parseEnvFile(readFileSync(localPath, "utf-8")).filter(
		([, value]) => value !== "",
	);
	if (entries.length === 0) return [];

	const stagingUrl = `https://${projectName}.${PREVIEW_DOMAIN_SUFFIX}`;
	const jobs = [];
	for (const [key, value] of entries) {
		if (key === "NEXT_PUBLIC_BASE_URL") {
			jobs.push(upsertVercelEnv(targetDir, projectId, key, LOCAL_BASE_URL, ["development"]));
			jobs.push(upsertVercelEnv(targetDir, projectId, key, stagingUrl, ["preview"]));
			jobs.push(upsertVercelEnv(targetDir, projectId, key, stagingUrl, ["production"]));
		} else {
			jobs.push(upsertVercelEnv(targetDir, projectId, key, value, ["development", "preview", "production"]));
		}
	}
	const logs = (await Promise.all(jobs)).flat();
	logs.push(["success", `${entries.length} env vars pushed. NEXT_PUBLIC_BASE_URL split per env — update production when domain is known.`]);
	return logs;
}

async function upsertVercelEnv(targetDir, projectId, key, value, target) {
	const { status, stderr } = await vercelApi(
		targetDir,
		"POST",
		`/v10/projects/${projectId}/env?upsert=true`,
		{ key, value, target, type: "encrypted" },
	);
	if (status !== 0) {
		return [["warn", `Failed to push ${key}: ${stderr.trim() || "unknown error"}`]];
	}
	return [];
}

// spawnAsync that rejects on non-zero exit, with stderr as the error message.
async function run(cmd, args, opts) {
	const result = await spawnAsync(cmd, args, opts);
	if (result.status !== 0) {
		throw new Error(result.stderr.trim() || `${cmd} ${args.join(" ")} exited with ${result.status}`);
	}
	return result;
}

function spawnAsync(cmd, args, { cwd, input, env, timeout = 30_000 } = {}) {
	return new Promise((resolve) => {
		const child = spawn(cmd, args, { cwd, env, timeout });
		let stdout = "";
		let stderr = "";
		let settled = false;
		const done = (result) => {
			if (settled) return;
			settled = true;
			resolve(result);
		};
		child.stdout.on("data", (d) => (stdout += d.toString()));
		child.stderr.on("data", (d) => (stderr += d.toString()));
		child.on("close", (status) => done({ status, stdout, stderr }));
		child.on("error", (err) => done({ status: -1, stdout, stderr: err.message }));
		if (input !== undefined) {
			child.stdin.on("error", () => {});
			child.stdin.end(input);
		} else {
			child.stdin.end();
		}
	});
}

function parseEnvFile(content) {
	const entries = [];
	for (const line of content.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const eq = trimmed.indexOf("=");
		if (eq === -1) continue;
		entries.push([trimmed.slice(0, eq).trim(), trimmed.slice(eq + 1).trim()]);
	}
	return entries;
}

function createEnvLocal(targetDir, projectName, projectId, apiToken) {
	const samplePath = resolve(targetDir, ".env.sample");
	const localPath = resolve(targetDir, ".env.local");

	if (!existsSync(localPath)) {
		if (!existsSync(samplePath)) return false;
		copyFileSync(samplePath, localPath);
	}

	const vars = {
		NEXT_PUBLIC_SANITY_DATASET: "production",
		NEXT_PUBLIC_SANITY_PROJECT_ID: projectId,
		SANITY_STUDIO_PROJECT_ID: projectId,
		SANITY_STUDIO_HOST: projectName,
		SANITY_WEBHOOK_SECRET: randomBytes(32).toString("hex"),
		// The draft-mode endpoint fails closed without it — preview is dead until it's set.
		SANITY_STUDIO_DRAFT_SECRET: randomBytes(32).toString("hex"),
	};
	if (!envVarHas(localPath, "NEXT_PUBLIC_BASE_URL")) {
		vars.NEXT_PUBLIC_BASE_URL = "https://web.localhost";
	}
	if (apiToken) vars.SANITY_API_READ_TOKEN = apiToken;

	updateEnvFile(localPath, vars);
	return true;
}

function envVarHas(filePath, key) {
	if (!existsSync(filePath)) return false;
	const content = readFileSync(filePath, "utf-8");
	const match = content.match(new RegExp(`^${key}=(.*)$`, "m"));
	return match && match[1].trim() !== "";
}

function updateEnvFile(filePath, vars) {
	if (!existsSync(filePath)) return;

	let content = readFileSync(filePath, "utf-8");
	for (const [key, value] of Object.entries(vars)) {
		const regex = new RegExp(`^${key}=.*$`, "m");
		if (regex.test(content)) {
			content = content.replace(regex, `${key}=${value}`);
		} else {
			content += `\n${key}=${value}`;
		}
	}
	writeFileSync(filePath, content);
}

