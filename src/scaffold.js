import { execSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import * as p from "@clack/prompts";

/**
 * @param {{ projectName: string, template: { repo: string, branch: string, label: string }, grid: object, installDeps: boolean, ecommerceSupport: boolean, createSanityProject: boolean }} options
 */
export async function scaffold({ projectName, template, grid, installDeps, ecommerceSupport, createSanityProject }) {
	const targetDir = resolve(process.cwd(), projectName);

	if (existsSync(targetDir)) {
		p.log.error(`Directory "${projectName}" already exists.`);
		process.exit(1);
	}

	// Clone the template repo
	const s = p.spinner();
	s.start(`Cloning ${template.label} template...`);

	const httpsRepo = template.repo.replace(
		/^git@github\.com:/,
		"https://github.com/",
	);

	try {
		execSync(
			`git clone --depth 1 --branch ${template.branch} ${template.repo} ${projectName}`,
			{ stdio: "pipe" },
		);
	} catch {
		// Clean up partial clone before HTTPS fallback
		if (existsSync(targetDir)) {
			rmSync(targetDir, { recursive: true, force: true });
		}
		s.message("SSH clone failed, trying HTTPS...");
		try {
			execSync(
				`git clone --depth 1 --branch ${template.branch} ${httpsRepo} ${projectName}`,
				{ stdio: "pipe" },
			);
		} catch (err) {
			s.stop("Clone failed.");
			p.log.error(
				`Failed to clone template repo.\n${err.stderr?.toString() || err.message}`,
			);
			p.log.info("Make sure you have access to the Numbered-com GitHub org.");
			process.exit(1);
		}
	}

	s.stop("Template cloned.");

	// Remove .git history and reinitialize
	rmSync(resolve(targetDir, ".git"), { recursive: true, force: true });
	execSync("git init", { cwd: targetDir, stdio: "pipe" });
	p.log.success("Git initialized (clean history).");

	// Update project name in package.json files
	s.start("Configuring project...");
	updatePackageName(targetDir, projectName);

	// Write grid configuration
	writeGridConfig(targetDir, grid);

	// Remove .env files (secrets)
	removeSecrets(targetDir);

	// Remove Shopify ecommerce if not needed
	if (!ecommerceSupport) {
		removeShopifyEcommerce(targetDir);
	}

	s.stop("Project configured.");

	// Install dependencies
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

	// Create Sanity project
	if (createSanityProject) {
		p.log.step("Authenticating with Sanity...");

		// Ensure user is logged in (interactive)
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
			["sanity@latest", "projects", "create", projectName, "--dataset=production", "--json", "-y"],
			{ cwd: targetDir, stdio: ["inherit", "pipe", "inherit"], timeout: 120_000 },
		);

		if (result.status !== 0 || !result.stdout) {
			p.log.error("Sanity project creation failed.");
			process.exit(1);
		}

		const rawOutput = result.stdout.toString().trim();
		let projectId;
		try {
			// Try to extract JSON from output (may contain extra text)
			const jsonMatch = rawOutput.match(/\{[\s\S]*\}/);
			const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : rawOutput);
			projectId = parsed.projectId || parsed.id;
		} catch {
			// Fallback: try to extract project ID with regex
			const idMatch = rawOutput.match(/[a-z0-9]{8,}/i);
			projectId = idMatch?.[0];
		}

		if (!projectId) {
			p.log.error("Could not parse Sanity output:");
			p.log.info(rawOutput || "(empty)");
			process.exit(1);
		}

		p.log.success(`Sanity project created: ${projectId}`);

		// Copy .env.sample to .env.local and populate
		const envLocalCreated = createEnvLocal(targetDir, projectName, projectId);
		if (envLocalCreated) {
			p.log.success(`Created .env.local with project config`);
			p.log.info(
				`Create SANITY_API_TOKEN at: https://www.sanity.io/manage/project/${projectId}/api#tokens`,
			);
		}
	}

	// Summary
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
	// Directories to remove entirely
	const dirsToDelete = [
		"packages/shopify",
		"packages/services/shopify",
		"apps/sanity/schemas/objects/shopify",
		"apps/web/src/app/api/shopify",
	];

	// Individual files to delete
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

	// Package patterns to strip from package.json
	const shopifyPackages = [
		"@shopify/",
		"shopify-",
		"@local/shopify",
	];

	// Remove directories
	for (const dir of dirsToDelete) {
		const dirPath = resolve(targetDir, dir);
		if (existsSync(dirPath)) {
			rmSync(dirPath, { recursive: true, force: true });
		}
	}

	// Remove individual files
	for (const file of filesToDelete) {
		const filePath = resolve(targetDir, file);
		if (existsSync(filePath)) {
			rmSync(filePath);
		}
	}

	// Remove Shopify packages from all package.json files
	const packageJsonPaths = findPackageJsonFiles(targetDir);
	for (const pkgPath of packageJsonPaths) {
		removeShopifyFromPackageJson(pkgPath, shopifyPackages);
	}

	// Clean up files that need modification
	cleanupSanityConstants(targetDir);
	cleanupSanitySchemaIndex(targetDir);
	cleanupSanityDocumentActions(targetDir);
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

