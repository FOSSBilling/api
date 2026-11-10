export class PackageError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: 403 | 404 | 409 | 413 | 422 | 429 | 503
  ) {
    super(message);
  }
}
