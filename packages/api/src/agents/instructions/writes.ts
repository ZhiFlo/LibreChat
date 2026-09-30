import type {
  FiltersConfig,
  AgentInstructionsPrompt,
  RestrictedAgentInstructionsPrompt,
} from 'librechat-data-provider';
import type { InstructionsPromptAccess, InstructionsPromptAccessUser } from './access';
import type { InstructionsPromptLinkErrorResponse } from './errors';
import { getInstructionsPromptLinkError } from './errors';
import { isValidInstructionsPromptLink } from './linked';

export type InstructionsPromptWriteOperation = 'create' | 'update' | 'revert';

/**
 * Validates one create/update/revert write of `instructionsPrompt`, owning every
 * branch the write handler would otherwise carry: whether the field changed at
 * all (`next === undefined` short-circuits before any permission or prompt
 * lookup), and whether the operation requires the selection to still resolve
 * (every operation except `revert` — a stale snapshot continues the turn
 * without instructions rather than failing the write). Returns `null` when the
 * write may proceed; the caller only needs to map a non-null result to its
 * HTTP response.
 */
export async function checkInstructionsPromptWrite({
  access,
  operation,
  user,
  previous,
  next,
  filters,
}: {
  access: Pick<InstructionsPromptAccess, 'validateLinkWrite'>;
  operation: InstructionsPromptWriteOperation;
  user: InstructionsPromptAccessUser;
  previous: AgentInstructionsPrompt | null | undefined;
  next: AgentInstructionsPrompt | null | undefined;
  filters?: FiltersConfig;
}): Promise<InstructionsPromptLinkErrorResponse | null> {
  if (next === undefined) {
    return null;
  }
  return getInstructionsPromptLinkError({
    access,
    user,
    previous: previous ?? null,
    next,
    filters,
    requireResolvable: operation !== 'revert',
  });
}

/**
 * Applies the create/update convention that a `null` `instructionsPrompt` in
 * the update payload means "remove the link" — expressed as `$unset` because
 * `removeNullishValues` drops a bare `null` before it would reach the database
 * driver. Leaves `updateData` untouched when the field isn't `null` (absent,
 * or a link to set). Any existing `$unset` entries on `updateData` are kept.
 * Takes and returns a plain record — the `/api` update payload it operates on
 * is assembled dynamically and has no single static shape.
 */
export function applyInstructionsPromptUnset(
  updateData: Record<string, unknown>,
): Record<string, unknown> {
  if (updateData.instructionsPrompt !== null) {
    return updateData;
  }
  const { instructionsPrompt: _removed, $unset, ...rest } = updateData;
  return {
    ...rest,
    $unset: { ...(($unset as Record<string, unknown> | undefined) ?? {}), instructionsPrompt: 1 },
  };
}

/**
 * The link that will govern the agent's instructions after this write: `next`
 * when the payload carries the field at all (including an explicit `null`
 * removal), otherwise whatever is already stored (`previous`). A create has
 * no stored link, so callers pass `undefined` for `previous` there.
 */
export function effectiveInstructionsPromptLink(
  next: AgentInstructionsPrompt | RestrictedAgentInstructionsPrompt | null | undefined,
  previous: AgentInstructionsPrompt | RestrictedAgentInstructionsPrompt | null | undefined,
): AgentInstructionsPrompt | RestrictedAgentInstructionsPrompt | null | undefined {
  return next !== undefined ? next : previous;
}

/**
 * Excludes `instructions` from a save-time content scan when `effectiveLink`
 * is a real link (`isValidInstructionsPromptLink` — the same shape test
 * `initializeAgent` uses): that text is dead once a link governs the agent,
 * so it must not block a write that is otherwise switching to safe, linked
 * content. Every other field of `data` is returned unchanged.
 */
export function excludeInstructionsWhenLinked<T extends { instructions?: unknown }>(
  data: T,
  effectiveLink: AgentInstructionsPrompt | RestrictedAgentInstructionsPrompt | null | undefined,
): T {
  if (!isValidInstructionsPromptLink(effectiveLink)) {
    return data;
  }
  return { ...data, instructions: undefined };
}
