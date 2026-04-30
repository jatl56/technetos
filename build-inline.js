/**
 * Build script: Inlines all external CSS and JS into master.html and student.html
 * so they work as self-contained files without needing to load separate .js/.css files.
 *
 * Portable: uses __dirname so it works from any clone path.
 * Resilient: skips optional artifacts (style.css, index.html, app.js) that
 * are not part of the multiplayer codebase.
 */
const fs = require('fs');
const path = require('path');

// BASE = the repo root. The script lives at the repo root by convention,
// but if someone moves it under a subfolder (e.g. `src/`), detect that
// by looking for the `multiplayer/` directory and walk up if needed.
function findBase() {
  let dir = __dirname;
  for (let i = 0; i < 4; i++) {
    if (fs.existsSync(path.join(dir, 'multiplayer', 'order-engine.js'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fallback to script's own directory; will fail with a clear ENOENT later
  return __dirname;
}

const BASE = findBase();
const MULTI = path.join(BASE, 'multiplayer');

function readMaybe(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

function readRequired(filePath, label) {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch (e) {
    if (e.code === 'ENOENT') {
      throw new Error(`Required source missing: ${label} (${filePath})`);
    }
    throw e;
  }
}

// Read all the source files
const styleCss = readMaybe(path.join(BASE, 'style.css'));
const supabaseConfig = readRequired(path.join(MULTI, 'supabase-config.js'), 'supabase-config.js');
const authJs = readRequired(path.join(MULTI, 'auth.js'), 'auth.js');
const roomManagerJs = readRequired(path.join(MULTI, 'room-manager.js'), 'room-manager.js');
const priceEngineJs = readRequired(path.join(MULTI, 'price-engine.js'), 'price-engine.js');
const orderEngineJs = readRequired(path.join(MULTI, 'order-engine.js'), 'order-engine.js');
const taEngineJs = readRequired(path.join(MULTI, 'ta-engine.js'), 'ta-engine.js');
const historicalDataJs = readRequired(path.join(MULTI, 'historical-data.js'), 'historical-data.js');
const historicalBundleJs = readRequired(path.join(MULTI, 'historical-bundle.js'), 'historical-bundle.js');

// Polyfill injected BEFORE Supabase CDN to prevent SecurityError on navigator.locks
// In sandboxed iframes, locks exists but .request() throws SecurityError
// We override it with a simple pass-through implementation
const locksPolyfill = `<script>
(function() {
  var noop = { held: [], pending: [] };
  var shim = {
    request: function(n, a, b) { var f = typeof a === 'function' ? a : b; return f ? Promise.resolve(f({ name: n, mode: 'exclusive' })) : Promise.resolve(); },
    query: function() { return Promise.resolve(noop); }
  };
  // Always install our shim — it works everywhere and avoids SecurityError
  Object.defineProperty(navigator, 'locks', { value: shim, writable: true, configurable: true });
})();
</script>`;

function buildInlineHtml(htmlFile, jsModules) {
  let html = fs.readFileSync(path.join(MULTI, htmlFile), 'utf-8');

  // Replace <link rel="stylesheet" href="../style.css"> with inline <style> if present
  if (styleCss) {
    html = html.replace(
      '<link rel="stylesheet" href="../style.css">',
      `<style>\n${styleCss}\n</style>`
    );
  }

  // Inject locks polyfill BEFORE the Supabase CDN script
  html = html.replace(
    '<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>',
    locksPolyfill + '\n<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>'
  );

  // Replace each <script src="./xxx.js"></script> with inline <script>
  for (const mod of jsModules) {
    const srcTag = `<script src="./${mod.file}"></script>`;
    const inlineTag = `<script>\n${mod.content}\n</script>`;
    html = html.replace(srcTag, inlineTag);
  }

  return html;
}

// Master uses all JS modules including historical data
const masterModules = [
  { file: 'supabase-config.js', content: supabaseConfig },
  { file: 'auth.js', content: authJs },
  { file: 'room-manager.js', content: roomManagerJs },
  { file: 'historical-data.js', content: historicalDataJs },
  { file: 'historical-bundle.js', content: historicalBundleJs },
  { file: 'price-engine.js', content: priceEngineJs },
  { file: 'order-engine.js', content: orderEngineJs },
  { file: 'ta-engine.js', content: taEngineJs },
];

// Student uses 5 (no price-engine, no historical bundle — receives prices via realtime)
const studentModules = [
  { file: 'supabase-config.js', content: supabaseConfig },
  { file: 'auth.js', content: authJs },
  { file: 'room-manager.js', content: roomManagerJs },
  { file: 'order-engine.js', content: orderEngineJs },
  { file: 'ta-engine.js', content: taEngineJs },
];

const masterHtml = buildInlineHtml('master.html', masterModules);
const studentHtml = buildInlineHtml('student.html', studentModules);

// Write to output directory
const OUT = path.join(BASE, 'dist');
fs.mkdirSync(path.join(OUT, 'multiplayer'), { recursive: true });
fs.writeFileSync(path.join(OUT, 'multiplayer', 'master.html'), masterHtml);
fs.writeFileSync(path.join(OUT, 'multiplayer', 'student.html'), studentHtml);

// ALSO write to repo root so Vercel serves the latest build directly.
// Vercel's site root is the repo root; it serves /master.html and /student.html.
fs.writeFileSync(path.join(BASE, 'master.html'), masterHtml);
fs.writeFileSync(path.join(BASE, 'student.html'), studentHtml);

// Optionally copy single-player artifacts if they exist (for local /index.html access)
const optionals = ['style.css', 'index.html', 'app.js'];
for (const f of optionals) {
  const src = path.join(BASE, f);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, path.join(OUT, f));
  }
}

console.log('Built inline versions:');
console.log('  dist/multiplayer/master.html  -', (masterHtml.length / 1024).toFixed(1), 'KB');
console.log('  dist/multiplayer/student.html -', (studentHtml.length / 1024).toFixed(1), 'KB');
console.log('  master.html (repo root)       -', (masterHtml.length / 1024).toFixed(1), 'KB');
console.log('  student.html (repo root)      -', (studentHtml.length / 1024).toFixed(1), 'KB');
