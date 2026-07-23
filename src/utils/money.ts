/**
 * Money helpers. All fee/salary/expense arithmetic uses Prisma's Decimal
 * (decimal.js) — never JS `Number`/float. Currency is PKR.
 */
import { Prisma } from '@prisma/client';

export type Money = Prisma.Decimal;
export const Decimal = Prisma.Decimal;
export const ZERO = new Prisma.Decimal(0);

/** Coerce anything (Decimal | number | string | null) to a Decimal. */
export function money(v: Prisma.Decimal | number | string | null | undefined): Money {
  if (v === null || v === undefined) return new Prisma.Decimal(0);
  return v instanceof Prisma.Decimal ? v : new Prisma.Decimal(v);
}

/** Sum a list of decimals safely. */
export function sum(values: (Prisma.Decimal | number | string)[]): Money {
  return values.reduce<Money>((acc, v) => acc.plus(money(v)), new Prisma.Decimal(0));
}

/** Clamp a value to [0, max]. Used to cap allocations at a balance. */
export function clampToBalance(value: Money, balance: Money): Money {
  if (value.lessThan(0)) return new Prisma.Decimal(0);
  return value.greaterThan(balance) ? balance : value;
}

export const isZero = (v: Money) => v.isZero();
export const isPositive = (v: Money) => v.greaterThan(0);

/** Round to 2 dp (money is stored Decimal(10,2); guards against stray precision). */
export function round2(v: Money): Money {
  return v.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
}

/** Display as "Rs. 12,500" or "Rs. 12,500.50" (2 dp only when non-zero cents). */
export function formatPKR(v: Prisma.Decimal | number | string): string {
  const d = round2(money(v));
  const negative = d.isNegative();
  const abs = d.abs();
  const [intPart, decPart] = abs.toFixed(2).split('.');
  const withSep = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const cents = decPart === '00' ? '' : `.${decPart}`;
  return `${negative ? '-' : ''}Rs. ${withSep}${cents}`;
}

/** Serialize a Decimal for JSON responses as a plain 2dp string (stable for the client). */
export const toMoneyString = (v: Prisma.Decimal | number | string | null | undefined): string =>
  round2(money(v)).toFixed(2);