function createEnvLocal(targetDir, projectName, projectId) {
	const samplePath = resolve(targetDir, ".env.sample");
	const localPath = resolve(targetDir, ".env.local");
	if (!existsSync(samplePath)) return false;

	copyFileSync(samplePath, localPath);

	const vars = {
		NEXT_PUBLIC_BASE_URL: "https://web.localhost",
		NEXT_PUBLIC_SANITY_DATASET: "production",
		NEXT_PUBLIC_SANITY_PROJECT_ID: projectId,
		SANITY_STUDIO_PROJECT_ID: projectId,
		SANITY_STUDIO_HOST: projectName,
		SANITY_WEBHOOK_SECRET: randomBytes(32).toString("hex"),
	};

	let content = readFileSync(localPath, "utf-8");
	for (const [key, value] of Object.entries(vars)) {
		const regex = new RegExp(`^${key}=.*$`, "m");
		if (regex.test(content)) {
			content = content.replace(regex, `${key}=${value}`);
		} else {
			content += `\n${key}=${value}`;
		}
	}
	writeFileSync(localPath, content);
	return true;
}

function cleanupSanityConstants(targetDir) {
	const filePath = resolve(targetDir, "apps/sanity/constants.js");
	if (!existsSync(filePath)) return;

	let content = readFileSync(filePath, "utf-8");
	// Remove SHOPIFY_DOCUMENT_TYPES export
	content = content.replace(/export\s+const\s+SHOPIFY_DOCUMENT_TYPES\s*=\s*\[[^\]]*\];?\s*/g, "");
	// Remove SHOPIFY_STORE_ID export
	content = content.replace(/export\s+const\s+SHOPIFY_STORE_ID\s*=\s*['"][^'"]*['"];?\s*/g, "");
	writeFileSync(filePath, content);
}

function cleanupSanitySchemaIndex(targetDir) {
	const filePath = resolve(targetDir, "apps/sanity/schemas/index.ts");
	if (!existsSync(filePath)) return;

	let content = readFileSync(filePath, "utf-8");
	// Remove shopifyObjects import (commented or not)
	content = content.replace(/^.*import.*shopifyObjects.*$\n?/gm, "");
	// Remove shopifyObjects from exports
	content = content.replace(/,?\s*\.\.\.shopifyObjects/g, "");
	content = content.replace(/\.\.\.shopifyObjects,?\s*/g, "");
	writeFileSync(filePath, content);
}

function cleanupSanityDocumentActions(targetDir) {
	const filePath = resolve(targetDir, "apps/sanity/plugins/customDocumentActions/index.ts");
	if (!existsSync(filePath)) return;

	let content = readFileSync(filePath, "utf-8");
	// Remove SHOPIFY_DOCUMENT_TYPES import
	content = content.replace(/^.*import.*SHOPIFY_DOCUMENT_TYPES.*$\n?/gm, "");
	// Remove shopify action imports
	content = content.replace(/^.*import.*shopifyLink.*$\n?/gm, "");
	content = content.replace(/^.*import.*shopifyDelete.*$\n?/gm, "");
	// Remove shopify-related action registrations (lines referencing shopify actions)
	content = content.replace(/^.*SHOPIFY_DOCUMENT_TYPES.*$\n?/gm, "");
	content = content.replace(/^.*shopifyLink.*$\n?/gm, "");
	content = content.replace(/^.*shopifyDelete.*$\n?/gm, "");
	writeFileSync(filePath, content);
}
