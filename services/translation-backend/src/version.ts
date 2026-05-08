import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

interface PackageJson {
  version?: string
}

/**
 * Read the package version at module load. Resolves relative to this source
 * file so it works both under `tsx` (src/) and after `tsc` build (dist/).
 */
function readVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  // src/version.ts → ../package.json ; dist/version.js → ../package.json
  const candidate = join(here, '..', 'package.json')
  const raw = readFileSync(candidate, 'utf8')
  const parsed: unknown = JSON.parse(raw)
  if (
    typeof parsed === 'object' &&
    parsed !== null &&
    typeof (parsed as PackageJson).version === 'string'
  ) {
    return (parsed as PackageJson).version!
  }
  return '0.0.0'
}

export const VERSION = readVersion()
