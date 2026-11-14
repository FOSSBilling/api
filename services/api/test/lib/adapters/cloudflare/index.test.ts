import { afterEach, expect, it, vi } from "vitest";
import { createCloudflareBindings } from "../../../../src/lib/adapters/cloudflare/index";

afterEach(() => vi.unstubAllGlobals());

it("uses the service binding for production and HTTP for the named staging Preview", async () => {
  const bindingFetch = vi.fn(
    async (_request: Request) => new Response(null, { status: 204 })
  );
  const httpFetch = vi.fn(
    async (_request: Request) => new Response(null, { status: 204 })
  );
  vi.stubGlobal("fetch", httpFetch);
  const request = () =>
    new Request("https://extensions.fossbilling.org/api/revalidate", {
      method: "POST",
      headers: {
        authorization: "Bearer staging-secret",
        "content-type": "application/json"
      },
      body: JSON.stringify({ tags: ["extensions"] })
    });
  const production = createCloudflareBindings({
    EXTENSIONS_FRONTEND: { fetch: bindingFetch }
  } as unknown as CloudflareBindings);
  await production.services!.EXTENSIONS_FRONTEND(request());
  expect(bindingFetch).toHaveBeenCalledOnce();
  expect(httpFetch).not.toHaveBeenCalled();

  const staging = createCloudflareBindings({
    EXTENSIONS_FRONTEND_URL:
      "https://staging-extensions.fossbilling.workers.dev"
  } as unknown as CloudflareBindings);
  await staging.services!.EXTENSIONS_FRONTEND(request());
  expect(httpFetch).toHaveBeenCalledOnce();
  const forwarded = httpFetch.mock.calls[0][0] as Request;
  expect(forwarded.url).toBe(
    "https://staging-extensions.fossbilling.workers.dev/api/revalidate"
  );
  expect(forwarded.method).toBe("POST");
  expect(forwarded.headers.get("authorization")).toBe("Bearer staging-secret");
  expect(await forwarded.json()).toEqual({ tags: ["extensions"] });
  expect(bindingFetch).toHaveBeenCalledOnce();
});
