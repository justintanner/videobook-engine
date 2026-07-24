import { v7 as uuidv7 } from "uuid";

const UUID_V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function newUuidV7(): string {
  return uuidv7();
}

export function isUuidV7(value: string): boolean {
  return UUID_V7.test(value);
}

export function assertUuidV7(value: string, label = "ID"): void {
  if (!isUuidV7(value)) {
    throw new Error(`${label} must be a UUIDv7`);
  }
}
