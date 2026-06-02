import { ProviderConfigs } from '../types';
import ZeroGApiConfig from './api';
import { ZeroGChatCompleteConfig } from './chatComplete';
import { ZeroGCompleteConfig } from './complete';
import { createExtraFieldStripper } from '../utils';
import {
  OpenAIToAnthropicMessagesConfig,
  OpenAIToAnthropicMessagesResponseTransform,
  OpenAIToAnthropicMessagesStreamTransform,
} from '../openai-to-anthropic';

// Non-standard top-level fields 0g adds to OpenAI-compatible responses that
// should not be forwarded to the user.
const ZeroGExtraFields = ['x_0g_trace'];
const {
  chatComplete: ZeroGStripChatComplete,
  streamChatComplete: ZeroGStripStreamChatComplete,
} = createExtraFieldStripper(ZeroGExtraFields);

const ZeroGConfig: ProviderConfigs = {
  complete: ZeroGCompleteConfig,
  chatComplete: ZeroGChatCompleteConfig,
  messages: OpenAIToAnthropicMessagesConfig,
  api: ZeroGApiConfig,
  responseTransforms: {
    chatComplete: ZeroGStripChatComplete,
    'stream-chatComplete': ZeroGStripStreamChatComplete,
    messages: OpenAIToAnthropicMessagesResponseTransform,
    'stream-messages': OpenAIToAnthropicMessagesStreamTransform,
  },
};

export default ZeroGConfig;
