// Historical standalone migration fixture. Production mounts this same library
// controller inside the native application frame, never a second running store.
import { mountLibrary } from './studio.mjs';
mountLibrary(document);
