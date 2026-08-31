import { OrionAcpError, type OrionAcpPromptContent } from './runtime-port';

export function mapPromptContent(prompt: readonly OrionAcpPromptContent[]): string {
  const parts = prompt.map(block => {
    switch (block.type) {
      case 'text':
        return block.text;
      case 'resource_link': {
        const label = block.title?.trim() || block.name.trim() || block.uri;
        const description = block.description?.trim();
        const mimeType = block.mimeType?.trim();
        const metadata = [description, mimeType ? `media type: ${mimeType}` : undefined]
          .filter((value): value is string => Boolean(value))
          .join('; ');
        return `${label}: ${block.uri}${metadata ? ` (${metadata})` : ''}`;
      }
      case 'image':
      case 'audio':
      case 'resource':
        throw new OrionAcpError(
          'ORION_ACP_UNSUPPORTED_CONTENT',
          `ACP prompt content type "${block.type}" is not supported by this Orion Code version.`
        );
    }
  });

  const input = parts
    .filter(part => part.length > 0)
    .join('\n\n')
    .trim();
  if (!input) {
    throw new OrionAcpError('ORION_ACP_EMPTY_PROMPT', 'ACP prompt must contain non-empty text.');
  }
  return input;
}
