import assert from 'node:assert/strict';

export function expect(actual, message = '') {
  const label = message || 'expectation failed';
  return {
    toBe(expected) {
      assert.equal(actual, expected, label);
    },
    toBeGreaterThan(expected) {
      assert.ok(actual > expected, message || `expected ${actual} to be greater than ${expected}`);
    },
    toEqual(expected) {
      assert.deepEqual(actual, expected, label);
    },
    toContain(expected) {
      assert.ok(actual?.includes?.(expected), message || `expected value to contain ${expected}`);
    },
    toBeTruthy() {
      assert.ok(actual, label);
    },
    toBeNull() {
      assert.equal(actual, null, label);
    },
    toHaveProperty(property) {
      assert.ok(
        actual != null && Object.prototype.hasOwnProperty.call(actual, property),
        message || `expected value to have property ${property}`
      );
    },
    toThrow(pattern) {
      assert.equal(typeof actual, 'function', 'toThrow expects a function');
      assert.throws(actual, pattern, message || undefined);
    },
    not: {
      toContain(expected) {
        assert.ok(!actual?.includes?.(expected), message || `expected value not to contain ${expected}`);
      },
    },
  };
}
