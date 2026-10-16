// Netlify functions are CommonJS source in a "type":"module" package (esbuild bundles them as CJS in deploy).
// Load them the same way here: evaluate as CommonJS with a require rooted at the function's directory.
const fs = require('fs'), path = require('path'), { createRequire } = require('module');
function loadFunction(name) {
  const file = path.resolve(__dirname, '../../netlify/functions', name + '.js');
  const mod = { exports: {} };
  const req = createRequire(file);
  new Function('require', 'module', 'exports', fs.readFileSync(file, 'utf8'))(req, mod, mod.exports);
  return mod.exports;
}
module.exports = { loadFunction };
