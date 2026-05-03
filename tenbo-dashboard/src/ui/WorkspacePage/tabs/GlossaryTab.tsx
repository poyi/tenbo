import { Markdown } from '../../Markdown';
import type { TenboState } from '../../../types';

export function GlossaryTab({ state }: { state: TenboState }) {
  return <Markdown source={state.workspaceContent.glossaryMd} />;
}
