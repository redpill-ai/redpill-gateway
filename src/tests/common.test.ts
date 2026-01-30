import Providers from '../providers';
import testVariables from './resources/testVariables';
import { executeChatCompletionEndpointTests } from './routeSpecificTestFunctions.ts/chatCompletion';

// Ensure suite is never empty (Jest requires at least one test)
it.skip('provider integration tests require API keys', () => {});

for (const provider in testVariables) {
  const variables = testVariables[provider];
  const config = Providers[provider];

  if (!variables.apiKey) {
    console.log(`Skipping ${provider} as API key is not provided`);
    continue;
  }

  if (config.chatComplete) {
    describe(`${provider} /chat/completions endpoint tests:`, () =>
      executeChatCompletionEndpointTests(provider, variables));
  }
}
