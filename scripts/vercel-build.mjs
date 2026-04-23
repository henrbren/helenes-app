import { spawnSync } from 'node:child_process';

if (!process.env.EXPO_PUBLIC_API_URL?.trim() && process.env.VERCEL_URL) {
  process.env.EXPO_PUBLIC_API_URL = `https://${process.env.VERCEL_URL}`;
}

const result = spawnSync('npx', ['expo', 'export', '--platform', 'web'], {
  stdio: 'inherit',
  shell: true,
  env: process.env,
});

process.exit(result.status === null ? 1 : result.status);
