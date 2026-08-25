import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

/**
 * Real cross-build Schedule downgrade gate. The all-dispatches/no-user cut is
 * also the durable form of a legacy Inbox message claimed before user/message:
 * Inbox claim has no Session event of its own.
 */
const OLD_COMMIT = '2bc16230975f6cf02aa1b283b1f86de44007b059'
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const driver = join(repoRoot, 'packages/schedule/schedule/tests/fixtures/downgrade-gate-driver.ts')
const schedulePackage = join(repoRoot, 'packages/schedule/schedule')

async function run(command: string, args: readonly string[], cwd = repoRoot): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolvePromise()
      else reject(new Error(`${command} exited with ${code ?? signal ?? 'unknown status'}`))
    })
  })
}

/** Run a transpiled driver through plain Node and public package exports. */
async function runDriver(
  driverPath: string,
  phase: string,
  stateRoot: string,
  metadata: string,
  cwd = repoRoot,
): Promise<void> {
  await run(process.execPath, [driverPath, phase, stateRoot, metadata], cwd)
}

/** Build host declarations and package entries through their installed CLIs. */
async function buildHost(cwd: string): Promise<void> {
  await run(process.execPath, [join(cwd, 'node_modules/typescript/bin/tsc'), '-b', 'tsconfig.host.json'], cwd)
  await run(process.execPath, [
    join(cwd, 'node_modules/tsdown/dist/run.mjs'),
    '--env.DSH_BUILD_FACE',
    'host',
  ], cwd)
}

async function capture(command: string, args: readonly string[]): Promise<string> {
  return await new Promise<string>((resolvePromise, reject) => {
    const chunks: Buffer[] = []
    const child = spawn(command, args, { cwd: repoRoot, stdio: ['ignore', 'pipe', 'inherit'] })
    child.stdout.on('data', chunk => chunks.push(chunk as Buffer))
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolvePromise(Buffer.concat(chunks).toString('utf8').trim())
      else reject(new Error(`${command} exited with ${code ?? signal ?? 'unknown status'}`))
    })
  })
}

/** Reject uncommitted bytes before they can seed evidence attributed to HEAD. */
function assertCleanCandidate(status: string): void {
  assert.equal(status, '', 'Schedule downgrade gate requires a clean candidate worktree')
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  assert(args.length === 0 || (args.length === 1 && args[0] === '--candidate-built'),
    'usage: verify-schedule-downgrade.ts [--candidate-built]')
  assertCleanCandidate(await capture('git', ['status', '--porcelain']))
  if (args.length === 0) await buildHost(repoRoot)
  assertCleanCandidate(await capture('git', ['status', '--porcelain']))
  const scratch = await mkdtemp(join(tmpdir(), 'dsh-schedule-downgrade-'))
  let complete = false
  try {
    const stateRoot = join(scratch, 'state')
    const oldRoot = join(scratch, 'old-source')
    const archive = join(scratch, 'old-source.tar')
    const metadata = join(scratch, 'gate.json')
    const candidateRuntime = join(scratch, 'candidate-package')
    const candidateDriver = join(candidateRuntime, 'downgrade-gate-driver.mjs')
    const [candidateCommit, candidateTree, oldCommit, oldTree, pnpmVersion] = await Promise.all([
      capture('git', ['rev-parse', 'HEAD']),
      capture('git', ['rev-parse', 'HEAD^{tree}']),
      capture('git', ['rev-parse', OLD_COMMIT]),
      capture('git', ['rev-parse', `${OLD_COMMIT}^{tree}`]),
      capture('pnpm', ['--version']),
    ])
    process.stdout.write([
      `candidate commit: ${candidateCommit}`,
      `candidate tree: ${candidateTree}`,
      'candidate worktree: clean',
      `old commit: ${oldCommit}`,
      `old tree: ${oldTree}`,
      `node: ${process.version}`,
      `pnpm: ${pnpmVersion}`,
      '',
    ].join('\n'))

    await mkdir(oldRoot)
    await run('git', ['archive', '--format=tar', '--output', archive, oldCommit])
    await run('tar', ['-xf', archive, '-C', oldRoot])
    await run('pnpm', [
      'install', '--offline', '--frozen-lockfile', '--ignore-scripts', '--prefer-offline', '--dir', oldRoot,
    ])
    await buildHost(oldRoot)

    const compiled = ts.transpileModule(await readFile(driver, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2024 },
      fileName: driver,
      reportDiagnostics: true,
    })
    assert.equal(compiled.diagnostics?.length ?? 0, 0, 'Schedule downgrade driver must transpile cleanly')
    await mkdir(candidateRuntime)
    await copyFile(join(schedulePackage, 'package.json'), join(candidateRuntime, 'package.json'))
    await symlink(join(schedulePackage, 'lib'), join(candidateRuntime, 'lib'), 'dir')
    await symlink(join(schedulePackage, 'node_modules'), join(candidateRuntime, 'node_modules'), 'dir')
    await writeFile(candidateDriver, compiled.outputText, 'utf8')
    const oldDriver = join(oldRoot, 'packages/schedule/schedule/downgrade-gate-driver.mjs')
    await copyFile(candidateDriver, oldDriver)

    await runDriver(candidateDriver, 'candidate-seed', stateRoot, metadata, candidateRuntime)
    await runDriver(oldDriver, 'old-initial', stateRoot, metadata, oldRoot)
    await runDriver(candidateDriver, 'current-upgrade', stateRoot, metadata, candidateRuntime)
    await runDriver(oldDriver, 'old-final', stateRoot, metadata, oldRoot)
    await runDriver(oldDriver, 'forced-old-crash', stateRoot, metadata, oldRoot)
    await runDriver(oldDriver, 'forced-old-recover', stateRoot, metadata, oldRoot)
    await runDriver(candidateDriver, 'forced-current-upgrade', stateRoot, metadata, candidateRuntime)
    await runDriver(oldDriver, 'forced-old-final', stateRoot, metadata, oldRoot)
    assertCleanCandidate(await capture('git', ['status', '--porcelain']))
    complete = true
    process.stdout.write(
      'Schedule rollback gate passed: admission-ready old-pin loads stayed exact; policy-bypass pending probes validated containment only; forced old→old crash produced NEGATIVE evidence and remains an expected blocker.\n',
    )
  } finally {
    if (complete) await rm(scratch, { recursive: true, force: true })
    else process.stderr.write(`Schedule downgrade gate failed; preserved evidence at ${scratch}\n`)
  }
}

await main()
