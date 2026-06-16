import { describe, it, expect } from 'vitest';
import {
  coerceArgsToSchema,
  coerceValueToSchema,
} from '../../src/lib/tools/coerce-args';

describe('coerceValueToSchema — positive coercion (schema requires non-string)', () => {
  it('parses a stringified object for a type:object param', () => {
    expect(
      coerceValueToSchema('{"x":1}', { type: 'object' }),
    ).toEqual({ x: 1 });
  });

  it('parses a stringified array for a type:array param', () => {
    expect(coerceValueToSchema('["a","b"]', { type: 'array' })).toEqual([
      'a',
      'b',
    ]);
  });

  it('parses a stringified number for a type:number param', () => {
    expect(coerceValueToSchema('42', { type: 'number' })).toBe(42);
    expect(coerceValueToSchema('1.5', { type: 'number' })).toBe(1.5);
  });

  it('parses a stringified integer for a type:integer param', () => {
    expect(coerceValueToSchema('7', { type: 'integer' })).toBe(7);
  });

  it('parses a stringified boolean / null when required', () => {
    expect(coerceValueToSchema('true', { type: 'boolean' })).toBe(true);
    expect(coerceValueToSchema('null', { type: 'null' })).toBe(null);
  });

  it('treats integer as a valid number and vice-versa (integral float)', () => {
    expect(coerceValueToSchema('5', { type: 'number' })).toBe(5);
    expect(coerceValueToSchema('5.0', { type: 'integer' })).toBe(5);
  });

  it('coerces when type is a union that excludes string', () => {
    expect(
      coerceValueToSchema('{"a":1}', { type: ['object', 'null'] }),
    ).toEqual({ a: 1 });
  });
});

describe('coerceValueToSchema — conservative guards (never mangle a real string)', () => {
  it('leaves a string when the schema allows string (type:string)', () => {
    expect(coerceValueToSchema('true', { type: 'string' })).toBe('true');
    expect(coerceValueToSchema('42', { type: 'string' })).toBe('42');
    expect(coerceValueToSchema('{"x":1}', { type: 'string' })).toBe('{"x":1}');
  });

  it('leaves a string when the schema type is a union that INCLUDES string', () => {
    expect(
      coerceValueToSchema('{"x":1}', { type: ['string', 'object'] }),
    ).toBe('{"x":1}');
  });

  it('leaves a string when the schema has no type (any-typed value param)', () => {
    expect(coerceValueToSchema('{"x":1}', {})).toBe('{"x":1}');
    expect(coerceValueToSchema('{"x":1}', undefined)).toBe('{"x":1}');
    // anyOf/$ref carry no top-level `type` → left untouched.
    expect(coerceValueToSchema('{"x":1}', { anyOf: [{ type: 'object' }] })).toBe(
      '{"x":1}',
    );
  });

  it('leaves a non-JSON string even when a structured type is required', () => {
    expect(coerceValueToSchema('hello', { type: 'object' })).toBe('hello');
    expect(coerceValueToSchema('', { type: 'object' })).toBe('');
  });

  it('leaves a string whose parse yields the WRONG type', () => {
    // schema wants object, but the string parses to a number → leave as string
    expect(coerceValueToSchema('42', { type: 'object' })).toBe('42');
    // schema wants array, string parses to object → leave
    expect(coerceValueToSchema('{"x":1}', { type: 'array' })).toBe('{"x":1}');
  });

  it('does not touch values that are already the right type', () => {
    const obj = { x: 1 };
    expect(coerceValueToSchema(obj, { type: 'object' })).toBe(obj); // same ref
    expect(coerceValueToSchema(5, { type: 'number' })).toBe(5);
  });
});

describe('coerceValueToSchema — nested', () => {
  it('coerces a stringified field nested in an object property', () => {
    const schema = {
      type: 'object',
      properties: {
        name: { type: 'string' },
        config: { type: 'object' },
      },
    };
    expect(
      coerceValueToSchema({ name: 'n', config: '{"a":1}' }, schema),
    ).toEqual({ name: 'n', config: { a: 1 } });
  });

  it('coerces stringified elements inside an array via items schema', () => {
    const schema = {
      type: 'array',
      items: { type: 'object' },
    };
    expect(
      coerceValueToSchema(['{"a":1}', '{"b":2}'], schema),
    ).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('coerces a typed field inside array-of-object items', () => {
    const schema = {
      type: 'object',
      properties: {
        ops: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              count: { type: 'number' },
              note: { type: 'string' },
            },
          },
        },
      },
    };
    expect(
      coerceValueToSchema(
        { ops: [{ count: '3', note: 'x' }, { count: '4', note: '5' }] },
        schema,
      ),
    ).toEqual({ ops: [{ count: 3, note: 'x' }, { count: 4, note: '5' }] });
  });

  it('leaves an any-typed leaf inside an object (no type → server decides)', () => {
    // Mirrors node-patch / state ops where `value` has no declared type.
    const schema = {
      type: 'object',
      properties: {
        ops: {
          type: 'array',
          items: {
            type: 'object',
            properties: { value: { description: 'any' } },
          },
        },
      },
    };
    expect(
      coerceValueToSchema({ ops: [{ value: '{"a":1}' }] }, schema),
    ).toEqual({ ops: [{ value: '{"a":1}' }] });
  });

  it('returns the same object reference when nothing changes', () => {
    const schema = { type: 'object', properties: { a: { type: 'string' } } };
    const input = { a: 'x' };
    expect(coerceValueToSchema(input, schema)).toBe(input);
  });
});

describe('coerceArgsToSchema — entry point', () => {
  it('coerces only the typed fields of a tool args object', () => {
    const inputSchema = {
      type: 'object',
      properties: {
        namespace: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        meta: { type: 'object' },
        value: { description: 'any-typed' }, // no type → untouched
      },
    };
    const args = {
      namespace: 'ns',
      tags: '["a","b"]',
      meta: '{"k":1}',
      value: '{"still":"string"}',
    };
    expect(coerceArgsToSchema(args, inputSchema)).toEqual({
      namespace: 'ns',
      tags: ['a', 'b'],
      meta: { k: 1 },
      value: '{"still":"string"}',
    });
  });

  it('is a no-op for a permissive / empty schema', () => {
    const args = { a: '{"x":1}' };
    expect(coerceArgsToSchema(args, { type: 'object', additionalProperties: true })).toBe(
      args,
    );
  });

  it('tolerates non-object args / missing schema', () => {
    expect(coerceArgsToSchema(undefined as never, undefined)).toBe(undefined);
    const a = { x: 1 };
    expect(coerceArgsToSchema(a, undefined)).toBe(a);
  });
});
