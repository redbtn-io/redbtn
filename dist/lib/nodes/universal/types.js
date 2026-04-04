"use strict";
/**
 * Universal Node Types
 *
 * This module defines the type system for universal nodes - config-driven nodes
 * that execute 1-N steps sequentially without requiring code deployment.
 *
 * Universal nodes support step types:
 * - neuron: Execute LLM calls
 * - tool: Call MCP tools
 * - transform: Transform data (map/filter/select)
 * - conditional: Set fields based on conditions
 * - loop: Iterate over steps
 * - delay: Wait for specified time
 * - connection: Access user's external service credentials
 */
Object.defineProperty(exports, "__esModule", { value: true });
