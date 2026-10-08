// Runs in every test worker before each test file. Payload reads its environment when the config is
// first imported, so the run's throwaway database and bucket (from tests/int/setup.ts) must be in
// process.env before any test file's imports are evaluated.
import { inject } from 'vitest'

import { assertThrowawayTarget } from './tests/int/throwaway'

const testEnv = inject('testEnv')
assertThrowawayTarget(testEnv)
Object.assign(process.env, testEnv)
