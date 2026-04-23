import { cpSync, existsSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

if (!process.env.EXPO_PUBLIC_API_URL?.trim()) {
  const raw =
    process.env.VERCEL_URL ||
    process.env.VERCEL_BRANCH_URL ||
    process.env.VERCEL_PROJECT_PRODUCTION_URL ||
    '';
  const host = raw.replace(/^https?:\/\//i, '').replace(/\/$/, '');
  if (host) process.env.EXPO_PUBLIC_API_URL = `https://${host}`;
}

const result = spawnSync('npx', ['expo', 'export', '--platform', 'web'], {
  stdio: 'inherit',
  shell: true,
  env: process.env,
});

if (result.error) {
  console.error(result.error);
  process.exit(1);
}
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

// Vercel: ikke bruk bare outputDirectory=dist — da kan /api-funksjoner fra repo bli utelatt.
// Statiske filer i public/ + api/ i roten er støttet samtidig.
if (existsSync('public')) rmSync('public', { recursive: true });
cpSync('dist', 'public', { recursive: true });
