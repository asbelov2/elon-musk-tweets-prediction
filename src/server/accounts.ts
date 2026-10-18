import { AppError } from './errors.js';
export const DEFAULT_HANDLE = 'elonmusk';
export function cleanHandle(value: string): string {
  const handle = value.trim().replace(/^@/, '');
  if (!/^[a-zA-Z0-9_]{1,15}$/.test(handle))
    throw new AppError(
      'Укажите имя аккаунта X: до 15 латинских букв, цифр или знаков подчёркивания.',
    );
  return handle;
}
export function accountKey(value: string): string {
  return cleanHandle(value).toLowerCase();
}
