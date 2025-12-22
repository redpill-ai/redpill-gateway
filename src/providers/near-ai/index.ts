import { ProviderConfigs } from '../types';
import NearAIApiConfig from './api';
import { NearAIChatCompleteConfig } from './chatComplete';
import { NearAICompleteConfig } from './complete';
import {
  OpenAIToAnthropicMessagesConfig,
  OpenAIToAnthropicMessagesResponseTransform,
  OpenAIToAnthropicMessagesStreamTransform,
} from '../openai-to-anthropic';

const NearAIConfig: ProviderConfigs = {
  complete: NearAICompleteConfig,
  chatComplete: NearAIChatCompleteConfig,
  messages: OpenAIToAnthropicMessagesConfig,
  api: NearAIApiConfig,
  responseTransforms: {
    messages: OpenAIToAnthropicMessagesResponseTransform,
    'stream-messages': OpenAIToAnthropicMessagesStreamTransform,
  },
};

export default NearAIConfig;
