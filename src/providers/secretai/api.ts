import { ProviderAPIConfig } from '../types';

const SecretAIApiConfig: ProviderAPIConfig = {
  getBaseURL: () => '',
  headers: ({ providerOptions }) => {
    return { Authorization: `Bearer ${providerOptions.apiKey}` };
  },
  getEndpoint: ({ fn }) => {
    switch (fn) {
      case 'complete':
        return '/completions';
      case 'chatComplete':
        return '/chat/completions';
      case 'messages':
        return '/chat/completions';
      default:
        return '';
    }
  },
};

export default SecretAIApiConfig;
