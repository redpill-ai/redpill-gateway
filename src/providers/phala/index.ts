import { ProviderConfigs } from '../types';
import PhalaApiConfig from './api';
import { PhalaChatCompleteConfig } from './chatComplete';
import { PhalaCompleteConfig } from './complete';
import { PhalaEmbedConfig } from './embed';
import {
  OpenAIToAnthropicMessagesConfig,
  OpenAIToAnthropicMessagesResponseTransform,
  OpenAIToAnthropicMessagesStreamTransform,
} from '../openai-to-anthropic';

const PhalaConfig: ProviderConfigs = {
  complete: PhalaCompleteConfig,
  embed: PhalaEmbedConfig,
  chatComplete: PhalaChatCompleteConfig,
  messages: OpenAIToAnthropicMessagesConfig,
  api: PhalaApiConfig,
  responseTransforms: {
    messages: OpenAIToAnthropicMessagesResponseTransform,
    'stream-messages': OpenAIToAnthropicMessagesStreamTransform,
  },
};

export default PhalaConfig;
