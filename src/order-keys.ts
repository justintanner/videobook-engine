/**
 * Fractional/lexicographic order keys for engine-maintained orderings
 * (timeline slots, timeline audio, sequence tracks).
 *
 * Format (compatible with the "fractional-indexing" key scheme):
 * - A key is an integer part followed by an optional fractional part.
 * - Digits are base-62: 0-9 A-Z a-z, in ASCII (byte) order, so keys sort
 *   correctly under SQLite's default BINARY text collation.
 * - The integer part's first character encodes its length: 'a'..'z' for
 *   non-negative integers (2..27 chars), 'A'..'Z' for negative integers
 *   (2..27 chars). Zero is "a0".
 * - The fractional part refines the order within one integer bucket.
 *
 * Keys are never unique by construction: two forks can independently mint
 * the same key. Readers always break ties by the row's stable UUID.
 */
const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const INTEGER_ZERO = "a0";
const LAST_DIGIT = DIGITS[DIGITS.length - 1]!;
const MID_DIGIT = DIGITS[DIGITS.length >> 1]!;

function integerLength(head: string): number {
  const code = head.charCodeAt(0);
  if (head >= "a" && head <= "z") return code - 97 + 2;
  if (head >= "A" && head <= "Z") return 90 - code + 2;
  throw new Error(`Invalid order key: unexpected head character: ${head}`);
}

function integerPart(key: string): string {
  if (key.length === 0) throw new Error("Invalid order key: empty key");
  return key.slice(0, integerLength(key[0]!));
}

export function isOrderKey(key: string): boolean {
  if (!/^[A-Za-z][0-9A-Za-z]*$/.test(key)) return false;
  try {
    const integer = integerPart(key);
    if (integer.length !== integerLength(integer[0]!)) return false;
    return !key.slice(integer.length).endsWith(DIGITS[0]!);
  } catch {
    return false;
  }
}

export function assertOrderKey(key: string, label: string): void {
  if (!isOrderKey(key)) throw new Error(`${label} is not a valid order key: ${key}`);
}

function incrementInteger(integer: string): string | null {
  const head = integer[0]!;
  const digits = integer.slice(1).split("");
  let carry = true;
  for (let index = digits.length - 1; carry && index >= 0; index -= 1) {
    const value = DIGITS.indexOf(digits[index]!) + 1;
    if (value === DIGITS.length) {
      digits[index] = DIGITS[0]!;
    } else {
      digits[index] = DIGITS[value]!;
      carry = false;
    }
  }
  if (!carry) return head + digits.join("");
  if (head === "Z") return INTEGER_ZERO;
  if (head === "z") return null;
  const next = String.fromCharCode(head.charCodeAt(0) + 1);
  return next + DIGITS[0]!.repeat(integerLength(next) - 1);
}

function decrementInteger(integer: string): string | null {
  const head = integer[0]!;
  const digits = integer.slice(1).split("");
  let borrow = true;
  for (let index = digits.length - 1; borrow && index >= 0; index -= 1) {
    const value = DIGITS.indexOf(digits[index]!) - 1;
    if (value === -1) {
      digits[index] = LAST_DIGIT;
    } else {
      digits[index] = DIGITS[value]!;
      borrow = false;
    }
  }
  if (!borrow) return head + digits.join("");
  if (head === "a") return `Z${LAST_DIGIT}`;
  if (head === "A") return null;
  const previous = String.fromCharCode(head.charCodeAt(0) - 1);
  return previous + LAST_DIGIT.repeat(integerLength(previous) - 1);
}

/**
 * Fractional midpoint strictly between `a` and `b` (both digit strings,
 * `b === null` means "no upper bound"). Precondition: a < b.
 */
function midpoint(a: string, b: string | null): string {
  if (b === null) {
    if (a === "") return MID_DIGIT;
    const head = a[0]!;
    if (head !== LAST_DIGIT) return DIGITS[DIGITS.indexOf(head) + 1]!;
    return head + midpoint(a.slice(1), null);
  }
  const digitA = a === "" ? 0 : DIGITS.indexOf(a[0]!);
  const digitB = b === "" ? 0 : DIGITS.indexOf(b[0]!);
  if (digitB - digitA > 1) return DIGITS[(digitA + digitB + 1) >> 1]!;
  if (digitB - digitA === 1) {
    return DIGITS[digitA]! + midpoint(a.slice(1), null);
  }
  if (b === "") throw new Error("No room between order keys");
  return DIGITS[digitA]! + midpoint(a.slice(1), b.slice(1));
}

/**
 * Returns a key that sorts strictly between `before` and `after`
 * (either side may be null for an open end).
 */
