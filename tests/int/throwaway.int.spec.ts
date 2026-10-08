import { inspect } from 'node:util'

import { describe, expect, it } from 'vitest'

import { databaseNameOf, parseDatabaseUrl } from './throwaway'

const PASSWORD = 'sentinel-password-4b1d'

describe('parseDatabaseUrl', () => {
  it('reads the database name of a valid URL', () => {
    expect(databaseNameOf(`postgresql://postgres:${PASSWORD}@127.0.0.1:5442/pandora_cms`)).toBe(
      'pandora_cms',
    )
  })

  it.each([
    ['a malformed URL', `postgresql://postgres:${PASSWORD}@127.0.0.1:not-a-port/pandora_cms`],
    ['a non-postgres URL', `https://postgres:${PASSWORD}@127.0.0.1/pandora_cms`],
  ])('rejects %s without echoing the password', (_case, connectionString) => {
    let error: unknown
    try {
      parseDatabaseUrl(connectionString)
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('DATABASE_URL is not a valid postgres URL')
    expect((error as Error).cause).toBeUndefined()
    // Everything a reporter could print: own properties, cause chain, stack.
    expect(inspect(error, { depth: Infinity, showHidden: true })).not.toContain(PASSWORD)
  })
})
