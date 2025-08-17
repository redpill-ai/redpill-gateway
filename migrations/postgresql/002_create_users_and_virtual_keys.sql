-- Migration: Create users and virtual_keys tables
-- Date: 2025-08-17
-- Description: User management and API key system for AI Gateway

-- Users table - stores user accounts and quotas
CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    username VARCHAR(255) NOT NULL UNIQUE,
    email VARCHAR(255) NOT NULL UNIQUE,
    budget_limit DECIMAL(30,18),             -- null = unlimited budget
    budget_used DECIMAL(30,18) DEFAULT 0,
    rate_limit_rpm INTEGER,                  -- requests per minute, null = no limit
    rate_limit_tpm INTEGER,                  -- tokens per minute, null = no limit
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Virtual keys table - stores API keys for users
CREATE TABLE virtual_keys (
    id SERIAL PRIMARY KEY,
    key_name VARCHAR(50) NOT NULL,          -- system-generated mask like "sk-...xyz1234"
    key_alias VARCHAR(255),                 -- user-defined friendly name
    api_key_hash VARCHAR(255) NOT NULL UNIQUE, -- hashed API key for security
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    active BOOLEAN DEFAULT true,
    budget_limit DECIMAL(30,18),             -- null = inherit from user
    budget_used DECIMAL(30,18) DEFAULT 0,
    rate_limit_rpm INTEGER,                  -- null = inherit from user
    rate_limit_tpm INTEGER,                  -- null = inherit from user
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for performance
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_username ON users(username);
CREATE INDEX idx_virtual_keys_api_key_hash ON virtual_keys(api_key_hash);