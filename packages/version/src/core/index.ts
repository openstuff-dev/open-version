// Safe to import anywhere, including Node: nothing here touches the DOM when it loads.
export * from './semver.js';
export * from './decide.js';
export * from './types.js';
export {
  configure,
  isChunkError,
  resetConfig,
  VersionClient,
  whenConfigured,
  type Environment,
  type ForcedEventDetail,
  type OpenVersionConfig,
  type UpdateEventDetail,
  type UpdateState,
} from './client.js';
