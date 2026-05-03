import { Markdown } from '../../Markdown';
import { FillThisInButton } from '../FillThisInButton';
import { populateLayerPrompt } from '../../../prompts/populateLayer';
import { isTemplateOnly } from '../isTemplateOnly';

export function CodeMapTab({ scopeId, layerId, content }: { scopeId: string; layerId: string; content: string }) {
  if (isTemplateOnly(content)) {
    return (
      <div>
        <p>No code-map recorded for this layer yet.</p>
        <FillThisInButton
          label="Copy prompt to populate this layer's code-map"
          prompt={populateLayerPrompt('codeMap', scopeId, layerId)}
        />
      </div>
    );
  }
  return <Markdown source={content} />;
}
