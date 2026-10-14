// Metro config for the pnpm monorepo.
// Expo SDK 52+ detects the workspace automatically (watchFolders = repo root, nodeModulesPaths for
// app + root). We keep pnpm's default isolated linker (the root .npmrc is untouched, no
// node-linker=hoisted); Metro follows the node_modules/.pnpm symlinks by default since SDK 53,
// and package "exports" are honoured by default.
//
// @bh/* workspace packages ship TypeScript source with explicit `.ts` relative imports
// (e.g. `export * from './money.ts'`); Metro resolves those as exact file paths, so no extra
// resolver config is required.
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

// Explicit for clarity (matches Expo's auto-detected monorepo defaults).
config.watchFolders = Array.from(new Set([...(config.watchFolders ?? []), workspaceRoot]));
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];

module.exports = config;
