import { IEnvironment } from "../../interfaces";

export class NodeEnvironmentAdapter implements IEnvironment {
  get(key: string): string | undefined {
    return process.env[key];
  }
}
