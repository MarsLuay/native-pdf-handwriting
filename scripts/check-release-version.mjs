import { readFile } from 'node:fs/promises';

const tag = process.env.GITHUB_REF_NAME;
if (!tag) {
	throw new Error('GITHUB_REF_NAME is required to validate a release tag.');
}

const [manifest, packageJson] = await Promise.all([
	readFile(new URL('../manifest.json', import.meta.url), 'utf8').then(JSON.parse),
	readFile(new URL('../package.json', import.meta.url), 'utf8').then(JSON.parse),
]);

const versions = {
	tag,
	manifest: manifest.version,
	package: packageJson.version,
};

if (new Set(Object.values(versions)).size !== 1) {
	throw new Error(
		`Release version mismatch: tag=${versions.tag}, manifest=${versions.manifest}, package=${versions.package}.`,
	);
}

console.log(`Release version verified: ${tag}`);
