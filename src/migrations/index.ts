import * as migration_20261008_223417_initial from './20261008_223417_initial';
import * as migration_20261009_001903_products from './20261009_001903_products';

export const migrations = [
  {
    up: migration_20261008_223417_initial.up,
    down: migration_20261008_223417_initial.down,
    name: '20261008_223417_initial',
  },
  {
    up: migration_20261009_001903_products.up,
    down: migration_20261009_001903_products.down,
    name: '20261009_001903_products'
  },
];
