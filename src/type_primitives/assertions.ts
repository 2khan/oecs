import { TYPE_ERROR, TypeError } from "./error";

export function assert_non_null<T>(value: T): asserts value is NonNullable<T> {
  //
  // Checks if value is not null or undefined
  // value == null is true for both value == null and value == undefined
  //
  if (__DEV__ && value == null)
    throw new TypeError(
      TYPE_ERROR.ASSERTION_FAIL_NON_NULLABLE,
      "Expected type to be not NULL or UNDEFINED",
    );
}

export function assert<T, Result extends T = T>(
  value: T,
  condition: (v: T) => v is Result,
  err_message: string,
): asserts value is Result {
  //
  // Checks if a condition is met and assert
  // Generic T is the type of value
  // Generic Result is an optional value for type-casting
  //
  if (__DEV__ && !condition(value)) {
    throw new TypeError(
      TYPE_ERROR.ASSERTION_FAIL_CONDITION,
      `Expected value to meet condition: ${err_message}`,
    );
  }
}

export function validate_and_cast<T, Result extends T = T>(
  value: T,
  validator: (v: T) => boolean,
  err_message: string,
): Result {
  //
  // Checks if a condition is met and return casted value
  // Generic T is the type of value
  // Generic Result is an optional value for type-casting
  //
  if (__DEV__ && !validator(value)) {
    throw new TypeError(
      TYPE_ERROR.VALIDATION_FAIL_CONDITION,
      `Expected value to meet validation: ${err_message}`,
    );
  }
  return value as Result;
}

export function unsafe_cast<T>(value: unknown): T {
  return value as T;
}
