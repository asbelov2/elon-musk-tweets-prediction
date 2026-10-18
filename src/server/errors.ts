export class AppError extends Error {
  constructor(
    message: string,
    public readonly statusCode = 400,
  ) {
    super(message);
    this.name = 'AppError';
  }
}
export class ProviderError extends AppError {}
export const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : 'Неизвестная ошибка';
