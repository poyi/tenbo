import { Markdown } from '../../Markdown';
import { FillThisInButton } from '../FillThisInButton';
import { populateLayerPrompt } from '../../../prompts/populateLayer';
import { isTemplateOnly } from '../isTemplateOnly';

export function PlainEnglishTab({ scopeId, layerId, content }: { scopeId: string; layerId: string; content: string }) {
  if (isTemplateOnly(content)) {
    return (
      <div>
        <p>No README recorded for this layer yet.</p>
        <FillThisInButton
          label="Copy prompt to populate this layer's README"
          prompt={populateLayerPrompt('readme', scopeId, layerId)}
        />
      </div>
    );
  }
  return <Markdown source={content} />;
}
