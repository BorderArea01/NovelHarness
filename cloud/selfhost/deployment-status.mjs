import { join } from 'node:path';
import { storageDirectory } from './config.mjs';

// Only expose this view after BOTH the PIN and native session are authenticated.
// It contains locations, never credentials, cookie material or novel contents.
export function deploymentStatus(config, lanOrigins = []) {
  const root = storageDirectory(config);
  return {
    mode: config.mode,
    storage: {
      engine: 'SQLite',
      directory: root,
      database: join(root, 'main.sqlite'),
      conversations: join(root, 'home', 'sessions'),
      settings: join(root, 'home'),
      sharedAcrossDevices: true,
    },
    access: {
      listenHost: config.host,
      port: config.port,
      lanOrigins,
      ingress: config.ingress,
      publicOrigin: config.publicOrigin || null,
      // A configured URL is not proof that an external tunnel is connected.
      tunnelManagedBy: 'deployment-operator',
      connectionVerified: false,
    },
    changesRequireRestart: true,
  };
}
