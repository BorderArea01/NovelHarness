// Local launcher metadata only; never print PINs, recovery keys or credentials.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadDeploymentConfig } from './config.mjs';
import { pinIsConfigured } from './initial-pin.mjs';
import { leaseFile } from './installation-lease.mjs';
const config = await loadDeploymentConfig();
const dataDirectory =
  config.dataDirectory ??
  join(
    config.runtimeDirectory,
    'data/official-validation/integration',
    config.mode === 'shared' ? 'shared' : 'visitors',
  );
let prepared = false;
try {
  const marker = JSON.parse(await readFile(join(config.runtimeDirectory, '.anonymous-host.json'), 'utf8'));
  prepared = marker.prepared === true;
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const output = {
  ...config,
  dataDirectory,
  prepared,
  canInitialize: typeof config.initialPin === 'string' && /^[0-9]{4,12}$/.test(config.initialPin),
  pinConfigured: config.mode === 'shared' ? pinIsConfigured(dataDirectory) : false,
  leaseFile: leaseFile(config.runtimeDirectory, dataDirectory),
};
delete output.initialPin;
console.log(JSON.stringify(output));
