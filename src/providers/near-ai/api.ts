import { ProviderAPIConfig } from '../types';

const NearAIApiConfig: ProviderAPIConfig = {
  getBaseURL: () => '',
  headers: ({ providerOptions }) => {
    return { Authorization: `Bearer ${providerOptions.apiKey}` };
  },
  getEndpoint: ({ fn, gatewayRequestBodyJSON, c }) => {
    const videoId =
      gatewayRequestBodyJSON?.id ||
      gatewayRequestBodyJSON?.queue_id ||
      c.req.param('id');
    switch (fn) {
      case 'complete':
        return '/completions';
      case 'chatComplete':
        return '/chat/completions';
      case 'messages':
        return '/chat/completions';
      case 'submitVideo':
        return '/v1/videos';
      case 'retrieveVideo':
        return `/v1/videos/${videoId}`;
      case 'fetchVideoFile':
        return `/v1/videos/${videoId}/file`;
      default:
        return '';
    }
  },
};

export default NearAIApiConfig;
