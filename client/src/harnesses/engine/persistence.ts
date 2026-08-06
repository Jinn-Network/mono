/**
 * Relocated 2026-08-05 (one-swap P0-1, DR-2026-08-05). This shim retires with
 * the engine tree.
 *
 * The implementation now lives at `client/src/store/task-run-persistence.ts`.
 * Engine-tree modules and their tests keep importing this path unchanged.
 */

export * from '../../store/task-run-persistence.js';
