import { handlePackageProcessing } from "../../src/handler";

export default (request: Request) =>
  handlePackageProcessing(request, (name) => process.env[name]);
