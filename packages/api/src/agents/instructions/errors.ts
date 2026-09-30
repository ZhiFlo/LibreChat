import { InstructionsPromptErrorCode } from 'librechat-data-provider';
import type { AgentInstructionsPrompt, FiltersConfig } from 'librechat-data-provider';
import type { InstructionsPromptAccess, InstructionsPromptAccessUser } from './access';

/** User-safe copy for each stable `instructionsPrompt` write-rejection code. */
const INSTRUCTIONS_PROMPT_ERROR_MESSAGES: Record<InstructionsPromptErrorCode, string> = {
  [InstructionsPromptErrorCode.UNAVAILABLE]: 'The selected prompt is not available.',
  [InstructionsPromptErrorCode.FORBIDDEN]: 'You do not have access to the selected prompt.',
  [InstructionsPromptErrorCode.RESTRICTED]:
    'You do not have access to the currently linked prompt.',
};

export interface InstructionsPromptLinkErrorResponse {
  readonly status: 400 | 403;
  readonly body: { readonly error: string; readonly code: InstructionsPromptErrorCode };
}

/**
 * Validates a create/update/revert write of `instructionsPrompt` against the agent's
 * stored link, before any write lands, and maps a rejection to the HTTP boundary's
 * `{ status, body }` shape. Returns `null` when the write may proceed. The caller
 * (`/api`) owns only the HTTP call; every ok/forbidden/restricted/unavailable decision
 * lives in `access.validateLinkWrite`.
 */
export async function getInstructionsPromptLinkError({
  access,
  user,
  previous,
  next,
  filters,
  requireResolvable,
}: {
  access: Pick<InstructionsPromptAccess, 'validateLinkWrite'>;
  user: InstructionsPromptAccessUser;
  previous: AgentInstructionsPrompt | null | undefined;
  next: AgentInstructionsPrompt | null | undefined;
  filters?: FiltersConfig;
  requireResolvable: boolean;
}): Promise<InstructionsPromptLinkErrorResponse | null> {
  const result = await access.validateLinkWrite({
    user,
    previous,
    next,
    filters,
    requireResolvable,
  });
  if (result.ok) {
    return null;
  }
  return {
    status: result.status,
    body: {
      error: INSTRUCTIONS_PROMPT_ERROR_MESSAGES[result.code],
      code: result.code,
    },
  };
}
