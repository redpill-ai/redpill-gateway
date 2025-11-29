import { ProviderConfigs } from '../types';
import NearAIApiConfig from './api';
import { NearAIChatCompleteConfig } from './chatComplete';
import { NearAICompleteConfig } from './complete';

const NearAIConfig: ProviderConfigs = {
  complete: NearAICompleteConfig,
  chatComplete: NearAIChatCompleteConfig,
  api: NearAIApiConfig,
};

export default NearAIConfig;
