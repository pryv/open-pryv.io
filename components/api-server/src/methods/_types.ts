/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * The next() callback used across the method-API middleware pipeline.
 * Distinct from express.NextFunction — these middlewares are method-stage
 * links, not HTTP-stage links. Each link calls next() to advance the
 * pipeline, optionally with an error to short-circuit.
 */
export type MethodNext = (err?: unknown) => void;

// Generic per-method result accumulator (methods narrow locally as needed).
export type ResultBag = Record<string, unknown>;

/**
 * Node-style callback shape used by the storage layer's fromCallback bridge
 * and any other (err, value) -> void boundary. The value is optional because
 * the callback may be invoked with only an error.
 */
export type NodeCallback<T = unknown> = (err: unknown, value?: T) => void;
