import { describe, it, expect } from 'vitest';
import { checkEvolutionGuard } from './evolution-guards.js';

describe('Evolution Guards', () => {
  it('should block changes to protected functions with @evolution:ignore', async () => {
    const mockFile = `
/**
 * @evolution:ignore
 * This function must never be auto-modified
 */
export function criticalMemoryFunction(): void {
  // Critical code
}
`;

    const result = await checkEvolutionGuard({
      description: 'Modify critical function',
      patches: [{
        file: 'test.ts',
        search: 'export function criticalMemoryFunction(): void {',
        replace: '// Modified by evolution\nexport function criticalMemoryFunction(): void {'
      }],
      affectedFiles: ['test.ts']
    }, {
      protectedTags: ['@evolution:ignore'],
      protectedPatterns: [],
      criticalTestThreshold: 2,
      enabled: true
    });

    expect(result[0].allowed).toBe(false);
    expect(result[0].reason).toContain('@evolution:ignore');
    expect(result[0].protectedFunction).toBe('criticalMemoryFunction');
  });

  it('should allow changes to non-protected functions', async () => {
    const mockFile = `
export function regularFunction(): void {
  // Regular code that can be evolved
}
`;

    const result = await checkEvolutionGuard({
      description: 'Modify regular function',
      patches: [{
        file: 'test.ts',
        search: 'export function regularFunction(): void {',
        replace: '// Improved by evolution\nexport function regularFunction(): void {'
      }],
      affectedFiles: ['test.ts']
    }, {
      protectedTags: ['@evolution:ignore'],
      protectedPatterns: [],
      criticalTestThreshold: 2,
      enabled: true
    });

    expect(result[0].allowed).toBe(true);
  });

  it('should require extra tests for @evolution:critical functions', async () => {
    const mockFile = `
/**
 * @evolution:critical
 * Important function - requires extra scrutiny
 */
export function importantFunction(): void {
  // Important code
}
`;

    const result = await checkEvolutionGuard({
      description: 'Modify critical function',
      patches: [{
        file: 'test.ts',
        search: 'export function importantFunction(): void {',
        replace: '// Enhanced by evolution\nexport function importantFunction(): void {'
      }],
      affectedFiles: ['test.ts']
    }, {
      protectedTags: ['@evolution:ignore'],
      protectedPatterns: [],
      criticalTestThreshold: 3,
      enabled: true
    });

    expect(result[0].allowed).toBe(true);
    expect(result[0].requiredTests).toBe(3);
    expect(result[0].reason).toContain('requires 3x test passes');
  });

  it('should block changes to files matching protected patterns', async () => {
    const result = await checkEvolutionGuard({
      description: 'Modify security file',
      patches: [{
        file: 'src/security/audit.ts',
        search: 'export function audit()',
        replace: 'export function auditImproved()'
      }],
      affectedFiles: ['src/security/audit.ts']
    }, {
      protectedTags: [],
      protectedPatterns: ['**/security/*.ts'],
      criticalTestThreshold: 2,
      enabled: true
    });

    expect(result[0].allowed).toBe(false);
    expect(result[0].reason).toContain('protected pattern');
  });

  it('should allow all changes when guards are disabled', async () => {
    const result = await checkEvolutionGuard({
      description: 'Modify any function',
      patches: [{
        file: 'any-file.ts',
        search: 'anything',
        replace: 'modified'
      }],
      affectedFiles: ['any-file.ts']
    }, {
      protectedTags: ['@evolution:ignore'],
      protectedPatterns: ['**/*'],
      criticalTestThreshold: 2,
      enabled: false  // Disabled
    });

    expect(result[0].allowed).toBe(true);
    expect(result[0].reason).toBe('Guards disabled');
  });
});
