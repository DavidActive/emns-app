#!/usr/bin/env node
// Software bill of materials (CycloneDX 1.5, JSON) from package-lock.json: every production dependency with exact version, package URL and integrity hash.
//   node scripts/sbom.cjs [--all] [--out docs/sbom.cdx.json]      (--all includes development tools)
const fs = require('fs');
const path = require('path');

function build(lock, pkg, { all = false, now = new Date() } = {}) {
  const components = [];
  for (const [p, info] of Object.entries(lock.packages || {})) {
    if (!p || !p.startsWith('node_modules/')) continue;
    if (!all && info.dev) continue;
    const name = p.slice(p.lastIndexOf('node_modules/') + 'node_modules/'.length);
    const purl = `pkg:npm/${name.startsWith('@') ? '%40' + name.slice(1) : name}@${info.version}`;
    const c = { type: 'library', 'bom-ref': `${purl}#${p}`, name, version: info.version, purl, scope: info.dev ? 'optional' : 'required' };
    if (info.integrity) {
      const m = /^(sha\d+)-(.+)$/.exec(info.integrity);
      if (m) c.hashes = [{ alg: m[1].toUpperCase().replace('SHA', 'SHA-'), content: Buffer.from(m[2], 'base64').toString('hex') }];
    }
    if (info.license) c.licenses = [{ license: { id: String(info.license) } }];
    components.push(c);
  }
  components.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
  return {
    bomFormat: 'CycloneDX', specVersion: '1.5', version: 1,
    metadata: { timestamp: now.toISOString(), tools: [{ vendor: 'Active SOS', name: 'scripts/sbom.cjs' }], component: { type: 'application', name: pkg.name, version: pkg.version || '0.0.0' } },
    components,
  };
}
module.exports = { build };
if (require.main === module) {
  const args = process.argv.slice(2);
  const oi = args.indexOf('--out');
  const out = oi >= 0 ? args[oi + 1] : 'docs/sbom.cdx.json';
  const root = process.cwd();
  const bom = build(JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8')), JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')), { all: args.includes('--all') });
  fs.writeFileSync(out, JSON.stringify(bom, null, 2) + '\n');
  console.log(`${bom.components.length} components written to ${out}`);
}
