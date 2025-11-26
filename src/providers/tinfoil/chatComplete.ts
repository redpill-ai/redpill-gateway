import { ProviderConfig } from '../types';

export const TinfoilChatCompleteConfig: ProviderConfig = {
  model: {
    param: 'model',
    required: true,
  },
  messages: {
    param: 'messages',
    default: '',
  },
  functions: {
    param: 'functions',
  },
  function_call: {
    param: 'function_call',
  },
  max_tokens: {
    param: 'max_tokens',
    default: 100,
    min: 0,
  },
  temperature: {
    param: 'temperature',
    default: 1,
    min: 0,
    max: 2,
  },
  top_p: {
    param: 'top_p',
    default: 1,
    min: 0,
    max: 1,
  },
  n: {
    param: 'n',
    default: 1,
  },
  stream: {
    param: 'stream',
    default: false,
  },
  stop: {
    param: 'stop',
  },
  presence_penalty: {
    param: 'presence_penalty',
    min: -2,
    max: 2,
  },
  frequency_penalty: {
    param: 'frequency_penalty',
    min: -2,
    max: 2,
  },
  logit_bias: {
    param: 'logit_bias',
  },
  user: {
    param: 'user',
  },
  seed: {
    param: 'seed',
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
  logprobs: {
    param: 'logprobs',
    default: false,
  },
  top_logprobs: {
    param: 'top_logprobs',
  },
  stream_options: {
    param: 'stream_options',
  },
  service_tier: {
    param: 'service_tier',
  },
  parallel_tool_calls: {
    param: 'parallel_tool_calls',
  },
  max_completion_tokens: {
    param: 'max_completion_tokens',
  },
  store: {
    param: 'store',
  },
  metadata: {
    param: 'metadata',
  },
  modalities: {
    param: 'modalities',
  },
  audio: {
    param: 'audio',
  },
  prediction: {
    param: 'prediction',
  },
  reasoning_effort: {
    param: 'reasoning_effort',
  },
  web_search_options: {
    param: 'web_search_options',
  },
  prompt_cache_key: {
    param: 'prompt_cache_key',
  },
  safety_identifier: {
    param: 'safety_identifier',
  },
  verbosity: {
    param: 'verbosity',
  },
};
