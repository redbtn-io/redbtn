/**
 * Node model helpers
 *
 * Utility functions for working with universal node parameter definitions.
 * Parameters are stored in MongoDB as a map: { fieldName: { type, default, ... } }
 */

export interface ParameterDef {
  type: 'string' | 'number' | 'boolean' | 'select';
  default?: any;
  min?: number;
  max?: number;
  enum?: string[];
  description?: string;
  stepIndex?: number;
  configPath?: string;
}

export type ParametersMap = Record<string, ParameterDef>;

/**
 * Normalize parameters from MongoDB format to a plain Record.
 * Handles both object form { fieldName: { type, default, ... } }
 * and array form [{ name, type, default, ... }].
 */
export function parametersMapToObject(params: any): ParametersMap {
  if (!params) return {};
  if (Array.isArray(params)) {
    const result: ParametersMap = {};
    for (const p of params) {
      if (p && p.name) {
        const { name, ...rest } = p;
        result[name] = rest;
      }
    }
    return result;
  }
  return params as ParametersMap;
}

/**
 * Validate graph-provided parameter values against their definitions.
 * Returns an array of warning strings (caller decides severity).
 */
export function validateParameters(
  graphParams: Record<string, any>,
  paramDefs: ParametersMap,
): string[] {
  const warnings: string[] = [];
  for (const [key, value] of Object.entries(graphParams)) {
    const def = paramDefs[key];
    if (!def) {
      warnings.push(`Unknown parameter: ${key}`);
      continue;
    }
    if (def.type === 'number') {
      const num = Number(value);
      if (isNaN(num)) {
        warnings.push(`Parameter ${key}: expected number, got ${typeof value}`);
      } else {
        if (def.min !== undefined && num < def.min) {
          warnings.push(`Parameter ${key}: value ${num} is below minimum ${def.min}`);
        }
        if (def.max !== undefined && num > def.max) {
          warnings.push(`Parameter ${key}: value ${num} exceeds maximum ${def.max}`);
        }
      }
    } else if (def.type === 'select' && def.enum) {
      if (!def.enum.includes(String(value))) {
        warnings.push(`Parameter ${key}: "${value}" not in allowed values: ${def.enum.join(', ')}`);
      }
    }
  }
  return warnings;
}

/**
 * Resolve parameters by merging defaults from definitions with graph-provided overrides.
 * Returns a flat { fieldName: resolvedValue } object for use in templates.
 */
export function resolveParameters(
  paramDefs: ParametersMap,
  graphParams: Record<string, any>,
): Record<string, any> {
  const resolved: Record<string, any> = {};

  // Start with defaults from definitions
  for (const [key, def] of Object.entries(paramDefs)) {
    if (key in graphParams) {
      const raw = graphParams[key];
      resolved[key] = def.type === 'number' ? Number(raw) : raw;
    } else if (def.default !== undefined) {
      resolved[key] = def.default;
    }
  }

  // Pass through any extra graph params not in defs
  for (const [key, value] of Object.entries(graphParams)) {
    if (!(key in resolved)) {
      resolved[key] = value;
    }
  }

  return resolved;
}
