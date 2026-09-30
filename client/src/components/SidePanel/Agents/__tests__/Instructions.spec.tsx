import { ToastProvider } from '@librechat/client';
import userEvent from '@testing-library/user-event';
import { FormProvider, useForm } from 'react-hook-form';
import { render, screen, fireEvent } from '@testing-library/react';
import type { AgentForm } from '~/common';
import Instructions from '../Instructions';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

jest.mock('../InstructionsPromptFields', () => () => (
  <div data-testid="instructions-prompt-fields" />
));

jest.mock('../RestrictedInstructionsPrompt', () => () => (
  <div data-testid="restricted-instructions-prompt" />
));

function InstructionsHarness({
  instructionsSource = 'inline',
  instructionsPrompt = null,
}: {
  instructionsSource?: AgentForm['instructionsSource'];
  instructionsPrompt?: AgentForm['instructionsPrompt'];
}) {
  const methods = useForm<AgentForm>({
    defaultValues: { instructions: '', instructionsSource, instructionsPrompt },
  });
  return (
    <ToastProvider>
      <FormProvider {...methods}>
        <Instructions />
      </FormProvider>
    </ToastProvider>
  );
}

describe('Agent Instructions', () => {
  it('offers special-variable insertion by default', async () => {
    const user = userEvent.setup();
    render(<InstructionsHarness />);

    await user.click(screen.getByRole('button', { name: 'com_ui_variables' }));
    expect(
      await screen.findByRole('menuitem', { name: 'com_ui_special_var_current_date' }),
    ).toBeInTheDocument();
  });

  it('defaults to inline mode and keeps the inline editor visible', () => {
    render(<InstructionsHarness />);

    expect(screen.getByLabelText('com_ui_instructions')).toBeInTheDocument();
    expect(screen.getByTestId('instructions-inline-panel')).not.toHaveClass('hidden');
    expect(screen.queryByTestId('instructions-prompt-fields')).not.toBeInTheDocument();
  });

  it('switching to Prompt mode hides the inline editor without unmounting it', () => {
    render(<InstructionsHarness />);

    fireEvent.click(screen.getByRole('button', { name: 'com_agents_instructions_source_prompt' }));

    expect(screen.getByTestId('instructions-prompt-fields')).toBeInTheDocument();
    expect(screen.getByTestId('instructions-inline-panel')).toHaveClass('hidden');
  });

  it('shows Prompt/Version controls in Prompt mode for an unrestricted link', () => {
    render(
      <InstructionsHarness
        instructionsSource="prompt"
        instructionsPrompt={{
          source: 'native',
          groupId: 'group1',
          selection: { type: 'production' },
        }}
      />,
    );

    expect(screen.getByTestId('instructions-prompt-fields')).toBeInTheDocument();
    expect(screen.queryByTestId('restricted-instructions-prompt')).not.toBeInTheDocument();
  });

  it('shows the restricted attachment and disables the toggle for a restricted link', () => {
    render(
      <InstructionsHarness
        instructionsSource="prompt"
        instructionsPrompt={{ source: 'native', restricted: true }}
      />,
    );

    expect(screen.getByTestId('restricted-instructions-prompt')).toBeInTheDocument();
    expect(screen.queryByTestId('instructions-prompt-fields')).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'com_agents_instructions_source_inline' }),
    ).toBeDisabled();
    expect(
      screen.getByRole('button', { name: 'com_agents_instructions_source_prompt' }),
    ).toBeDisabled();
  });

  it('reverts to the stored value when toggling back without saving', () => {
    render(
      <InstructionsHarness
        instructionsSource="inline"
        instructionsPrompt={{
          source: 'native',
          groupId: 'group1',
          selection: { type: 'production' },
        }}
      />,
    );

    const promptButton = screen.getByRole('button', {
      name: 'com_agents_instructions_source_prompt',
    });
    const inlineButton = screen.getByRole('button', {
      name: 'com_agents_instructions_source_inline',
    });

    fireEvent.click(promptButton);
    expect(screen.getByTestId('instructions-prompt-fields')).toBeInTheDocument();

    fireEvent.click(inlineButton);
    expect(screen.queryByTestId('instructions-prompt-fields')).not.toBeInTheDocument();
    expect(screen.getByTestId('instructions-inline-panel')).not.toHaveClass('hidden');
  });
});
