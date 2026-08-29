import { mapPromptContent } from '../src/acp/content-mapper';
import { OrionAcpError } from '../src/acp/runtime-port';

describe('ACP prompt content mapping', () => {
  test('combines text and resource links without reading the resource', () => {
    expect(
      mapPromptContent([
        { type: 'text', text: 'Review this context.' },
        {
          type: 'resource_link',
          name: 'Design note',
          title: 'ACP design',
          uri: 'file:///tmp/design.md',
          description: 'Reference only',
          mimeType: 'text/markdown',
        },
      ])
    ).toBe(
      'Review this context.\n\nACP design: file:///tmp/design.md (Reference only; media type: text/markdown)'
    );
  });

  test.each(['image', 'audio', 'resource'] as const)(
    'rejects unsupported %s blocks explicitly',
    type => {
      expect(() => mapPromptContent([{ type }])).toThrow(
        expect.objectContaining<Partial<OrionAcpError>>({
          code: 'ORION_ACP_UNSUPPORTED_CONTENT',
        })
      );
    }
  );

  test('rejects an empty prompt', () => {
    expect(() => mapPromptContent([{ type: 'text', text: '   ' }])).toThrow(
      expect.objectContaining<Partial<OrionAcpError>>({ code: 'ORION_ACP_EMPTY_PROMPT' })
    );
  });
});
