export interface DatabaseError {
  message: string;
  code?: string;
}

export type DatabaseResult<T> =
  { data: T; error: null } | { data: null; error: DatabaseError };

export interface CacheOptions {
  expirationTtl?: number;
  expiration?: number;
}

export interface ICache {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: CacheOptions): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface IEnvironment {
  get(key: string): string | undefined;
}

export interface IPlatformBindings {
  caches: Record<string, ICache>;
  environment: IEnvironment;
}
