import { ProviderConfigs } from '../types';
import SecretAIApiConfig from './api';
import { SecretAIChatCompleteConfig } from './chatComplete';
import { SecretAICompleteConfig } from './complete';
import {
  OpenAIToAnthropicMessagesConfig,
  OpenAIToAnthropicMessagesResponseTransform,
  OpenAIToAnthropicMessagesStreamTransform,
} from '../openai-to-anthropic';

const SecretAIConfig: ProviderConfigs = {
  complete: SecretAICompleteConfig,
  chatComplete: SecretAIChatCompleteConfig,
  messages: OpenAIToAnthropicMessagesConfig,
  api: SecretAIApiConfig,
  responseTransforms: {
    messages: OpenAIToAnthropicMessagesResponseTransform,
    'stream-messages': OpenAIToAnthropicMessagesStreamTransform,
  },
};

export default SecretAIConfig;
