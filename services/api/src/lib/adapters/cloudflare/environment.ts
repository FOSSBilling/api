import { IEnvironment } from "../../interfaces";

export class CloudflareEnvironmentAdapter implements IEnvironment {
  constructor(private env: Record<string, unknown>) {}

  get(key: string): string | undefined {
    const value = this.env[key];
    return typeof value === "string" ? value : undefined;
  }
}
