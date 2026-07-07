import { execSync, spawn, spawnSync } from "node:child_process";
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

		const attempts = [
			{
				label: "SSH",
				cmd: `git clone --depth 1 --branch ${template.branch} ${sshRepo} ${projectName}`,
				env: { ...process.env, GIT_SSH_COMMAND: "ssh -o BatchMode=yes" },
			},
			ghRepo && {
				label: "gh credentials",
				cmd: `git -c credential.helper= -c credential.helper="!gh auth git-credential" clone --depth 1 --branch ${template.branch} ${httpsRepo} ${projectName}`,
				env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
				canRun: isGhAuthed,
			},
			{
				label: "HTTPS",
				cmd: `git clone --depth 1 --branch ${template.branch} ${httpsRepo} ${projectName}`,
				env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
			},
		].filter(Boolean);

		let lastErr;
		let cloned = false;
		let prev;
		for (const attempt of attempts) {
			if (attempt.canRun && !attempt.canRun()) continue;
			if (prev) {
				s.message(`${prev.label} clone failed, trying ${attempt.label}...`);
				rmSync(targetDir, { recursive: true, force: true });
			}
			try {
				execSync(attempt.cmd, { stdio: "pipe", env: attempt.env });
				cloned = true;
				break;
			} catch (err) {
				lastErr = err;
				prev = attempt;
			}
		}

		if (!cloned) {
			s.stop("Clone failed.");
			p.log.error(
				`Failed to clone template repo.\n${lastErr?.stderr?.toString() || lastErr?.message || "unknown error"}`,
			);
			p.log.info(`Make sure you have access to the ${GITHUB_ORG} GitHub org — run \`gh auth login\` or set up a GitHub SSH key.`);
			process.exit(1);
		}

		s.stop("Template cloned.");

		rmSync(resolve(targetDir, ".git"), { recursive: true, force: true });
		execSync("git init", { cwd: targetDir, stdio: "pipe" });
		p.log.success("Git initialized (clean history).");

		s.start("Configuring project...");
		updatePackageName(targetDir, projectName);
		updateSanityTitle(targetDir, projectTitle);
		writeGridConfig(targetDir, grid);
		removeSecrets(targetDir);
		if (!ecommerceSupport) {
			removeShopifyEcommerce(targetDir);
		}
		s.stop("Project configured.");

		if (installDeps) {
			s.start("Installing dependencies with bun...");
			try {
				execSync("bun install", {
					cwd: targetDir,
					stdio: "pipe",
					timeout: 120_000,
				});
				s.stop("Dependencies installed.");
			} catch {
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
		createGithubRepository(targetDir, projectName);
	}

	if (createVercelProject) {
		linkVercelProject(targetDir, projectName);
		const projectId = readVercelProjectId(targetDir);
		if (!projectId) {
			p.log.warn("Could not read Vercel projectId — skipping env/domain setup.");
		} else {
			await Promise.all([
				setVercelRootDirectory(targetDir, projectId, "apps/web"),
				pushEnvToVercel(targetDir, projectId, projectName),
				addVercelPreviewDomain(targetDir, projectId, projectName),
			]);
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

function isGhAuthed() {
	try {
		execSync("gh auth status", { stdio: "pipe" });
		return true;
	} catch {
		return false;
	}
}

function createGithubRepository(targetDir, projectName) {
	if (!isGhAuthed()) {
		p.log.error("gh CLI not installed or not authenticated. Run 'gh auth login' and retry.");
		process.exit(1);
	}

	if (!existsSync(resolve(targetDir, ".git"))) {
		execSync("git init -b main", { cwd: targetDir, stdio: "pipe" });
	} else {
		try {
			execSync("git symbolic-ref HEAD refs/heads/main", { cwd: targetDir, stdio: "pipe" });
		} catch {}
	}

	try {
		execSync("git add .", { cwd: targetDir, stdio: "pipe" });
		execSync("git diff --cached --quiet", { cwd: targetDir, stdio: "pipe" });
	} catch {
		p.log.step("Committing on main...");
		try {
			execSync('git commit -m "first commit"', { cwd: targetDir, stdio: "pipe" });
		} catch (err) {
			p.log.error(`Git commit failed: ${err.stderr?.toString() || err.message}`);
			process.exit(1);
		}
	}

	const fullRepo = `${GITHUB_ORG}/${projectName}`;
	p.log.step(`Creating private repo ${fullRepo}...`);
	const result = spawnSync(
		"gh",
		["repo", "create", fullRepo, "--private", "--source=.", "--remote=origin", "--push"],
		{ cwd: targetDir, stdio: "inherit", timeout: 120_000 },
	);
	if (result.status !== 0) {
		p.log.error("GitHub repo creation failed.");
		process.exit(1);
	}
	p.log.success(`Repo pushed to main: https://github.com/${fullRepo}`);

	p.log.step("Creating staging branch...");
	try {
		execSync("git checkout -b staging", { cwd: targetDir, stdio: "pipe" });
		execSync("git push -u origin staging", { cwd: targetDir, stdio: "pipe" });
		p.log.success("Checked out on staging.");
	} catch (err) {
		p.log.warn(`Could not create staging branch: ${err.stderr?.toString() || err.message}`);
	}
}

function ensureVercelInstalled() {
	try {
		const version = execSync("vercel --version", { stdio: "pipe" }).toString().trim();
		const major = parseInt(version.split(".")[0], 10);
		if (major >= MIN_VERCEL_VERSION) return;
	} catch {}

	p.log.step("Installing Vercel CLI globally...");
	try {
		execSync("bun add -g vercel@latest", { stdio: "pipe", timeout: 180_000 });
	} catch (err) {
		p.log.error(`Failed to install Vercel CLI: ${err.stderr?.toString() || err.message}`);
		process.exit(1);
	}
}

function linkVercelProject(targetDir, projectName) {
	ensureVercelInstalled();

	p.log.step(`Linking Vercel project ${projectName} (scope: ${VERCEL_SCOPE})...`);
	const result = spawnSync(
		"vercel",
		["link", "--yes", "--project", projectName, "--scope", VERCEL_SCOPE],
		{ cwd: targetDir, stdio: "inherit", timeout: 300_000, env: VERCEL_ENV },
	);
	if (result.status !== 0) {
		p.log.error("Vercel link failed.");
		process.exit(1);
	}
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

async function setVercelRootDirectory(targetDir, projectId, rootDirectory) {
	p.log.step(`Setting Vercel root directory to ${rootDirectory}...`);
	// v9 endpoint: rootDirectory not yet supported on v10 PATCH
	const { status, stderr } = await vercelApi(targetDir, "PATCH", `/v9/projects/${projectId}`, { rootDirectory });
	if (status !== 0) {
		p.log.warn(`Failed to set root directory: ${stderr.trim() || "unknown error"}`);
	}
}

async function addVercelPreviewDomain(targetDir, projectId, projectName) {
	const domain = `${projectName}.${PREVIEW_DOMAIN_SUFFIX}`;
	p.log.step(`Adding preview domain ${domain} (targets staging)...`);
	const { status, stderr } = await vercelApi(targetDir, "POST", `/v10/projects/${projectId}/domains`, [
		"-F", `name=${domain}`,
		"-F", "gitBranch=staging",
	]);
	if (status !== 0) {
		p.log.warn(`Preview domain add failed: ${stderr.trim() || "unknown error"}`);
	} else {
		p.log.success(`Preview domain added: https://${domain}`);
	}
}

async function pushEnvToVercel(targetDir, projectId, projectName) {
	const localPath = resolve(targetDir, ".env.local");
	if (!existsSync(localPath)) return;

	const entries = parseEnvFile(readFileSync(localPath, "utf-8")).filter(
		([, value]) => value !== "",
	);
	if (entries.length === 0) return;

	const stagingUrl = `https://${projectName}.${PREVIEW_DOMAIN_SUFFIX}`;
	p.log.step(`Pushing ${entries.length} env vars to Vercel...`);

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
	await Promise.all(jobs);

	p.log.success(`Env vars pushed. NEXT_PUBLIC_BASE_URL split per env — update production when domain is known.`);
}

async function upsertVercelEnv(targetDir, projectId, key, value, target) {
	const { status, stderr } = await vercelApi(
		targetDir,
		"POST",
		`/v10/projects/${projectId}/env?upsert=true`,
		{ key, value, target, type: "encrypted" },
	);
	if (status !== 0) {
		p.log.warn(`Failed to push ${key}: ${stderr.trim() || "unknown error"}`);
	}
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

