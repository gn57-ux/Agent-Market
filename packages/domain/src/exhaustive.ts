/**
 * Compile-time exhaustiveness guard. Call this in the `default`/`else`
 * branch of a switch over a discriminated union's tag. If a new variant
 * is added to the union but not handled above, `value` will no longer be
 * typed `never` at the call site and `tsc` will fail to compile.
 */
export function assertExhaustive(value: never, context: string): never {
  throw new Error(`Unhandled variant in ${context}: ${JSON.stringify(value)}`);
}
