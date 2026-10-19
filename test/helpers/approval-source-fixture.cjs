// Explicit SOURCE_FIXTURE only. The external installation is read, never changed.
// Keep the installed module URL so package imports retain native resolution.
const fs = require('node:fs');
const path = require('node:path');
const { createRequire, registerHooks } = require('node:module');
const { pathToFileURL, fileURLToPath } = require('node:url');
const dsh = process.env.E2E_NATIVE_ROOT;
const run = process.env.E2E_FIXTURE_DIR;
if (!dsh || !run) throw new Error('SOURCE_FIXTURE requires explicit isolated fixture paths');
const ts = createRequire(path.join(dsh, 'package.json'))('typescript');
const packageRoots = ['packages/interaction/user-approval', 'packages/sandbox/sandbox'].map(p => path.join(dsh, p));
const entries = new Map(packageRoots.map(p => [pathToFileURL(path.join(p, 'lib/index.js')).href, path.join(p, 'src/index.ts')]));
const compiled = new Map();
function compile(sourceFile) {
  if (compiled.has(sourceFile)) return compiled.get(sourceFile);
  const packageRoot = packageRoots.find(p => sourceFile.startsWith(path.join(p, 'src') + path.sep));
  if (!packageRoot) throw new Error('SOURCE_FIXTURE source boundary');
  const name = path.relative(path.join(packageRoot, 'src'), sourceFile);
  const source = fs.readFileSync(sourceFile, 'utf8');
  // Preserve a reviewable independent fixture copy, without adding dependencies.
  const copy = path.join(run, 'approval-source-fixture', path.basename(packageRoot), name);
  fs.mkdirSync(path.dirname(copy), { recursive: true });
  fs.writeFileSync(copy, source);
  const result = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.ESNext, experimentalDecorators: true }, reportDiagnostics: true });
  if (result.diagnostics?.some(d => d.category === ts.DiagnosticCategory.Error)) throw new Error('SOURCE_FIXTURE transpilation failed');
  fs.writeFileSync(copy + '.mjs', result.outputText);
  compiled.set(sourceFile, result.outputText);
  return result.outputText;
}
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (entries.has(context.parentURL) && specifier.startsWith('./') && specifier.endsWith('.ts')) return { url: pathToFileURL(path.resolve(path.dirname(entries.get(context.parentURL)), specifier)).href, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (entries.has(url)) return { format: 'module', source: compile(entries.get(url)), shortCircuit: true };
    if (url.startsWith('file:') && url.endsWith('.ts')) {
      const file = fileURLToPath(url);
      if (packageRoots.some(p => file.startsWith(path.join(p, 'src') + path.sep))) return { format: 'module', source: compile(file), shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});
