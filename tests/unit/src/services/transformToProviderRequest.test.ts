import type { Params } from '../../../../src/types/requestBody';

process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.CLICKHOUSE_URL ??= 'http://localhost:8123';
process.env.CLICKHOUSE_USERNAME ??= 'test';
process.env.CLICKHOUSE_PASSWORD ??= 'test';
process.env.CLICKHOUSE_DATABASE ??= 'test';
process.env.ENCRYPTION_KEY ??=
  '0000000000000000000000000000000000000000000000000000000000000000';

const { transformToProviderRequest } =
  require('../../../../src/services/transformToProviderRequest') as typeof import('../../../../src/services/transformToProviderRequest');

const transformChatComplete = (provider: 'phala' | 'near-ai', params: Params) =>
  transformToProviderRequest(
    provider,
    { ...params },
    { ...params },
    'chatComplete',
    {},
    { provider }
  ) as Record<string, any>;

const baseParams: Params = {
  model: 'phala/deepseek-v4-flash',
  messages: [{ role: 'user', content: 'Hello' }],
};

describe('transformToProviderRequest', () => {
  describe.each(['phala', 'near-ai'] as const)(
    '%s chat completions',
    (provider) => {
      const transformProviderChatComplete = (params: Params) =>
        transformChatComplete(provider, params);

      it('normalizes reasoning_effort xhigh to max', () => {
        const transformed = transformProviderChatComplete({
          ...baseParams,
          reasoning_effort: 'xhigh',
        });

        expect(transformed.reasoning_effort).toBe('max');
      });

      it.each(['none', 'low', 'medium', 'high', 'max'])(
        'passes through reasoning_effort %s',
        (reasoningEffort) => {
          const transformed = transformProviderChatComplete({
            ...baseParams,
            reasoning_effort: reasoningEffort,
          });

          expect(transformed.reasoning_effort).toBe(reasoningEffort);
        }
      );

      it('omits reasoning_effort when it is not provided', () => {
        const transformed = transformProviderChatComplete(baseParams);

        expect(transformed).not.toHaveProperty('reasoning_effort');
      });

      it('keeps tool_choice and tools while normalizing reasoning_effort', () => {
        const tools = [
          {
            type: 'function',
            function: {
              name: 'example_tool',
              description: 'Example tool for validation',
              parameters: {
                type: 'object',
                properties: {
                  query: { type: 'string' },
                },
                required: ['query'],
              },
            },
          },
        ];

        const transformed = transformProviderChatComplete({
          ...baseParams,
          reasoning_effort: 'xhigh',
          tools,
          tool_choice: 'auto',
        });

        expect(transformed).toMatchObject({
          reasoning_effort: 'max',
          tools,
          tool_choice: 'auto',
        });
      });

      const responseFormats: Params['response_format'][] = [
        {
          type: 'json_schema',
          json_schema: {
            name: 'answer_schema',
            schema: {
              type: 'object',
              properties: {
                answer: { type: 'string' },
              },
              required: ['answer'],
              additionalProperties: false,
            },
          },
        },
        { type: 'json_object' },
      ];

      it.each(responseFormats)(
        'keeps response_format %s while normalizing reasoning_effort',
        (responseFormat) => {
          const transformed = transformProviderChatComplete({
            ...baseParams,
            reasoning_effort: 'xhigh',
            response_format: responseFormat,
          });

          expect(transformed).toMatchObject({
            reasoning_effort: 'max',
            response_format: responseFormat,
          });
        }
      );
    }
  );
});
