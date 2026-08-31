/**
 * CSS Modules enter client bundles through virtual modules, so the loader must
 * explicitly register the underlying stylesheet as a watch dependency.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Rolldown } from 'tsdown'
import { describe, expect, it } from 'vitest'
import { clientBundle } from '../packages/client/tsdown.client.ts'

interface CssPlugin {
  name: string
  resolveId?: (source: string, importer?: string) => string | null
  load?: (this: { addWatchFile(id: string): void }, id: string) => Promise<string | null>
}

function cssPlugin(): CssPlugin {
  const configs = clientBundle(
    '@deepseek-ai/dsh-client-test',
    ['lib/types/index.js', 'lib/types/invariant.js'],
  )({ env: { DSH_BUILD_FACE: 'client' } })
  const client = configs.find(config => config.platform === 'browser')
  if (client === undefined) throw new Error('client config missing')
  const plugins = (client as { plugins: CssPlugin[] }).plugins
  const plugin = plugins.find(candidate => candidate.name === 'dsh-css-modules-inline')
  if (plugin === undefined) throw new Error('CSS Modules plugin missing from client config')
  return plugin
}

describe('client bundle CSS Modules', () => {
  it('keeps the physical source path out of generated chunks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-client-css-bundle-'))
    const sourceRoot = join(root, 'C:\\Users\\builder\\project')
    const previousCwd = process.cwd()
    try {
      await mkdir(sourceRoot)
      const stylesheet = join(sourceRoot, 'Fixture.module.css')
      const importer = join(sourceRoot, 'index.ts')
      await writeFile(stylesheet, '.root { color: red; }\n')
      await writeFile(importer, "import styles from './Fixture.module.css'; export default styles.root\n")
      process.chdir(sourceRoot)

      const bundle = await Rolldown.rolldown({ input: importer, plugins: [cssPlugin()] })
      const generated = await bundle.generate({ format: 'esm' })
      const output = generated.output.find(candidate => candidate.type === 'chunk')

      expect(output?.code).toContain('data-plugin-css')
      expect(output?.code).not.toContain('C:\\Users\\builder')
      expect(Buffer.from(output?.code ?? '').includes(Buffer.from('C:\\Users\\builder', 'utf16le'))).toBe(false)
    } finally {
      process.chdir(previousCwd)
      await rm(root, { recursive: true, force: true })
    }
  })

  it('registers the source stylesheet as a watch dependency', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-client-css-watch-'))
    try {
      const stylesheet = join(root, 'Fixture.module.css')
      const importer = join(root, 'index.ts')
      await writeFile(stylesheet, '.root { color: red; }\n')
      const plugin = cssPlugin()
      const virtualId = plugin.resolveId?.('./Fixture.module.css', importer)
      if (typeof virtualId !== 'string' || plugin.load === undefined) {
        throw new Error('CSS Modules plugin hooks are incomplete')
      }
      const watched: string[] = []

      const output = await plugin.load.call({ addWatchFile: id => watched.push(id) }, virtualId)

      expect(watched).toEqual([stylesheet])
      expect(output).toContain('data-plugin-css')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
