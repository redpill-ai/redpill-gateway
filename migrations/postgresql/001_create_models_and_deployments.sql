-- Migration: Create models and model_deployments tables
-- Date: 2025-08-16
-- Description: Initial schema for AI Gateway model management

-- Models table - stores base model information
CREATE TABLE models (
    id SERIAL PRIMARY KEY,
    model_id VARCHAR(100) UNIQUE NOT NULL,  -- e.g., 'meta-llama/llama-3.3-70b-instruct'
    name VARCHAR(255) NOT NULL,              -- e.g., 'Llama 3.3 70B Instruct'
    description TEXT,
    specs JSONB DEFAULT '{}',                -- model technical specifications
    active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Model deployments table - stores deployment configurations for routing
CREATE TABLE model_deployments (
    id SERIAL PRIMARY KEY,
    model_id INTEGER NOT NULL REFERENCES models(id) ON DELETE CASCADE,
    provider_name VARCHAR(50) NOT NULL,     -- e.g., 'openai', 'anthropic', 'inference-net'
    deployment_name VARCHAR(255) NOT NULL,  -- e.g., 'gpt-4-turbo', 'claude-3-sonnet-prod'
    config JSONB NOT NULL,                  -- deployment configuration (api, pricing, limits, routing)
    active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(model_id, provider_name, deployment_name)
);

-- Indexes for performance
CREATE INDEX idx_deployments_provider ON model_deployments(provider_name);
