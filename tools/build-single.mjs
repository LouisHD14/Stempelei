// Baut dist/stempelei.html: eine einzelne Datei mit CSS, Schriften und Skripten eingebettet.
// Aufruf: node tools/build-single.mjs [--fragment]
//   --fragment  ohne <!doctype>, <html>, <head> und <body> (für das Hosting als Claude-Artefakt)
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fragment = process.argv.includes('--fragment');
const pub = join(root, 'public');
const read = (p) => readFileSync(join(pub, p), 'utf8');

const html = read('index.html');

// CSS mit Schriften als data-URI
const cssPath = 'assets/css/style.css';
const css = read(cssPath).replace(/url\("\.\.\/fonts\/([^"]+\.woff2)"\)/g, (_, file) => {
  const b64 = readFileSync(join(pub, 'assets/fonts', file)).toString('base64');
  return `url("data:font/woff2;base64,${b64}")`;
});
if (/url\("\.\.\//.test(css)) throw new Error('CSS enthält noch relative URLs');

// Skripte einbetten; "</script" darf im Inhalt nicht vorkommen
const inlineScript = (src) => {
  const code = read(src);
  if (/<\/script/i.test(code)) throw new Error(`${src} enthält </script>`);
  return `<script>\n${code}\n</script>`;
};

const bodyMatch = /<body>([\s\S]*)<\/body>/.exec(html);
const titleMatch = /<title>[\s\S]*?<\/title>/.exec(html);
if (!bodyMatch || !titleMatch) throw new Error('index.html: <body> oder <title> fehlt');

const body = bodyMatch[1].replace(/<script src="([^"]+)"><\/script>/g, (_, src) => inlineScript(src));
if (/<script src=/.test(body)) throw new Error('Nicht eingebettetes Skript gefunden');

const headParts = [
  titleMatch[0],
  '<meta name="claude:viewport-fit-sides" content="cover">',
  `<style>\n${css}\n</style>`,
];

const out = fragment
  ? `${headParts.join('\n')}\n${body.trim()}\n`
  : `<!doctype html>\n<html lang="de">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n${headParts.join('\n')}\n</head>\n<body>\n${body.trim()}\n</body>\n</html>\n`;

mkdirSync(join(root, 'dist'), { recursive: true });
const name = fragment ? 'stempelei-fragment.html' : 'stempelei.html';
writeFileSync(join(root, 'dist', name), out);
console.log(`dist/${name}: ${(out.length / 1024).toFixed(0)} KB`);
