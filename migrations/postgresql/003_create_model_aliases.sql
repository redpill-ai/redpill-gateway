-- Migration: Create model_aliases table for model name aliases
-- Date: 2025-08-17
-- Description: Add support for model name aliases to improve usability

CREATE TABLE model_aliases (
    id SERIAL PRIMARY KEY,
    model_id VARCHAR(100) NOT NULL REFERENCES models(id) ON DELETE CASCADE,
    alias VARCHAR(255) NOT NULL UNIQUE,
    active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);