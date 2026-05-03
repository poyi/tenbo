import { Markdown } from '../../Markdown';
import type { TenboState } from '../../../types';

export function PrinciplesTab({ state }: { state: TenboState }) {
  return <Markdown source={state.workspaceContent.principlesMd} />;
}
