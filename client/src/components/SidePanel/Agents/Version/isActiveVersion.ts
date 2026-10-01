import isEqual from 'lodash/isEqual';
import type {
  GraphEdge,
  AgentInstructionsPrompt,
  RestrictedAgentInstructionsPrompt,
} from 'librechat-data-provider';
import type { AgentState, VersionRecord } from './types';
import { isRestrictedInstructionsPrompt } from '../instructionsPromptUtils';

const edgesMatch = (versionEdges?: GraphEdge[], currentEdges?: GraphEdge[]): boolean =>
  isEqual(versionEdges ?? [], currentEdges ?? []);

/** Compares the linked-prompt field: source, `groupId`, and `selection`. A restricted
 * stub hides the linked group from this editor, so the client cannot tell whether it
 * matches the other side's link — treat it as never matching, on either side, rather
 * than deep-comparing the stub's shape. Two visible links still compare by value. */
const instructionsPromptMatch = (
  versionPrompt?: AgentInstructionsPrompt | RestrictedAgentInstructionsPrompt | null,
  currentPrompt?: AgentInstructionsPrompt | RestrictedAgentInstructionsPrompt | null,
): boolean => {
  if (
    isRestrictedInstructionsPrompt(versionPrompt) ||
    isRestrictedInstructionsPrompt(currentPrompt)
  ) {
    return false;
  }
  return isEqual(versionPrompt ?? null, currentPrompt ?? null);
};

export const isActiveVersion = (
  version: VersionRecord,
  currentAgent: AgentState,
  versions: VersionRecord[],
): boolean => {
  if (!versions || versions.length === 0) {
    return false;
  }

  if (!currentAgent) {
    const versionIndex = versions.findIndex(
      (v) =>
        v.name === version.name &&
        v.instructions === version.instructions &&
        v.artifacts === version.artifacts &&
        instructionsPromptMatch(v.instructionsPrompt, version.instructionsPrompt),
    );
    return versionIndex === 0;
  }

  const matchesName = version.name === currentAgent.name;
  const matchesDescription = version.description === currentAgent.description;
  const matchesInstructions = version.instructions === currentAgent.instructions;
  const matchesInstructionsPrompt = instructionsPromptMatch(
    version.instructionsPrompt,
    currentAgent.instructionsPrompt,
  );
  const matchesArtifacts = version.artifacts === currentAgent.artifacts;
  const matchesEdges = edgesMatch(version.edges, currentAgent.edges);

  const toolsMatch = () => {
    if (!version.tools && !currentAgent.tools) return true;
    if (!version.tools || !currentAgent.tools) return false;
    if (version.tools.length !== currentAgent.tools.length) return false;

    const sortedVersionTools = [...version.tools].sort();
    const sortedCurrentTools = [...currentAgent.tools].sort();

    return sortedVersionTools.every((tool, i) => tool === sortedCurrentTools[i]);
  };

  const capabilitiesMatch = () => {
    if (!version.capabilities && !currentAgent.capabilities) return true;
    if (!version.capabilities || !currentAgent.capabilities) return false;
    if (version.capabilities.length !== currentAgent.capabilities.length) return false;

    const sortedVersionCapabilities = [...version.capabilities].sort();
    const sortedCurrentCapabilities = [...currentAgent.capabilities].sort();

    return sortedVersionCapabilities.every(
      (capability, i) => capability === sortedCurrentCapabilities[i],
    );
  };

  return (
    matchesName &&
    matchesDescription &&
    matchesInstructions &&
    matchesInstructionsPrompt &&
    matchesArtifacts &&
    matchesEdges &&
    toolsMatch() &&
    capabilitiesMatch()
  );
};
