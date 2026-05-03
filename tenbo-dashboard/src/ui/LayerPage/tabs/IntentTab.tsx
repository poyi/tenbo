import { Markdown } from '../../Markdown';
import { FillThisInButton } from '../FillThisInButton';
import { populateLayerPrompt } from '../../../prompts/populateLayer';
import { isTemplateOnly } from '../isTemplateOnly';

export function IntentTab({ scopeId, layerId, content }: { scopeId: string; layerId: string; content: string }) {
  if (isTemplateOnly(content)) {
    return (
      <div>
        <p>No intent recorded for this layer yet.</p>
        <FillThisInButton
          label="Copy prompt to populate this layer's intent"
          prompt={populateLayerPrompt('intent', scopeId, layerId)}
        />
      </div>
    );
  }
  return <Markdown source={content} />;
}
