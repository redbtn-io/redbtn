import { describe, it, expect } from 'vitest';
import { formatStateApiError } from '../../src/lib/tools/state-error';

describe('formatStateApiError', () => {
  it('reshapes the REAL webapp 422 (string error + `errors`) into details', () => {
    const data = {
      error: 'Value does not match namespace schema',
      code: 'schema_validation_failed',
      schemaId: 'sch_1',
      mode: 'strict',
      expectedSchema: { type: 'object' },
      errors: [{ instancePath: '/name', message: 'must be string' }],
    };
    const body = formatStateApiError(data, 422, 'Unprocessable Entity', 'Global state API');
    expect(body.status).toBe(422);
    expect(body.error).toBe('Value does not match namespace schema');
    const details = body.details as Record<string, unknown>;
    expect(details.expectedSchema).toEqual({ type: 'object' });
    expect(details.validationErrors).toEqual([
      { instancePath: '/name', message: 'must be string' },
    ]);
    expect(details.code).toBe('schema_validation_failed');
  });

  it('reshapes the structured shape (error object + validationErrors)', () => {
    const data = {
      error: { message: 'Schema validation failed', code: 'schema_validation_failed' },
      expectedSchema: { type: 'object' },
      validationErrors: [{ path: '/name', message: 'must be string' }],
    };
    const body = formatStateApiError(data, 422, 'Unprocessable Entity', 'Global state API');
    expect(body.error).toBe('Schema validation failed');
    expect((body.details as Record<string, unknown>).validationErrors).toBeDefined();
  });

  it('synthesizes an envelope for a non-object body (no details)', () => {
    const body = formatStateApiError(null, 500, 'Internal Server Error', 'State patch API');
    expect(body).toEqual({ error: 'State patch API 500 Internal Server Error', status: 500 });
    expect(body.details).toBeUndefined();
  });

  it('handles a plain string-error body with no validation context', () => {
    const body = formatStateApiError({ error: 'Forbidden' }, 403, 'Forbidden', 'Global state API');
    expect(body).toEqual({ error: 'Forbidden', status: 403 });
  });
});
