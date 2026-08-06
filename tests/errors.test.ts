/**
 * Tests for the caught-value helpers in src/utils/errors.ts.
 *
 * The whole point of these helpers is the non-`Error` cases: `catch (err: any)`
 * plus `err.message` renders the literal string "undefined" for a thrown string
 * or a plain object, which is what these tests pin down.
 */

import { errorMessage, errorCode } from '../src/utils/errors';

describe('errorMessage', () => {
  it('returns the message of a real Error', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom');
  });

  it('returns the message of an Error subclass', () => {
    class HttpError extends Error {}
    expect(errorMessage(new HttpError('404 not found'))).toBe('404 not found');
  });

  it('returns a thrown string as-is', () => {
    expect(errorMessage('plain string failure')).toBe('plain string failure');
  });

  it('reads .message from a plain object (axios/node-fetch style)', () => {
    expect(errorMessage({ message: 'connect ECONNREFUSED' })).toBe('connect ECONNREFUSED');
  });

  it('ignores a non-string .message and falls back to String()', () => {
    expect(errorMessage({ message: 42 })).toBe('[object Object]');
  });

  it('ignores an empty .message and falls back to String()', () => {
    expect(errorMessage({ message: '' })).toBe('[object Object]');
  });

  it('never returns the literal "undefined" for undefined', () => {
    // The bug this helper exists to prevent: `err.message` on `undefined`
    // throws, and on a non-Error yields the string "undefined".
    expect(errorMessage(undefined)).toBe('undefined');
    expect(errorMessage(null)).toBe('null');
  });

  it('stringifies primitives', () => {
    expect(errorMessage(0)).toBe('0');
    expect(errorMessage(false)).toBe('false');
  });
});

describe('errorCode', () => {
  it('reads a string code off a Node ErrnoException', () => {
    const err = Object.assign(new Error('no such file'), { code: 'ENOENT' });
    expect(errorCode(err)).toBe('ENOENT');
  });

  it('reads a string code off a plain object', () => {
    expect(errorCode({ code: 'EACCES' })).toBe('EACCES');
  });

  it('returns undefined for a numeric code', () => {
    expect(errorCode({ code: 500 })).toBeUndefined();
  });

  it('returns undefined when there is no code', () => {
    expect(errorCode(new Error('nope'))).toBeUndefined();
    expect(errorCode('string failure')).toBeUndefined();
    expect(errorCode(null)).toBeUndefined();
    expect(errorCode(undefined)).toBeUndefined();
  });
});
