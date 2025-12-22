import { ProviderConfigs } from '../types';
import TinfoilApiConfig from './api';
import { TinfoilChatCompleteConfig } from './chatComplete';
import { TinfoilCompleteConfig } from './complete';
import {
  OpenAIToAnthropicMessagesConfig,
  OpenAIToAnthropicMessagesResponseTransform,
  OpenAIToAnthropicMessagesStreamTransform,
} from '../openai-to-anthropic';

const TinfoilConfig: ProviderConfigs = {
  complete: TinfoilCompleteConfig,
  chatComplete: TinfoilChatCompleteConfig,
  messages: OpenAIToAnthropicMessagesConfig,
  api: TinfoilApiConfig,
  responseTransforms: {
    messages: OpenAIToAnthropicMessagesResponseTransform,
    'stream-messages': OpenAIToAnthropicMessagesStreamTransform,
  },
};

export default TinfoilConfig;
