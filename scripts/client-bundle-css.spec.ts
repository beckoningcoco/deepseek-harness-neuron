/**
 * Stylesheets enter client bundles through virtual modules, so the loader must
 * register their physical files as watch dependencies.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { clientBundle } from '../packages/client/tsdown.client.ts'

interface CssPlugin {
  name: string
  resolveId?: (source: string, importer?: string) => string | null
  load?: (this: { addWatchFile(id: string): void }, id: string) => Promise<string | null>
}

function cssPlugin(name: 'dsh-css-modules-inline' | 'dsh-css-global-inline' | 'dsh-css-text-inline'): CssPlugin {
  const configs = clientBundle(
    '@deepseek-ai/dsh-client-test',
    ['lib/types/index.js', 'lib/types/invariant.js'],
  )({ env: { DSH_BUILD_FACE: 'client' } })
  const client = configs.find(config => config.platform === 'browser')
  if (client === undefined) throw new Error('client config missing')
  const plugins = (client as { plugins: CssPlugin[] }).plugins
  const plugin = plugins.find(candidate => candidate.name === name)
  if (plugin === undefined) throw new Error(`${name} missing from client config`)
  return plugin
}

describe('client bundle CSS Modules', () => {
  it('registers the source stylesheet as a watch dependency', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-client-css-watch-'))
    try {
      const stylesheet = join(root, 'Fixture.module.css')
      const importer = join(root, 'index.ts')
      await writeFile(stylesheet, '.root { color: red; }\n')
      const plugin = cssPlugin('dsh-css-modules-inline')
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

  /**
   * Two stylesheets with the same basename in different directories. They must
   * not share a tag id: the emitted guard is a `querySelector` on that id, so a
   * collision makes the second stylesheet skip its own injection while its class
   * map still exports — the markup gets class names no rule in the document
   * matches. Measured before the fix in the yon-panel plugin: 11 injection
   * points, 3 distinct ids, 9 of them `…/panel.module.css`.
   */
  it('gives same-named stylesheets in different directories distinct tag ids', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-client-css-id-'))
    try {
      const plugin = cssPlugin('dsh-css-modules-inline')
      const ids: string[] = []
      for (const panel of ['alpha', 'beta']) {
        const directory = join(root, 'src', panel)
        await mkdir(directory, { recursive: true })
        await writeFile(join(directory, 'Panel.module.css'), '.root { color: red; }\n')
        const virtualId = plugin.resolveId?.('./Panel.module.css', join(directory, 'index.ts'))
        if (typeof virtualId !== 'string' || plugin.load === undefined) {
          throw new Error('CSS Modules plugin hooks are incomplete')
        }
        const output = await plugin.load.call({ addWatchFile: () => {} }, virtualId)
        const tagId = output === null ? null : /const tagId = "([^"]+)";/.exec(output)?.[1]
        if (tagId === undefined || tagId === null) {
          throw new Error(`no tag id in the emitted injector: ${(output ?? '').slice(0, 200)}`)
        }
        ids.push(tagId)
      }

      expect(ids[0]).toBe('@deepseek-ai/dsh-client-test/alpha/Panel.module.css')
      expect(ids[1]).toBe('@deepseek-ai/dsh-client-test/beta/Panel.module.css')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps the basename for a stylesheet outside the package sources', async () => {
    // The artifact is committed, so an id that embedded the absolute path would
    // differ per machine and every build would show up as a diff.
    const root = await mkdtemp(join(tmpdir(), 'dsh-client-css-outside-'))
    try {
      const stylesheet = join(root, 'Vendor.module.css')
      const importer = join(root, 'index.ts')
      await writeFile(stylesheet, '.root { color: red; }\n')
      const plugin = cssPlugin('dsh-css-modules-inline')
      const virtualId = plugin.resolveId?.('./Vendor.module.css', importer)
      if (typeof virtualId !== 'string' || plugin.load === undefined) {
        throw new Error('CSS Modules plugin hooks are incomplete')
      }

      const output = await plugin.load.call({ addWatchFile: () => {} }, virtualId)

      expect(output).toContain('const tagId = "@deepseek-ai/dsh-client-test/Vendor.module.css";')
      expect(output).not.toContain(root)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('client bundle global CSS', () => {
  it('compiles a side-effect stylesheet into a watched style injector', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-client-global-css-watch-'))
    try {
      const stylesheet = join(root, 'base.css')
      const importer = join(root, 'index.ts')
      await writeFile(stylesheet, 'body { color: red; }\n')
      const plugin = cssPlugin('dsh-css-global-inline')
      const virtualId = plugin.resolveId?.('./base.css', importer)
      if (typeof virtualId !== 'string' || plugin.load === undefined) {
        throw new Error('global CSS plugin hooks are incomplete')
      }
      const watched: string[] = []

      const output = await plugin.load.call({ addWatchFile: id => watched.push(id) }, virtualId)

      expect(watched).toEqual([stylesheet])
      expect(output).toContain('data-plugin-css')
      expect(output).toContain('body{color:red}')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('compiles inline stylesheets as watched text without a module side effect', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-client-inline-css-watch-'))
    try {
      const stylesheet = join(root, 'base.css')
      const importer = join(root, 'index.ts')
      await writeFile(stylesheet, 'body { color: red; }\n')
      const plugin = cssPlugin('dsh-css-text-inline')
      const virtualId = plugin.resolveId?.('./base.css?inline', importer)
      if (typeof virtualId !== 'string' || plugin.load === undefined) {
        throw new Error('inline CSS plugin hooks are incomplete')
      }
      const watched: string[] = []

      const output = await plugin.load.call({ addWatchFile: id => watched.push(id) }, virtualId)

      expect(watched).toEqual([stylesheet])
      expect(output).toContain('export default "body{color:red}"')
      expect(output).not.toContain('data-plugin-css')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
