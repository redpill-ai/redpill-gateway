import { ProviderConfig } from '../types';
import { Params } from '../../types/requestBody';

// Reasoning-effort remapping scoped to z-ai/glm-5.2 only.
//
// The GLM-5.2 sglang upstream accepts reasoning_effort values of
// low | medium | high | max and rejects anything else with a 400. Map the
// OpenAI-style values clients commonly send onto that set; values already in
// the accepted set (low/medium/high/max) pass through unchanged.
//
// Intentionally gated to GLM-5.2 so other phala models keep the verbatim
// reasoning_effort passthrough until their own upstream vocabularies are
// verified. By the time this transform runs the gateway has already rewritten
// params.model to the deployment name (overrideModelFromContext), so we match
// the deployment name as well as the canonical/upstream ids.
const GLM_5_2_MODEL_IDS = new Set([
  'glm-5.2', // deployment_name (what the gateway forwards upstream)
  'z-ai/glm-5.2', // canonical model id
  'glm-5.2-fp8', // raw upstream model id
]);

const GLM_5_2_REASONING_EFFORT_MAP: Record<string, string> = {
  minimal: 'low',
  auto: 'medium',
  xhigh: 'max',
};

const mapReasoningEffort = (params: Params) => {
  const effort = params.reasoning_effort;
  if (typeof effort !== 'string') return effort;
  const model =
    typeof params.model === 'string' ? params.model.toLowerCase() : '';
  if (!GLM_5_2_MODEL_IDS.has(model)) return effort;
  return GLM_5_2_REASONING_EFFORT_MAP[effort] ?? effort;
};

export const PhalaChatCompleteConfig: ProviderConfig = {
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
  // sglang-native sampling params (forwarded verbatim when the client sends
  // them; the upstream validates ranges).
  top_k: {
    param: 'top_k',
  },
  min_p: {
    param: 'min_p',
  },
  repetition_penalty: {
    param: 'repetition_penalty',
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
    transform: (params: Params) => mapReasoningEffort(params),
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
  chat_template_kwargs: {
    param: 'chat_template_kwargs',
  },
};
