import { copyFileSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const WEB_DISPLAY_NAME = 'Treningslogg';
const FAVICON_SRC = join(process.cwd(), 'assets/favicon.png');
const distDir = process.argv[2] ? join(process.cwd(), process.argv[2]) : join(process.cwd(), 'dist');

/**
 * Gjenbruker én fil (assets/favicon.png) for PNG-favicon og apple-touch (iOS "Legg til på Hjem-skjerm").
 * Kalles etter `expo export --platform web`.
 */
if (!existsSync(FAVICON_SRC)) {
  console.error('apply-web-icons: fant ikke', FAVICON_SRC);
  process.exit(1);
}
const indexPath = join(distDir, 'index.html');
if (!existsSync(indexPath)) {
  console.error('apply-web-icons: fant ikke', indexPath);
  process.exit(1);
}

copyFileSync(FAVICON_SRC, join(distDir, 'favicon.png'));

let html = readFileSync(indexPath, 'utf8');

if (!html.includes('href="/favicon.png"')) {
  const headIcons = `  <link rel="icon" type="image/png" href="/favicon.png" />
  <link rel="icon" type="image/x-icon" href="/favicon.ico" />
  <link rel="apple-touch-icon" href="/favicon.png" />
  <meta name="apple-mobile-web-app-title" content="${WEB_DISPLAY_NAME}" />
`;
  if (html.includes('href="/favicon.ico"')) {
    html = html.replace(/\s*<link rel="icon" href="\/favicon\.ico" \/>/i, headIcons);
  } else {
    html = html.replace('</head>', headIcons + '\n  </head>');
  }
}

if (html.includes('<title>training-log-ios</title>')) {
  html = html.replace(
    '<title>training-log-ios</title>',
    `<title>${WEB_DISPLAY_NAME}</title>`,
  );
}

html = html.replace('</style>  <link', '</style>\n  <link');

writeFileSync(indexPath, html, 'utf8');
console.log('apply-web-icons: oppdatert', join(distDir, 'index.html'), 'og favicon.png');
