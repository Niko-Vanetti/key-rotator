import * as path from 'node:path';

/**
 * Security boundary for the agent's file tools: every path the model asks for
 * must resolve INSIDE the current working folder. Absolute paths outside it,
 * `..` escapes, and drive changes are all rejected before touching the disk.
 * (Windows note: path.win32.relative compares case-insensitively.)
 */

/**
 * Resolve `p` (relative or absolute) against `base` and return the absolute
 * path, or null if it lands outside `base`.
 */
export function resolveInside(base: string, p: string): string | null {
  const absBase = path.resolve(base);
  const target = path.resolve(absBase, p);
  const rel = path.relative(absBase, target);
  if (rel === '') return target; // base itself
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return target;
}

/** True when `p` (already absolute or relative to base) stays inside base. */
export function isInside(base: string, p: string): boolean {
  return resolveInside(base, p) !== null;
}
