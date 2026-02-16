export abstract class AppError extends Error {
  constructor(
    message: string,
    public readonly is_operational: boolean,
    public readonly context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = this.constructor.name;
    Error.captureStackTrace(this, this.constructor);
  }
}

export enum ECS_ERROR {
  EID_MAX_INDEX_OVERFLOW = "EID_MAX_INDEX_OVERFLOW",
  EID_MAX_GEN_OVERFLOW = "EID_MAX_GEN_OVERFLOW",
  ENTITY_CANT_DESTROY_DEAD = "ENTITY_CANT_DESTROY_DEAD",
  COMPONENT_NOT_REGISTERED = "COMPONENT_NOT_REGISTERED",
  ENTITY_NOT_ALIVE = "ENTITY_NOT_ALIVE",
  ENTITY_NOT_IN_ARCHETYPE = "ENTITY_NOT_IN_ARCHETYPE",
  CIRCULAR_SYSTEM_DEPENDENCY = "CIRCULAR_SYSTEM_DEPENDENCY",
  DUPLICATE_SYSTEM = "DUPLICATE_SYSTEM",
  SYSTEM_NOT_FOUND = "SYSTEM_NOT_FOUND",
  ARCHETYPE_NOT_FOUND = "ARCHETYPE_NOT_FOUND",
}

export class ECSError extends AppError {
  constructor(
    public readonly category: ECS_ERROR,
    message?: string,
    context?: Record<string, unknown>,
  ) {
    super(message ?? category, true, context);
  }
}

export function is_ecs_error(error: unknown): error is ECSError {
  return error instanceof ECSError;
}
