import { ProviderAPIConfig } from '../types';

const PhalaApiConfig: ProviderAPIConfig = {
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
      case 'embed':
        return '/embeddings';
      default:
        return '';
    }
  },
};

export default PhalaApiConfig;
