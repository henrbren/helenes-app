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

process.exit(result.status === null ? 1 : result.status);
