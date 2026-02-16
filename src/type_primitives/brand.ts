/***
 *
 * Type Brand
 *
 ***/

declare const brand: unique symbol;

export type Brand<T, BrandName extends string> = T & {
  readonly [brand]: BrandName;
};
