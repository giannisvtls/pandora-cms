import * as migration_20261008_223417_initial from './20261008_223417_initial';

export const migrations = [
  {
    up: migration_20261008_223417_initial.up,
    down: migration_20261008_223417_initial.down,
    name: '20261008_223417_initial'
  },
];
