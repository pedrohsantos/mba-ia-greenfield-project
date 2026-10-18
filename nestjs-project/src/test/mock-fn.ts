/**
 * Returns the jest mock stored at `obj[key]`.
 * `expect(mocked.method)` passes an unbound class method and trips
 * `@typescript-eslint/unbound-method`; `expect(mockFn(mocked, 'method'))` does not.
 */
export function mockFn<T extends object, K extends keyof T>(
  obj: T,
  key: K,
): jest.Mock {
  return obj[key] as unknown as jest.Mock;
}
