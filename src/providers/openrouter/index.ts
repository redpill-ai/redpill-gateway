import { ProviderConfigs } from '../types';
import OpenrouterAPIConfig from './api';
import {
  OpenrouterChatCompleteConfig,
  OpenrouterChatCompleteResponseTransform,
  OpenrouterChatCompleteStreamChunkTransform,
} from './chatComplete';
import {
  OpenAIToAnthropicMessagesConfig,
  OpenAIToAnthropicMessagesResponseTransform,
  OpenAIToAnthropicMessagesStreamTransform,
} from '../openai-to-anthropic';

const OpenrouterConfig: ProviderConfigs = {
  chatComplete: OpenrouterChatCompleteConfig,
  messages: OpenAIToAnthropicMessagesConfig,
  api: OpenrouterAPIConfig,
  responseTransforms: {
    chatComplete: OpenrouterChatCompleteResponseTransform,
    'stream-chatComplete': OpenrouterChatCompleteStreamChunkTransform,
    messages: OpenAIToAnthropicMessagesResponseTransform,
    'stream-messages': OpenAIToAnthropicMessagesStreamTransform,
  },
};

export default OpenrouterConfig;
