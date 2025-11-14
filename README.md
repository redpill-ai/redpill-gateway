# 🔴 RedPill Gateway

**Privacy-First AI Gateway Running Entirely in TEE (Trusted Execution Environments)**

RedPill is an open-source AI gateway that routes requests to 50+ LLMs while running the entire infrastructure inside hardware-protected secure enclaves. Unlike traditional gateways, **every request** is cryptographically secured at the hardware level.

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0-blue.svg)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-20+-green.svg)](https://nodejs.org/)

## 🌟 Key Features

- 🔒 **Hardware-Enforced Privacy** - Entire gateway runs in TEE (Intel TDX)
- 🌐 **50+ AI Models** - OpenAI, Anthropic, Google, Meta, DeepSeek, and more
- 🛡️ **Confidential AI** - Native Phala TEE models with GPU secure enclaves
- ✅ **Verifiable Execution** - Cryptographic attestation for all requests
- 🚀 **OpenAI Compatible** - Drop-in replacement for OpenAI SDK
- 📊 **Production Ready** - Built on battle-tested Hono framework
- 🔐 **End-to-End Security** - TLS → TEE → Provider encryption

## 🚀 Quick Start

### Prerequisites

- Node.js 20+
- npm or yarn
- (Optional) Redis for caching
- (Optional) PostgreSQL for request logging

### Installation

```bash
# Clone the repository
git clone https://github.com/redpill-ai/redpill-gateway.git
cd redpill-gateway

# Install dependencies
npm install

# Start development server
npm run dev:node
```

Gateway runs on `http://localhost:8787`

### Production Build

```bash
# Build for production
npm run build

# Start production server
node build/start-server.js
```

## 📖 Usage

### Basic Request

```bash
curl http://localhost:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{
    "model": "openai/gpt-5",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

### With OpenAI SDK

```python
from openai import OpenAI

client = OpenAI(
    api_key="YOUR_API_KEY",
    base_url="http://localhost:8787/v1"
)

response = client.chat.completions.create(
    model="openai/gpt-5",
    messages=[{"role": "user", "content": "Hello!"}]
)

print(response.choices[0].message.content)
```

### Confidential AI (Phala Models)

```python
# Use TEE-protected models for maximum privacy
response = client.chat.completions.create(
    model="phala/deepseek-chat-v3-0324",
    messages=[{"role": "user", "content": "Analyze sensitive data..."}]
)
```

## 🔐 Verification

Get cryptographic proof that requests run in genuine TEE:

```bash
# Generate fresh nonce
NONCE=$(openssl rand -hex 32)

# Get attestation with nonce
curl "http://localhost:8787/v1/attestation/report?nonce=$NONCE" \
  -H "Authorization: Bearer YOUR_API_KEY"
```

See [Documentation](https://docs.redpill.ai) for complete verification guide.

## 🎯 Supported Models

- **OpenAI**: GPT-5, GPT-5 Mini, O3, O4 Mini, GPT-4.1 series
- **Anthropic**: Claude Sonnet 4.5, Claude Opus 4.1, Claude 3.7 Sonnet
- **Google**: Gemini 2.5 Pro, Gemini 2.5 Flash
- **Meta**: Llama 3.3, Llama 3.2
- **Phala Confidential**: DeepSeek V3, GPT-OSS 120B, Qwen 2.5 (TEE-protected)

[See all 50+ models](https://docs.redpill.ai/concepts/supported-models)

## 📚 Documentation

- **Full Documentation**: https://docs.redpill.ai
- **API Reference**: https://docs.redpill.ai/api-reference
- **Verification Guide**: https://docs.redpill.ai/confidential-ai/attestation
## 🧪 Testing

```bash
npm run test:gateway
```

## 📦 Deployment

### Docker

```bash
docker build -t redpill-gateway .
docker run -p 8787:8787 redpill-gateway
```

### Cloudflare Workers

```bash
npm run deploy
```

## 🤝 Contributing

We welcome contributions! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## 📜 License

MIT License - see [LICENSE](LICENSE) for details.

## 🙏 Attribution

Based on [Portkey AI Gateway](https://github.com/Portkey-AI/gateway) with major enhancements:
- TEE integration (Intel TDX, NVIDIA Confidential Computing)
- Cryptographic attestation and signature generation
- Phala confidential AI model support
- Hardware-enforced privacy guarantees

## 🔗 Links

- **Website**: https://redpill.ai
- **Documentation**: https://docs.redpill.ai
- **Discord**: https://discord.gg/redpill

---

**Built with 💜 by the RedPill team** • *Making AI privacy-first, one request at a time.*
