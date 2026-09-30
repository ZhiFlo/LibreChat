const { logger } = require('@librechat/data-schemas');
const { CacheKeys } = require('librechat-data-provider');
const { createPromptService, createLinkedInstructionsResolver } = require('@librechat/api');
const { grantPermission } = require('~/server/services/PermissionService');
const { getLogStores } = require('~/cache');
const db = require('~/models');

/** @type {import('@librechat/api').ResolveLinkedInstructions | undefined} */
let resolver;

/**
 * Builds (once) and returns the shared resolver for an agent's
 * `instructionsPrompt` link. Cache-first, per `createLinkedInstructionsResolver`
 * in `@librechat/api` — this module only wires the LibreChat prompt service and
 * the `AGENT_LINKED_INSTRUCTIONS` cache namespace (registered in
 * `~/cache/getLogStores.js`) into it.
 *
 * @returns {import('@librechat/api').ResolveLinkedInstructions}
 */
function getLinkedInstructionsResolver() {
  if (!resolver) {
    resolver = createLinkedInstructionsResolver({
      promptService: createPromptService({ db, grantPermission }),
      cache: getLogStores(CacheKeys.AGENT_LINKED_INSTRUCTIONS),
      logger,
    });
  }
  return resolver;
}

module.exports = { getLinkedInstructionsResolver };