export function orderKeyBetween(
  before: string | null,
  after: string | null,
): string {
  if (before !== null) assertOrderKey(before, "Before order key");
  if (after !== null) assertOrderKey(after, "After order key");
  if (before !== null && after !== null && before >= after) {
    throw new Error(`Order keys out of order: ${before} !< ${after}`);
  }
  if (before === null) {
    if (after === null) return INTEGER_ZERO;
    const integer = integerPart(after);
    const decremented = decrementInteger(integer);
    if (decremented !== null) return decremented;
    return integer + midpoint("", after.slice(integer.length));
  }
  const beforeInteger = integerPart(before);
  const beforeFraction = before.slice(beforeInteger.length);
  if (after === null) {
    const incremented = incrementInteger(beforeInteger);
    if (incremented !== null) return incremented;
    return beforeInteger + midpoint(beforeFraction, null);
  }
  const afterInteger = integerPart(after);
  if (beforeInteger === afterInteger) {
    return beforeInteger + midpoint(beforeFraction, after.slice(afterInteger.length));
  }
  const incremented = incrementInteger(beforeInteger);
  if (incremented !== null && incremented < after) return incremented;
  return beforeInteger + midpoint(beforeFraction, null);
}

/** Key sorting immediately after `key` (or the first key when null). */
export function orderKeyAfter(key: string | null): string {
  return orderKeyBetween(key, null);
}

/** Dense initial keys for a freshly created ordered list. */
export function initialOrderKeys(count: number): string[] {
  const keys: string[] = [];
  let previous: string | null = null;
  for (let index = 0; index < count; index += 1) {
    const key = orderKeyAfter(previous);
    keys.push(key);
    previous = key;
  }
  return keys;
}

/**
 * Reconciles an ordered list of row identities with their stored keys,
 * reusing existing keys for every row whose relative order is unchanged
 * (a longest increasing subsequence) and minting midpoint keys only for
 * new or genuinely reordered rows. Untouched rows keep their stored key,
 * so merges with forks that appended elsewhere stay row-local.
 *
 * Returns the key for every desired id, in desired order.
 */
export function reconcileOrderKeys<I>(
  desired: readonly I[],
  existing: ReadonlyMap<I, string>,
): Map<I, string> {
  const survivors = desired.filter((id) => existing.has(id));
  const byKey = [...survivors].sort((left, right) => {
    const leftKey = existing.get(left)!;
    const rightKey = existing.get(right)!;
    return leftKey === rightKey ? 0 : leftKey < rightKey ? -1 : 1;
  });
  // Rows that share a stored key (possible after a merge) form one group;
  // the kept set is a longest strictly increasing subsequence of group
  // ranks, so kept keys always leave room for midpoint insertion.
  const distinctKeys = [...new Set(byKey.map((id) => existing.get(id)!))];
  const groupRank = new Map(distinctKeys.map((key, rank) => [key, rank]));
  const keptIndices = longestIncreasingSubsequence(
    survivors.map((id) => groupRank.get(existing.get(id)!)!),
  );
  const kept = new Set<I>();
  for (const index of keptIndices) kept.add(survivors[index]!);
  const keptInOrder = byKey.filter((id) => kept.has(id));
  const result = new Map<I, string>();
  let keptIndex = 0;
  let previous: string | null = null;
  for (const id of desired) {
    if (kept.has(id)) {
      const key = existing.get(id)!;
      result.set(id, key);
      previous = key;
      keptIndex += 1;
    } else {
      // Duplicate stored keys (possible after a merge) can leave no room
      // before the next kept neighbor; skip ahead to the first kept key
      // that is strictly greater than the previously assigned key.
      let next: string | null = null;
      for (let index = keptIndex; index < keptInOrder.length; index += 1) {
        const candidate = existing.get(keptInOrder[index]!)!;
        if (previous === null || candidate > previous) {
          next = candidate;
          break;
        }
      }
      const key = orderKeyBetween(previous, next);
      result.set(id, key);
      previous = key;
    }
  }
  return result;
}

/** Indices of a longest strictly increasing subsequence of `sequence`. */
function longestIncreasingSubsequence(sequence: readonly number[]): Set<number> {
  const tails: number[] = [];
  const previousIndex: number[] = Array.from({ length: sequence.length }, () => -1);
  for (let index = 0; index < sequence.length; index += 1) {
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (sequence[tails[middle]!]! < sequence[index]!) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    if (low > 0) previousIndex[index] = tails[low - 1]!;
    if (low === tails.length) {
      tails.push(index);
    } else {
      tails[low] = index;
    }
  }
  const result = new Set<number>();
  let index = tails.length > 0 ? tails[tails.length - 1]! : -1;
  while (index >= 0) {
    result.add(index);
    index = previousIndex[index]!;
  }
  return result;
}
