import { ProviderConfigs } from '../types';
import ZeroGApiConfig from './api';
import { ZeroGChatCompleteConfig } from './chatComplete';
import { ZeroGCompleteConfig } from './complete';
import {
  OpenAIToAnthropicMessagesConfig,
  OpenAIToAnthropicMessagesResponseTransform,
  OpenAIToAnthropicMessagesStreamTransform,
} from '../openai-to-anthropic';

const ZeroGConfig: ProviderConfigs = {
  complete: ZeroGCompleteConfig,
  chatComplete: ZeroGChatCompleteConfig,
  messages: OpenAIToAnthropicMessagesConfig,
  api: ZeroGApiConfig,
  responseTransforms: {
    messages: OpenAIToAnthropicMessagesResponseTransform,
    'stream-messages': OpenAIToAnthropicMessagesStreamTransform,
  },
};

export default ZeroGConfig;
