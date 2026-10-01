import { Lock } from 'lucide-react';
import { useLocalize } from '~/hooks';

/**
 * Note shown alongside the Prompt picker when the linked group is a restricted
 * stub the current editor cannot VIEW. The server strips the group identity and
 * content before it reaches this component (`{ source: 'native', restricted: true
 * }`), so nothing here can name or preview the linked prompt; the picker next to
 * it still lets the editor replace the link or switch to inline instructions.
 */
export default function RestrictedInstructionsPrompt() {
  const localize = useLocalize();

  return (
    <div
      className="flex items-center gap-2 rounded-lg border border-border-light bg-surface-secondary px-3 py-2 text-sm text-text-secondary"
      role="note"
    >
      <Lock className="h-4 w-4 flex-shrink-0" aria-hidden="true" />
      <div className="flex flex-col">
        <span className="font-medium text-text-primary">
          {localize('com_agents_instructions_prompt_restricted_title')}
        </span>
        <span>{localize('com_agents_instructions_prompt_restricted_description')}</span>
      </div>
    </div>
  );
}
