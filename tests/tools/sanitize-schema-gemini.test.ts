/**
 * sanitizeSchemaForProvider — keywords Gemini's function-declaration Schema
 * rejects (engine 0.0.298).
 *
 * With redbtn#585 neurons get every MCP tool's REAL input schema. Checked live
 * against all 531 cached prod MCP schemas on gemini-2.5-flash and
 * gemini-3.8-flash: everything binds except tools using `exclusiveMinimum`
 * (Elite Entries), which fail the WHOLE request with 400 `Unknown name
 * "exclusiveMinimum"`. The sanitizer now narrows those keywords; everything
 * else passes through unchanged.
 */
import { describe, it, expect } from 'vitest';
import { sanitizeSchemaForProvider, toBindToolsPayload } from '../../src/lib/tools/tool-resolver';

// A real cached schema (mcpconnections "Elite Entries", eliteentries_place_paper_order).
const PAPER_ORDER = {
  type: 'object',
  properties: {
    symbol: { type: 'string', pattern: '^[A-Z][A-Z0-9.]{0,9}$', description: 'Uppercase ticker symbol, for example AAPL.' },
    side: { type: 'string', enum: ['buy', 'sell'], description: 'Paper order side.' },
    quantity: { type: 'number', exclusiveMinimum: 0, description: 'Paper order share quantity.' },
    orderType: { type: 'string', enum: ['market', 'limit'], description: 'Paper order type.' },
    limitPrice: { type: 'number', exclusiveMinimum: 0, description: 'Required by the Elite Entries API for limit paper orders.' },
  },
  required: ['symbol', 'side', 'quantity', 'orderType'],
};

describe('sanitizeSchemaForProvider', () => {
  it('turns exclusive bounds into inclusive ones (the Elite Entries 400)', () => {
    const out = sanitizeSchemaForProvider(PAPER_ORDER);
    expect(JSON.stringify(out)).not.toMatch(/exclusiveM/);
    expect(out.properties.quantity).toEqual({ type: 'number', minimum: 0, description: 'Paper order share quantity.' });
    expect(out.properties.limitPrice.minimum).toBe(0);
    // everything else untouched
    expect(out.properties.symbol).toEqual(PAPER_ORDER.properties.symbol);
    expect(out.required).toEqual(PAPER_ORDER.required);
  });

  it('keeps an explicit minimum/maximum and drops draft-04 boolean exclusives', () => {
    expect(sanitizeSchemaForProvider({ type: 'integer', minimum: 5, exclusiveMinimum: 1 })).toEqual({ type: 'integer', minimum: 5 });
    expect(sanitizeSchemaForProvider({ type: 'number', maximum: 9, exclusiveMaximum: true })).toEqual({ type: 'number', maximum: 9 });
    expect(sanitizeSchemaForProvider({ type: 'number', exclusiveMaximum: 10 })).toEqual({ type: 'number', maximum: 10 });
  });

  it('const becomes a one-value enum for strings and is dropped otherwise', () => {
    expect(sanitizeSchemaForProvider({ type: 'string', const: 'fixed' })).toEqual({ type: 'string', enum: ['fixed'] });
    expect(sanitizeSchemaForProvider({ type: 'number', const: 3 })).toEqual({ type: 'number' });
    expect(sanitizeSchemaForProvider({ type: 'string', const: 'a', enum: ['a', 'b'] })).toEqual({ type: 'string', enum: ['a', 'b'] });
  });

  it('leaves PROPERTIES named like those keywords alone', () => {
    const schema = {
      type: 'object',
      properties: {
        const: { type: 'string' },
        exclusiveMinimum: { type: 'number', exclusiveMinimum: 1 },
      },
    };
    expect(sanitizeSchemaForProvider(schema)).toEqual({
      type: 'object',
      properties: { const: { type: 'string' }, exclusiveMinimum: { type: 'number', minimum: 1 } },
    });
  });

  it('recurses into items / anyOf / oneOf and still collapses nullable type arrays', () => {
    const out = sanitizeSchemaForProvider({
      type: 'object',
      properties: {
        list: { type: 'array', items: { type: ['number', 'null'], exclusiveMinimum: 0 } },
        either: { oneOf: [{ type: 'string', const: 'x' }, { type: 'integer', exclusiveMaximum: 3 }] },
      },
    });
    expect(out.properties.list.items).toEqual({ type: 'number', minimum: 0 });
    expect(out.properties.either.oneOf).toEqual([{ type: 'string', enum: ['x'] }, { type: 'integer', maximum: 3 }]);
  });

  it('is what toBindToolsPayload hands the provider', () => {
    const [p] = toBindToolsPayload([
      { name: 'eliteentries_place_paper_order', description: 'Place a paper order', inputSchema: PAPER_ORDER, source: 'mcp', invoke: async () => null },
    ]);
    expect(JSON.stringify(p.schema)).not.toMatch(/exclusiveM/);
  });
});
