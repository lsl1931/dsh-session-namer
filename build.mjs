// Build dsh-session-namer (zero-dependency):
// - lib/index.js  (Node half, verbatim copy of src/index.js)
// - lib/client.js (browser half wrapped in the factory-form CJS the dsh
//   client-modules system registers: window.__ModuleLoader__.load({id,factory}))
// The client source is JSX-free and already exports inject/apply, so no
// transpiler is needed.
import { mkdirSync, writeFileSync, copyFileSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const libDir = join(root, 'lib')
mkdirSync(libDir, { recursive: true })

copyFileSync(join(root, 'src', 'index.js'), join(libDir, 'index.js'))
console.log('lib/index.js written')

const body = readFileSync(join(root, 'src', 'client', 'index.js'), 'utf8')
const wrapped = `window.__ModuleLoader__.load({
\tid: "dsh-session-namer",
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
${body}
\t\treturn module.exports;
\t}
});
`
writeFileSync(join(libDir, 'client.js'), wrapped)
console.log('lib/client.js written')
