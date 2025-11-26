import { ProviderConfigs } from '../types';
import PhalaApiConfig from './api';
import { PhalaChatCompleteConfig } from './chatComplete';
import { PhalaCompleteConfig } from './complete';
import { PhalaEmbedConfig } from './embed';

const PhalaConfig: ProviderConfigs = {
  complete: PhalaCompleteConfig,
  embed: PhalaEmbedConfig,
  chatComplete: PhalaChatCompleteConfig,
  api: PhalaApiConfig,
};

export default PhalaConfig;
