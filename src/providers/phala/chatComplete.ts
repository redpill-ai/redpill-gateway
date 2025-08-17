import { PHALA } from '../../globals';
import { Params } from '../../types/requestBody';
import {
  ChatCompletionResponse,
  ErrorResponse,
  ProviderConfig,
} from '../types';
import {
  generateErrorResponse,
  generateInvalidProviderResponseError,
} from '../utils';

export const PhalaChatCompleteConfig: ProviderConfig = {
  model: {
    param: 'model',
    required: true,
  },
  messages: {
    param: 'messages',
    required: true,
    default: '',
    transform: (params: Params) => {
      return params.messages?.map((message) => {
        if (message.role === 'developer') return { ...message, role: 'system' };
        return message;
      });
    },
  },
  max_tokens: {
    param: 'max_tokens',
    required: true,
    default: 128,
    min: 1,
  },
  max_completion_tokens: {
    param: 'max_tokens',
    default: 128,
    min: 1,
  },
  stop: {
    param: 'stop',
  },
  temperature: {
    param: 'temperature',
  },
  top_p: {
    param: 'top_p',
  },
  top_k: {
    param: 'top_k',
  },
  frequency_penalty: {
    param: 'repetition_penalty',
  },
  stream: {
    param: 'stream',
    default: false,
  },
  logprobs: {
    param: 'logprobs',
  },
  tools: {
    param: 'tools',
  },
  tool_choice: {
    param: 'tool_choice',
  },
  response_format: {
    param: 'response_format',
  },
};

export interface PhalaChatCompleteResponse extends ChatCompletionResponse {
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface PhalaErrorResponse {
  message: string;
  type: string;
  param: string | null;
  code: string;
}

export interface PhalaOpenAICompatibleErrorResponse extends ErrorResponse {}

export interface PhalaChatCompletionStreamChunk {
  id: string;
  model: string;
  object: string;
  choices: {
    index: number;
    delta: {
      content: string;
    };
  }[];
}

export const PhalaErrorResponseTransform: (
  response: PhalaErrorResponse | PhalaOpenAICompatibleErrorResponse
) => ErrorResponse | false = (response) => {
  if ('error' in response && typeof response.error === 'string') {
    return generateErrorResponse(
      { message: response.error, type: null, param: null, code: null },
      PHALA
    );
  }

  if ('error' in response && typeof response.error === 'object') {
    return generateErrorResponse(
      {
        message: response.error?.message || '',
        type: response.error?.type || null,
        param: response.error?.param || null,
        code: response.error?.code || null,
      },
      PHALA
    );
  }

  if ('message' in response && response.message) {
    return generateErrorResponse(
      {
        message: response.message,
        type: response.type || null,
        param: null,
        code: null,
      },
      PHALA
    );
  }

  return false;
};

export const PhalaChatCompleteResponseTransform: (
  response:
    | PhalaChatCompleteResponse
    | PhalaErrorResponse
    | PhalaOpenAICompatibleErrorResponse,
  responseStatus: number
) => ChatCompletionResponse | ErrorResponse = (response, responseStatus) => {
  if (responseStatus !== 200) {
    const errorResponse = PhalaErrorResponseTransform(
      response as PhalaErrorResponse
    );
    if (errorResponse) return errorResponse;
  }

  if ('choices' in response) {
    return {
      id: response.id,
      object: response.object,
      created: response.created,
      model: response.model,
      provider: PHALA,
      choices: response.choices.map((choice) => {
        return {
          message: {
            role: 'assistant',
            content: choice.message.content,
            tool_calls: choice.message.tool_calls
              ? choice.message.tool_calls.map((toolCall: any) => ({
                  id: toolCall.id,
                  type: toolCall.type,
                  function: toolCall.function,
                }))
              : null,
          },
          index: 0,
          logprobs: null,
          finish_reason: choice.finish_reason,
        };
      }),
      usage: {
        prompt_tokens: response.usage?.prompt_tokens,
        completion_tokens: response.usage?.completion_tokens,
        total_tokens: response.usage?.total_tokens,
      },
    };
  }

  return generateInvalidProviderResponseError(response, PHALA);
};

export const PhalaChatCompleteStreamChunkTransform: (
  response: string
) => string = (responseChunk) => {
  let chunk = responseChunk.trim();
  chunk = chunk.replace(/^data: /, '');
  chunk = chunk.trim();
  if (chunk === '[DONE]') {
    return `data: ${chunk}\n\n`;
  }
  const parsedChunk: PhalaChatCompletionStreamChunk = JSON.parse(chunk);
  return (
    `data: ${JSON.stringify({
      id: parsedChunk.id,
      object: parsedChunk.object,
      created: Math.floor(Date.now() / 1000),
      model: parsedChunk.model,
      provider: PHALA,
      choices: [
        {
          delta: {
            content: parsedChunk.choices[0]?.delta.content,
          },
          index: 0,
          finish_reason: '',
        },
      ],
    })}` + '\n\n'
  );
};
