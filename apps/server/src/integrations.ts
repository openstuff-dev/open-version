import { type ConnectionDetails, type IntegrationOffer, openAnnounce } from '@openstuff-dev/server';
import type { Config } from './config.js';

/**
 * The connections this server offers: OpenAnnounce only, since OpenVersion doesn't connect to
 * itself. The environment's values win when set, and the card then shows read-only.
 */
export function integrationOffers(config: Config): IntegrationOffer[] {
  const { url, publicKey, signingSecret } = config.openAnnounce;
  const environment: ConnectionDetails | null =
    url && publicKey ? { url, publicKey, ...(signingSecret ? { signingSecret } : {}) } : null;
  return [
    {
      kind: openAnnounce,
      signingSecret: true,
      environment,
      envPrefix: 'OPENVERSION_OPENANNOUNCE',
    },
  ];
}
